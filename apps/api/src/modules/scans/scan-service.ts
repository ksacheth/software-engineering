import { Prisma, prisma, type ScanJob } from "@wvs/database";
import {
  canCancel,
  canPause,
  canResume,
  type ScanConfiguration,
  type ScanProfile,
} from "@wvs/shared";
import { isScannable, type NotScannableReason } from "@wvs/scope-rules";
import type { AuditAction } from "@wvs/database";
import type { AuthContext } from "../../common/session";
import { writeAudit } from "../../common/audit";
import { reserveScan } from "./scan-reservation";
import { enqueueScan, removeScanJob } from "./scan-queue";
import {
  findScanForOrg,
  toScanDto,
  type ScanDto,
  type ScanWithRelations,
} from "./scan-queries";

/**
 * F.3 scan trigger and control.
 *
 * The API writes the audit record for every state change it performs and the
 * orchestrator writes the ones it performs, so the append-only audit log has
 * one record per event rather than a duplicate from each half.
 */

export type ScanRefusal =
  | { kind: "TARGET_NOT_FOUND" }
  | { kind: "TARGET_NOT_SCANNABLE"; reason: NotScannableReason }
  | { kind: "ORG_CONCURRENCY"; limit: number }
  | { kind: "TARGET_ALREADY_ACTIVE"; scanJobId: string }
  | { kind: "QUEUE_UNAVAILABLE" }
  | { kind: "SCAN_NOT_FOUND" }
  | {
      kind: "ILLEGAL_TRANSITION";
      action: ScanAction;
      status: string;
      detail: string;
    };

export interface StartScanInput {
  targetId: string;
  profile: ScanProfile;
  configuration: ScanConfiguration;
}

export type StartScanResult =
  | { ok: true; scan: ScanDto }
  | { ok: false; refusal: ScanRefusal };

const NOT_SCANNABLE_DETAIL: Record<NotScannableReason, string> = {
  ARCHIVED: "This target is archived, so it cannot be scanned.",
  NOT_VERIFIED:
    "This target's ownership has not been verified. Verify it before scanning (C.2).",
  VERIFICATION_FAILED:
    "The last ownership verification attempt failed. Re-verify the target before scanning (C.2).",
  VERIFICATION_EXPIRED:
    "Ownership verification has expired. Re-verify the target before scanning (C.2).",
  NO_VERIFIED_ADDRESSES:
    "This target has an empty verified IP set, so scanning would bypass the Scope Guard (C.2).",
  AUTHORISATION_NOT_ACKNOWLEDGED:
    "The authorisation acknowledgement is missing, so scanning is not permitted.",
};

export function describeNotScannable(reason: NotScannableReason): string {
  return NOT_SCANNABLE_DETAIL[reason];
}

/**
 * Start a scan.
 *
 * The order matters: authorisation first (C.2 is never quietly bypassed), then
 * the quota transaction, then the enqueue. The audit record is written for the
 * state change the API actually made, which is the queued row, before the
 * enqueue - an audit gap and an unauditable extra state would both be worse
 * than the ordering.
 */
export async function startScan(
  ctx: AuthContext,
  input: StartScanInput,
): Promise<StartScanResult> {
  const target = await prisma.target.findFirst({
    where: { id: input.targetId, organizationId: ctx.organizationId },
  });
  if (!target) return { ok: false, refusal: { kind: "TARGET_NOT_FOUND" } };

  const verdict = isScannable(target);
  if (!verdict.scannable) {
    return {
      ok: false,
      refusal: { kind: "TARGET_NOT_SCANNABLE", reason: verdict.reason! },
    };
  }

  const reservation = await reserveScan({
    organizationId: ctx.organizationId,
    targetId: target.id,
    profile: input.profile,
    configuration: input.configuration,
    createdById: ctx.userId,
  });
  if (!reservation.ok) return { ok: false, refusal: reservation };

  await writeAudit(ctx, {
    action: "SCAN_QUEUED",
    resourceType: "scan",
    resourceId: reservation.scan.id,
    metadata: {
      targetId: target.id,
      origin: target.origin,
      profile: input.profile,
      configuration: input.configuration,
    },
  });

  try {
    await enqueueScan(reservation.scan.id, reservation.scan.organizationId);
  } catch (error) {
    console.error("[scans] enqueue failed", reservation.scan.id, error);
    // The row stays QUEUED. Writing a terminal state here would be a state
    // change outside the actions the API was assigned to audit, and SCAN_QUEUED
    // is already the record of what happened. A queued scan nothing picks up is
    // the stalled case: it holds its quota slot, stays visible, and the user can
    // cancel it.
    //
    // Reclaiming it is a reconciler this PR does not build, tracked in #6. Until
    // that exists the slot is held until someone cancels the row by hand, and
    // since QUEUED occupies quota, enough of these will lock an organisation out
    // of scanning.
    return { ok: false, refusal: { kind: "QUEUE_UNAVAILABLE" } };
  }

  // Re-read with its relations so the response carries the same shape the
  // reads return, including the attribution the client displays.
  const created = await findScanForOrg(ctx, reservation.scan.id);
  return { ok: true, scan: toScanDto(created ?? reservation.scan) };
}

