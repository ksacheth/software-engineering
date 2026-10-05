import { Worker, type Job } from "bullmq";
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
    throw new Error(`Malformed report job ${job.id}`);
  }
  try {
    return await generateReport(job.data.reportId);
  } catch (error) {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      await markReportFailed(job.data.reportId);
    }
    throw error;
  }
}

export function startReportWorker(): Worker<ReportJobPayload> {
  const worker = new Worker<ReportJobPayload>(REPORT_QUEUE_NAME, processReportJob, {
    connection: redisConnectionOptions(),
    concurrency: config.reports.workerConcurrency,
  });
  worker.on("failed", (job, error) => {
    console.error("[reports] generation failed", job?.data.reportId, error);
  });
  worker.on("error", (error) => {
    console.error("[reports] worker error", error.message);
  });
  return worker;
}
