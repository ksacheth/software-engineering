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
import { retryPendingEmails } from "../lib/email";
import { outboxCounts } from "../lib/email-outbox";

async function main(): Promise<void> {
  const before = await outboxCounts();
  console.log("[email:retry] relay:", {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
  });
  console.log("[email:retry] queue before:", before);

  const summary = await retryPendingEmails(50);
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