export type ScanAction = "pause" | "resume" | "cancel";

const ACTION_AUDIT: Record<ScanAction, AuditAction> = {
  pause: "SCAN_PAUSED",
  resume: "SCAN_RESUMED",
  cancel: "SCAN_CANCELLED",
};

interface ActionPlan {
  allowed: boolean;
  detail: string;
  data: Partial<
    Pick<ScanJob, "status" | "startedAt" | "pausedAt" | "cancelledAt">
  >;
}

function planAction(action: ScanAction, scan: ScanJob): ActionPlan {
  const now = new Date();

  switch (action) {
    case "pause":
      return {
        allowed: canPause(scan.status),
        detail: `Only a running scan can be paused. This scan is ${scan.status}.`,
        data: { status: "PAUSED", pausedAt: now },
      };
    case "resume":
      return {
        allowed: canResume(scan.status),
        detail:
          scan.status === "QUEUED"
            ? "This scan has not started yet, so there is nothing to resume."
            : `Only a paused scan can be resumed. This scan is ${scan.status}.`,
        data: { status: "RUNNING", startedAt: scan.startedAt ?? now },
      };
    case "cancel":
      return {
        allowed: canCancel(scan.status),
        detail: `This scan has already finished (${scan.status}), so it cannot be cancelled.`,
        data: { status: "CANCELLED", cancelledAt: now },
      };
  }
}

export type ControlScanResult =
  | { ok: true; scan: ScanDto }
  | { ok: false; refusal: ScanRefusal };

type ControlOutcome =
  | { kind: "refused"; refusal: ScanRefusal }
  | { kind: "applied"; count: number; attempt: number };

/**
 * C.2 on the resume path.
 *
 * A scan can sit paused for days, and a target's authorisation can lapse while
 * it does: archived, re-verification failed, or the verification simply
 * expired. Resuming on the strength of the check made when the scan started
 * would carry on crawling a target that is no longer authorised, and C.2 says
 * there is no path that does that. So the question is re-asked here, not only
 * at start.
 *
 * Runs inside the caller's transaction, alongside the compare-and-set that
 * writes the status, so nothing can revoke the target between the two.
 */
async function resumeRefusal(
  tx: Prisma.TransactionClient,
  targetId: string,
): Promise<ScanRefusal | null> {
  const target = await tx.target.findUnique({
    where: { id: targetId },
    select: {
      isArchived: true,
      authorisationAck: true,
      verificationStatus: true,
      verificationExpiresAt: true,
      verifiedIpRanges: true,
    },
  });
  if (!target) return { kind: "TARGET_NOT_FOUND" };

  const verdict = isScannable(target);
  if (verdict.scannable) return null;
  return { kind: "TARGET_NOT_SCANNABLE", reason: verdict.reason! };
}

/**
 * Write the planned status change.
 *
 * The resume authorisation check shares this transaction with the
 * compare-and-set, so the target cannot be archived or its verification lapse
 * between being checked and the scan being marked RUNNING.
 */
