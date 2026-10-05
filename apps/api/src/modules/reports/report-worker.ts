import { UnrecoverableError, Worker, type Job } from "bullmq";
import { isReportJobPayload, REPORT_QUEUE_NAME, type ReportJobPayload } from "@wvs/shared";
import { config, redisConnectionOptions } from "../../config/env";
import { generateReport, markReportFailed } from "./report-generator";

/**
 * F.7 report worker (DC-4).
 *
 * Runs as its own process (`bun run reports:worker`) or, for a single-instance
 * deployment, inside the API (REPORT_WORKER_IN_API). BullMQ hands each job to
 * one consumer, so either way a report is generated once.
 */

async function processReportJob(job: Job<ReportJobPayload>): Promise<string> {
  if (!isReportJobPayload(job.data)) {
    // Not a job this worker can act on; retrying will not change that.
    throw new UnrecoverableError(`Malformed report job ${job.id}`);
  }
  return generateReport(job.data.reportId);
}

/** The parts of a failed job the handler reads, so it can be tested without Redis. */
export type FailedReportJob = Pick<Job<unknown>, "data" | "attemptsMade" | "opts">;

/**
 * Mark a report FAILED once the queue has given up on it.
 *
 * This runs from the worker's `failed` event rather than the processor,
 * because the event also fires for a job that stalled: a worker that died
 * mid-generation never returns to the processor, and a report whose last
 * attempt stalled would otherwise read GENERATING forever. BullMQ has counted
 * the attempt by the time the event fires.
 */
export async function handleFailedReportJob(
  job: FailedReportJob | undefined,
  error: Error,
): Promise<void> {
  if (!job || !isReportJobPayload(job.data)) return;
  const final =
    error instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!final) return;
  try {
    await markReportFailed(job.data.reportId);
  } catch (markError) {
    // Logged separately, so the generation error above is never replaced.
    console.error("[reports] could not mark report failed", job.data.reportId, markError);
  }
}

export function startReportWorker(): Worker<ReportJobPayload> {
  const worker = new Worker<ReportJobPayload>(REPORT_QUEUE_NAME, processReportJob, {
    connection: redisConnectionOptions(),
    concurrency: config.reports.workerConcurrency,
  });
  worker.on("failed", (job, error) => {
    console.error("[reports] generation failed", job?.data.reportId, error);
    void handleFailedReportJob(job, error);
  });
  worker.on("error", (error) => {
    console.error("[reports] worker error", error.message);
  });
  return worker;
}
