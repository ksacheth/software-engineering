/**
 * Drain the transactional email outbox.
 *
 * SRS F.1 §3.2.3 requires that a failed email be "queued for retry". This is
 * that retry, run on demand or from cron:
 *
 *   bun run --filter @wvs/api email:retry
 *
 * Exit code is non-zero when anything is left in DEAD_LETTER, so a cron job or
 * CI step fails loudly instead of silently accumulating lost messages. Counts
 * already queued are reported first, so a no-op run is visibly a no-op.
 */
import { prisma } from "@wvs/database";
import { config } from "../config/env";
import { retryPendingEmails, type RetrySummary } from "../lib/email";
import { outboxCounts } from "../lib/email-outbox";

const BATCH_SIZE = 50;

/** Bounds a run so a persistently due row cannot hold the process open. */
const MAX_PASSES = 20;

async function main(): Promise<void> {
  const before = await outboxCounts();
  console.log("[email:retry] relay:", {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
  });
  console.log("[email:retry] queue before:", before);

  // Drain until the queue stops yielding, rather than one batch and out.
  // A single pass leaves anything past the batch size queued while the process
  // still exits 0, so a cron run reports success with deliverable mail sitting
  // untouched until the next one. The pass bound stops a row that keeps coming
  // back due from spinning here forever; the backoff in email-outbox means a
  // failing row is not due again within a run.
  const summary: RetrySummary = {
    attempted: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
  };

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const batch = await retryPendingEmails(BATCH_SIZE);
    summary.attempted += batch.attempted;
    summary.sent += batch.sent;
    summary.failed += batch.failed;
    summary.deadLettered += batch.deadLettered;

    if (batch.attempted < BATCH_SIZE) break;

    if (pass === MAX_PASSES - 1) {
      console.warn(
        `[email:retry] stopped after ${MAX_PASSES} passes with messages still due; another run will continue`,
      );
    }
  }

  console.log("[email:retry] run:", summary);

  const after = await outboxCounts();
  console.log("[email:retry] queue after:", after);

  const dead = after.DEAD_LETTER ?? 0;
  if (dead > 0) {
    console.error(
      `[email:retry] ${dead} message(s) are DEAD_LETTER and need operator attention`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[email:retry] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The Prisma client holds a connection pool open; without this the process
    // would hang instead of exiting.
    await prisma.$disconnect();
  });
