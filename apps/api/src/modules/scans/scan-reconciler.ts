import { prisma } from "@wvs/database";
import { isScannable } from "@wvs/scope-rules";
import { writeSystemAudit } from "../../common/audit";
import { enqueueScan, hasScanJob } from "./scan-queue";

/**
 * Reclaim scans the queue lost (#6).
 *
 * `startScan` writes the QUEUED row and hands the job to BullMQ as two separate
 * steps against two separate systems. When the second fails the row survives
 * and the job does not, so nothing will ever run that scan. QUEUED occupies
 * quota, so the row goes on holding an organisation slot and its target's
 * only active-scan slot until a human finds it and cancels it: two of them and
 * the organisation cannot start anything at all.
 *
 * This is the half of #6 that can be built today. A scan whose worker died
 * mid-crawl is the same stuck row from the other direction, but detecting it
 * needs a liveness signal the orchestrator does not yet emit, so that case
 * stays open and is specified alongside the worker.
 */

/**
 * How long a row must have been queued before it is considered lost.
 *
 * `startScan` writes the row and enqueues microseconds later, and a reconciler
 * running in that gap would see a scan that looks abandoned and is merely
 * young. The window is far wider than that gap costs nothing: a scan delayed by
 * one sweep is invisible next to one stuck forever.
 */
const LOST_AFTER_MS = 2 * 60_000;

/**
 * Past this, a lost scan is ended rather than started.
 *
 * Re-enqueueing is only right while the request still reflects what the user
 * wants. A scan queued days ago would begin crawling a target long after the
 * person who asked stopped expecting it, against a scope snapshot taken when
 * they did, so at some point the honest answer is that this scan is not going
 * to run. It also bounds the retrying: a row that cannot be enqueued is not
 * picked up forever.
 */
const ABANDONED_AFTER_MS = 24 * 60 * 60_000;

export interface ReconcileSummary {
  /** Lost rows examined. Healthy queued scans are not counted. */
  examined: number;
  requeued: number;
  /** Ended because the target may no longer be scanned. */
  refused: number;
  /** Ended because the request is too old to act on. */
  abandoned: number;
}

type EndReason = "TARGET_NOT_SCANNABLE" | "ABANDONED";

const END_DETAIL: Record<EndReason, string> = {
  TARGET_NOT_SCANNABLE:
    "The target could no longer be scanned when the queue was reconciled.",
  ABANDONED:
    "The scan was never delivered to the scan engine and was too old to start.",
};

/**
 * End a scan that is never going to run, releasing the quota it holds.
 *
 * FAILED rather than CANCELLED: nobody cancelled this. The status is guarded on
 * QUEUED so a scan that started between the read and the write is left alone.
 */
async function endScan(
  scan: { id: string; organizationId: string; targetId: string },
  reason: EndReason,
): Promise<boolean> {
  const ended = await prisma.scanJob.updateMany({
    where: { id: scan.id, status: "QUEUED" },
    data: {
      status: "FAILED",
      failureReason: END_DETAIL[reason],
      completedAt: new Date(),
    },
  });
  if (ended.count === 0) return false;

  await writeSystemAudit(scan.organizationId, {
    action: "SCAN_FAILED",
    resourceType: "scan",
    resourceId: scan.id,
    metadata: { reason, targetId: scan.targetId, by: "reconciler" },
  });
  return true;
}

/** Whether the target may still be scanned right now. */
async function isStillScannable(targetId: string): Promise<boolean> {
  const target = await prisma.target.findUnique({
    where: { id: targetId },
    select: {
      isArchived: true,
      authorisationAck: true,
      verificationStatus: true,
      verificationExpiresAt: true,
      verifiedIpRanges: true,
    },
  });
  return target !== null && isScannable(target).scannable;
}

/** What a sweep did with one lost scan. */
type Disposition = "requeued" | "refused" | "abandoned" | "unchanged";

/**
 * Decide the fate of a single scan whose job is gone.
 *
 * Ordered by how little the outcome depends on: age is knowable from the row,
 * authorisation needs the target, and delivery needs the queue. Any step that
 * cannot complete leaves the row as it found it, so the next sweep retries.
 */
async function reconcileOne(
  scan: { id: string; organizationId: string; targetId: string; queuedAt: Date },
  now: number,
): Promise<Disposition> {
  if (now - scan.queuedAt.getTime() > ABANDONED_AFTER_MS) {
    return (await endScan(scan, "ABANDONED")) ? "abandoned" : "unchanged";
  }

  // C.2 is re-answered before the scan is handed back to the engine. The
  // authorisation was checked when the scan was requested, and a target can be
  // archived or its verification lapse while the row sits here; starting it now
  // on the strength of that older check is exactly the bypass C.2 forbids.
  if (!(await isStillScannable(scan.targetId))) {
    return (await endScan(scan, "TARGET_NOT_SCANNABLE"))
      ? "refused"
      : "unchanged";
  }

  try {
    await enqueueScan(scan.id, scan.organizationId);
  } catch (error) {
    // Left QUEUED on purpose. The queue is still down, and the next sweep is
    // the retry; ending the scan here would throw away a recoverable request
    // over a transient outage.
    console.error("[scan-reconciler] re-enqueue failed", scan.id, error);
    return "unchanged";
  }

  // Audited as a queue event because that is what it is: the scan was queued,
  // and this is the delivery that should have happened when the user asked.
  // The metadata distinguishes it from the original.
  await writeSystemAudit(scan.organizationId, {
    action: "SCAN_QUEUED",
    resourceType: "scan",
    resourceId: scan.id,
    metadata: { targetId: scan.targetId, by: "reconciler" },
  });
  return "requeued";
}

/**
 * Sweep once.
 *
 * Safe to run concurrently with itself and with the API: every write is guarded
 * on the status that was read, and the enqueue is keyed by scan id, so a double
 * sweep cannot produce two jobs for one scan.
 */
export async function reconcileScans(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    examined: 0,
    requeued: 0,
    refused: 0,
    abandoned: 0,
  };

  const now = Date.now();
  const candidates = await prisma.scanJob.findMany({
    where: {
      status: "QUEUED",
      queuedAt: { lt: new Date(now - LOST_AFTER_MS) },
    },
    select: {
      id: true,
      organizationId: true,
      targetId: true,
      queuedAt: true,
    },
    orderBy: { queuedAt: "asc" },
  });

  for (const scan of candidates) {
    // A job still in the queue means the scan is waiting on a busy or stopped
    // fleet, which is a capacity problem rather than a lost row. Touching it
    // would turn a slow day into failed work.
    if (await hasScanJob(scan.id)) continue;

    summary.examined += 1;
    const disposition = await reconcileOne(scan, now);
    if (disposition !== "unchanged") summary[disposition] += 1;
  }

  return summary;
}