async function applyControl(
  ctx: AuthContext,
  scan: ScanWithRelations,
  action: ScanAction,
  plan: ActionPlan,
): Promise<ControlOutcome> {
  return prisma.$transaction(async (tx): Promise<ControlOutcome> => {
    if (action === "resume") {
      const refusal = await resumeRefusal(tx, scan.targetId);
      if (refusal) return { kind: "refused", refusal };
    }

    const updated = await tx.scanJob.updateMany({
      where: {
        id: scan.id,
        organizationId: ctx.organizationId,
        status: scan.status,
      },
      // A resume is a new delivery, not a retry of the old one, so the attempt
      // advances with the status and in the same transaction: the number the
      // worker is handed has to be the number the row records.
      data:
        action === "resume"
          ? { ...plan.data, attempt: { increment: 1 } }
          : plan.data,
    });
    if (updated.count === 0) return { kind: "applied", count: 0, attempt: 0 };

    const row = await tx.scanJob.findUniqueOrThrow({
      where: { id: scan.id },
      select: { attempt: true },
    });
    return { kind: "applied", count: updated.count, attempt: row.attempt };
  });
}

/**
 * Hand the control to the queue (ADR-0007).
 *
 * The row is the signal a running scan obeys, but two controls have work the
 * queue has to be told about: a cancelled scan that never started still has a
 * job waiting, and a paused scan's worker has exited, so only a fresh enqueue
 * restarts it.
 *
 * Runs after the row is written, never before. If the queue write is lost the
 * row still says what the user asked for, which is recoverable; the reverse
 * would leave a scan nothing will run and nothing records as stopped.
 */
async function deliverControl(
  scan: ScanWithRelations,
  action: ScanAction,
  attempt: number,
): Promise<ScanRefusal | null> {
  if (action === "cancel") {
    await removeScanJob(scan.id);
    return null;
  }

  if (action !== "resume") return null;

  try {
    await enqueueScan(scan.id, scan.organizationId, attempt);
    return null;
  } catch (error) {
    console.error("[scans] resume enqueue failed", scan.id, error);

    // Put the scan back where the user left it. Unlike a failed start, which
    // has no earlier state to return to and so leaves the row QUEUED, a resume
    // does: PAUSED is exactly what it was a moment ago, and it is a state the
    // user can act on by resuming again once the queue is back. Leaving it
    // RUNNING would show a scan that nothing is running.
    await prisma.scanJob.updateMany({
      where: { id: scan.id, status: "RUNNING" },
      data: { status: "PAUSED", attempt: { decrement: 1 } },
    });
    return { kind: "QUEUE_UNAVAILABLE" };
  }
}

/**
 * Pause, resume or cancel.
 *
 * The status change is a compare-and-set: if the row moved between the read
 * and the write, the update matches nothing and the current state is re-read
 * and re-judged. That is what makes "cancel a scan that has already finished"
 * a refusal rather than a late overwrite of a completed result.
 */
export async function controlScan(
  ctx: AuthContext,
  scanJobId: string,
  action: ScanAction,
): Promise<ControlScanResult> {
  const scan = await findScanForOrg(ctx, scanJobId);
  if (!scan) return { ok: false, refusal: { kind: "SCAN_NOT_FOUND" } };

  const plan = planAction(action, scan);
  if (!plan.allowed) {
    return {
      ok: false,
      refusal: {
        kind: "ILLEGAL_TRANSITION",
        action,
        status: scan.status,
        detail: plan.detail,
      },
    };
  }

  const outcome = await applyControl(ctx, scan, action, plan);

  if (outcome.kind === "refused") {
    return { ok: false, refusal: outcome.refusal };
  }

  if (outcome.count === 0) {
    const current = await findScanForOrg(ctx, scanJobId);
    if (!current) return { ok: false, refusal: { kind: "SCAN_NOT_FOUND" } };
    const recheck = planAction(action, current);
    return {
      ok: false,
      refusal: {
        kind: "ILLEGAL_TRANSITION",
        action,
        status: current.status,
        detail: recheck.detail,
      },
    };
  }

  // Before the audit: a resume the queue refused is rolled back, and an audit
  // record for it would claim a state change that did not survive the request.
  const handoff = await deliverControl(scan, action, outcome.attempt);
  if (handoff) return { ok: false, refusal: handoff };

  await writeAudit(ctx, {
    action: ACTION_AUDIT[action],
    resourceType: "scan",
    resourceId: scan.id,
    metadata: {
      from: scan.status,
      to: plan.data.status,
      targetId: scan.targetId,
    },
  });

  const refreshed = await findScanForOrg(ctx, scanJobId);
  return { ok: true, scan: toScanDto(refreshed ?? scan) };
}
