import { Queue } from "bullmq";
import {
  SCAN_QUEUE_NAME,
  scanJobQueueId,
  type ScanJobPayload,
} from "@wvs/shared";
import { redisConnectionOptions } from "../../config/env";

/**
 * F.3 enqueue (DC-4: scans are queued through BullMQ backed by Redis).
 *
 * The payload is `{ scanJobId, organizationId, attempt }` and nothing else;
 * the row is the single source of truth for the configuration (ADR-0006).
 */

let queue: Queue<ScanJobPayload> | null = null;

function scanQueue(): Queue<ScanJobPayload> {
  queue ??= new Queue<ScanJobPayload>(SCAN_QUEUE_NAME, {
    connection: redisConnectionOptions(),
  });
  return queue;
}

export async function enqueueScan(
  scanJobId: string,
  organizationId: string,
  attempt = 1,
): Promise<void> {
  await scanQueue().add(
    "scan",
    { scanJobId, organizationId, attempt },
    {
      // The job is keyed by scan id so a double submit cannot create two jobs
      // for one scan.
      jobId: scanJobQueueId(scanJobId),
      // No queue-level retries: a scan is long-running and stateful, and a blind
      // retry would crawl a target twice. A resume is a fresh enqueue carrying
      // the next attempt number, not a retry of this delivery: only the API
      // knows the user asked to resume, and a paused worker has exited by then
      // (ADR-0007).
      attempts: 1,
      // Completed jobs are removed rather than retained, because a retained job
      // holds its id and would silently absorb a later enqueue of the same scan.
      // Failures are kept briefly for diagnosis; a failed job still holds the id,
      // so a re-enqueue of a genuinely failed scan must wait for that to expire.
      removeOnComplete: true,
      removeOnFail: { age: 3_600 },
    },
  );
}

/**
 * Whether the queue still holds a job for this scan.
 *
 * Used by the reconciler (#6) to tell a scan waiting on a busy fleet from one
 * whose job was never created. Completed jobs are removed, so a `QUEUED` row
 * with no job is a scan nothing will ever run.
 */
export async function hasScanJob(scanJobId: string): Promise<boolean> {
  const job = await scanQueue().getJob(scanJobQueueId(scanJobId));
  return job !== undefined;
}

/**
 * Drop a scan's job if the queue still holds it (ADR-0007).
 *
 * Cancelling a scan that never started must take the job with it, or it sits in
 * Redis and runs later against a scan the user was told is finished.
 *
 * Returns whether a job was removed. A job a worker has already claimed cannot
 * be removed, and that is not a failure: the row now reads CANCELLED and the
 * orchestrator stops at its next checkpoint, which is the mechanism ADR-0007
 * relies on for a running scan anyway.
 */
export async function removeScanJob(scanJobId: string): Promise<boolean> {
  try {
    const removed = await scanQueue().remove(scanJobQueueId(scanJobId));
    return removed > 0;
  } catch (error) {
    console.error("[scans] could not remove queued job", scanJobId, error);
    return false;
  }
}

/** Test teardown helper: closes the shared connection so the process can exit. */
export async function closeScanQueue(): Promise<void> {
  if (!queue) return;
  const closing = queue;
  queue = null;
  await closing.close();
}
