import { Queue } from "bullmq";
import { SCAN_QUEUE_NAME, scanJobQueueId, type ScanJobPayload } from "@wvs/shared";
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
      // retry would crawl a target twice. Resume is the orchestrator's job and
      // restarts from the checkpoint.
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

/** Test teardown helper: closes the shared connection so the process can exit. */
export async function closeScanQueue(): Promise<void> {
  if (!queue) return;
  const closing = queue;
  queue = null;
  await closing.close();
}
