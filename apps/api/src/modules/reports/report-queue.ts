import { Queue } from "bullmq";
import { REPORT_QUEUE_NAME, type ReportJobPayload } from "@wvs/shared";
import { redisConnectionOptions } from "../../config/env";

/**
 * F.7 enqueue (DC-4: report generation is queued through BullMQ).
 *
 * The payload is the report id alone; the row holds the template, format and
 * filters, as the scan row does for a scan (ADR-0006).
 */

let queue: Queue<ReportJobPayload> | null = null;

function reportQueue(): Queue<ReportJobPayload> {
  queue ??= new Queue<ReportJobPayload>(REPORT_QUEUE_NAME, {
    connection: redisConnectionOptions(),
  });
  return queue;
}

export async function enqueueReport(reportId: string): Promise<void> {
  await reportQueue().add(
    "report",
    { reportId },
    {
      // Keyed by report id, so a double submit cannot generate a report twice.
      jobId: reportId,
      // Rendering is deterministic, so a retry is only worth it for a
      // transient failure such as the database dropping a connection.
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 24 * 3_600 },
    },
  );
}

/** Test teardown helper: closes the shared connection so the process can exit. */
export async function closeReportQueue(): Promise<void> {
  if (!queue) return;
  const closing = queue;
  queue = null;
  await closing.close();
}
