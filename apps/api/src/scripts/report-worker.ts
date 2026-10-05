/**
 * F.7 report worker process (DC-4: report generation is queued, never run in a
 * request handler).
 *
 *   bun run --filter @wvs/api reports:worker
 *
 * Scales by running more of these; BullMQ gives each job to one of them.
 */
import { prisma } from "@wvs/database";
import { startReportWorker } from "../modules/reports/report-worker";

const worker = startReportWorker();
console.log("[reports:worker] waiting for report jobs");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[reports:worker] ${signal} received, finishing current jobs`);
    void worker
      .close()
      .then(() => prisma.$disconnect())
      .finally(() => process.exit(0));
  });
}
