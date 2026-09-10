/**
 * F.3 queue contract between the API and the orchestrator (ADR-0006).
 *
 * The payload is deliberately thin. `ScanJob` already stores the profile, all
 * five limits and the scope snapshot that F.2/F.3 require for reproducibility,
 * so duplicating them here would create a second source of truth that can drift
 * from the row the dashboard displays. The cost is one database read in the
 * worker.
 */

/**
 * BullMQ queue name. Exported so the orchestrator enqueues nothing else by
 * accident. No colon: BullMQ uses `:` as its Redis key separator.
 */
export const SCAN_QUEUE_NAME = 'wvs-scans';

export interface ScanJobPayload {
  scanJobId: string;
  /** Lets the worker label its logs before it reads the row. */
  organizationId: string;
  /**
   * 1-based attempt number, so a resumed scan continues from its checkpoint
   * rather than restarting.
   *
   * The API always enqueues 1: only the orchestrator knows that a resume
   * happened, so only it increments this. BullMQ's own `attemptsMade` counts
   * transport retries of one delivery and is a different thing.
   */
  attempt: number;
}

export function isScanJobPayload(value: unknown): value is ScanJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.scanJobId === 'string' &&
    payload.scanJobId.length > 0 &&
    typeof payload.organizationId === 'string' &&
    payload.organizationId.length > 0 &&
    typeof payload.attempt === 'number' &&
    Number.isInteger(payload.attempt) &&
    payload.attempt >= 1
  );
}

/**
 * BullMQ job id, set to the scan id so enqueueing is idempotent: a double
 * submit cannot create two jobs for one scan.
 */
export function scanJobQueueId(scanJobId: string): string {
  return scanJobId;
}
