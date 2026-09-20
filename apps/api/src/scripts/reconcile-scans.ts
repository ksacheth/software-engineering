/**
 * Reclaim scan capacity held by rows the queue lost (#6).
 *
 * Run on demand or from cron, like `email:retry`:
 *
 *   bun run --filter @wvs/api scans:reconcile
 *
 * A scan whose enqueue failed leaves a QUEUED row with no job behind it, and
 * QUEUED occupies quota, so those rows accumulate against an organisation's
 * concurrent limit until someone cancels them by hand. This sweep re-delivers
 * the ones that can still run and ends the ones that cannot.
 *
 * Exit code is non-zero when a scan had to be ended, because that is a scan the
 * user asked for and will not get, and it should be visible in a cron log
 * rather than buried in a summary nobody reads. Re-queued scans are the happy
 * path and exit zero.
 */
import { prisma } from "@wvs/database";
import { reconcileScans } from "../modules/scans/scan-reconciler";
import { closeScanQueue } from "../modules/scans/scan-queue";

async function main(): Promise<void> {
  const summary = await reconcileScans();
  console.log("[scans:reconcile] run:", summary);

  if (summary.requeued > 0) {
    console.log(
      `[scans:reconcile] re-delivered ${summary.requeued} scan(s) whose job was lost`,
    );
  }

  const ended = summary.refused + summary.abandoned;
  if (ended > 0) {
    console.error(
      `[scans:reconcile] ended ${ended} scan(s) that could not run ` +
        `(${summary.refused} no longer scannable, ${summary.abandoned} too old); ` +
        `their quota slots are released`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[scans:reconcile] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Both hold connections open; without this the process hangs instead of
    // exiting, which for a cron entry point means a pile of stuck runs.
    await closeScanQueue();
    await prisma.$disconnect();
  });
