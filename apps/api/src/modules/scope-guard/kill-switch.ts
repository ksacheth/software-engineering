import { prisma, type Prisma } from "@wvs/database";
import {
  isKillSwitchEngaged,
  KILL_SWITCH_SETTING_KEY,
  QUOTA_OCCUPYING_SCAN_STATUSES,
  type KillSwitchState,
  type ScanEvent,
} from "@wvs/shared";
import type { AuthContext } from "../../common/session";
import { auditRow } from "../../common/audit";
import { serializable } from "../../common/serializable";
import { removeScanJob } from "../scans/scan-queue";
import { publishScanEvents } from "../scans/scan-bus";

/**
 * F.8 kill switch, administration side (ADR-0008).
 *
 * Engaging does two things: every active scan row moves to ABORTED_SAFETY,
 * which a worker obeys at its next checkpoint (ADR-0007), and the setting the
 * Scope Guard reads before every request is set, which stops anything the rows
 * missed. This module owns both writes; enforcement is the Scope Guard's.
 */

export const KILL_SWITCH_FAILURE_REASON =
  "Halted by an administrator using the kill switch.";

type Reader = Pick<Prisma.TransactionClient, "systemSetting">;

/** Whether scanning is halted. A switch never used reads as released. */
export async function isScanningHalted(
  client: Reader = prisma,
): Promise<boolean> {
  const setting = await client.systemSetting.findUnique({
    where: { key: KILL_SWITCH_SETTING_KEY },
    select: { value: true },
  });
  return isKillSwitchEngaged(setting?.value);
}

export interface KillSwitchView {
  engaged: boolean;
  changedAt: string | null;
  reason: string | null;
  changedBy: { id: string; email: string; name: string } | null;
}

/**
 * The switch as an administrator sees it: its state, and who last changed it
 * and why. The why lives in the audit log, which is the record of it, rather
 * than in a second copy on the setting.
 */
export async function readKillSwitch(): Promise<KillSwitchView> {
  const [setting, lastChange] = await Promise.all([
    prisma.systemSetting.findUnique({
      where: { key: KILL_SWITCH_SETTING_KEY },
    }),
    prisma.auditLog.findFirst({
      where: {
        action: {
          in: ["ADMIN_KILL_SWITCH_ENGAGED", "ADMIN_KILL_SWITCH_DISENGAGED"],
        },
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    }),
  ]);

  const changedBy = lastChange?.userId
    ? await prisma.user.findUnique({
        where: { id: lastChange.userId },
        select: { id: true, email: true, name: true },
      })
    : null;
  const metadata = (lastChange?.metadata ?? {}) as { reason?: unknown };

  return {
    engaged: isKillSwitchEngaged(setting?.value),
    changedAt: setting?.updatedAt.toISOString() ?? null,
    reason: typeof metadata.reason === "string" ? metadata.reason : null,
    changedBy,
  };
}

export type KillSwitchResult =
  | { ok: true; killSwitch: KillSwitchView; abortedScans: number }
  | { ok: false; kind: "ALREADY_ENGAGED" | "ALREADY_RELEASED" };

interface AbortedScan {
  id: string;
  organizationId: string;
  targetId: string;
  status: string;
}

function writeSetting(tx: Prisma.TransactionClient, state: KillSwitchState) {
  return tx.systemSetting.upsert({
    where: { key: KILL_SWITCH_SETTING_KEY },
    create: {
      key: KILL_SWITCH_SETTING_KEY,
      value: state,
      description:
        "F.8 kill switch (ADR-0008). The Scope Guard refuses every request while engaged.",
    },
    update: { value: state },
  });
}

/**
 * Set the switch, abort every active scan and record it all, as one
 * serializable step.
 *
 * Serializable because `reserveScan` reads the setting and inserts a row in
 * its own serializable transaction: if the two overlap, Postgres aborts one of
 * them, so a scan can neither be queued after the rows were swept nor slip in
 * between the setting and the sweep.
 *
 * The audit records commit with the change. Written afterwards, a crash
 * between the two would leave scans aborted with no record of why, and a
 * second engagement would find the switch already on and never write them.
 */
async function haltAll(
  ctx: AuthContext,
  reason: string,
): Promise<AbortedScan[] | null> {
  return serializable(async (tx) => {
    if (await isScanningHalted(tx)) return null;

    await writeSetting(tx, "engaged");

    const active = await tx.scanJob.findMany({
      where: { status: { in: [...QUOTA_OCCUPYING_SCAN_STATUSES] } },
      select: { id: true, organizationId: true, targetId: true, status: true },
    });
    if (active.length > 0) {
      await tx.scanJob.updateMany({
        where: {
          id: { in: active.map((scan) => scan.id) },
          status: { in: [...QUOTA_OCCUPYING_SCAN_STATUSES] },
        },
        data: {
          status: "ABORTED_SAFETY",
          failureReason: KILL_SWITCH_FAILURE_REASON,
          completedAt: new Date(),
        },
      });
    }

    await tx.auditLog.createMany({
      data: [
        ...active.map((scan) =>
          auditRow(ctx, {
            action: "SCAN_ABORTED_SAFETY",
            resourceType: "scan",
            resourceId: scan.id,
            organizationId: scan.organizationId,
            metadata: {
              from: scan.status,
              to: "ABORTED_SAFETY",
              targetId: scan.targetId,
              by: "kill-switch",
            },
          }),
        ),
        auditRow(ctx, {
          action: "ADMIN_KILL_SWITCH_ENGAGED",
          resourceType: "system_setting",
          resourceId: KILL_SWITCH_SETTING_KEY,
          organizationId: null,
          metadata: { reason, abortedScans: active.length },
        }),
      ],
    });
    return active;
  });
}

export async function engageKillSwitch(
  ctx: AuthContext,
  reason: string,
): Promise<KillSwitchResult> {
  const aborted = await haltAll(ctx, reason);
  if (!aborted) return { ok: false, kind: "ALREADY_ENGAGED" };

  // After the commit, never inside it: the rows are the signal and they are
  // already written, so these are clean-up and announcements that must not be
  // able to roll the halt back. Both are best effort by design: a job left in
  // the queue meets an ABORTED_SAFETY row and exits (ADR-0007), and a live
  // view that misses the event sees the row on its next poll.
  await Promise.all(aborted.map((scan) => removeScanJob(scan.id)));

  const at = new Date().toISOString();
  await publishScanEvents(
    aborted.map(
      (scan): ScanEvent => ({
        type: "scan.status",
        scanJobId: scan.id,
        at,
        status: "ABORTED_SAFETY",
        failureReason: KILL_SWITCH_FAILURE_REASON,
      }),
    ),
  );

  return {
    ok: true,
    killSwitch: await readKillSwitch(),
    abortedScans: aborted.length,
  };
}

/** Release the switch. Restarts nothing: aborted scans stay aborted. */
export async function releaseKillSwitch(
  ctx: AuthContext,
  reason: string,
): Promise<KillSwitchResult> {
  const released = await serializable(async (tx) => {
    if (!(await isScanningHalted(tx))) return false;
    await writeSetting(tx, "released");
    await tx.auditLog.create({
      data: auditRow(ctx, {
        action: "ADMIN_KILL_SWITCH_DISENGAGED",
        resourceType: "system_setting",
        resourceId: KILL_SWITCH_SETTING_KEY,
        organizationId: null,
        metadata: { reason },
      }),
    });
    return true;
  });
  if (!released) return { ok: false, kind: "ALREADY_RELEASED" };

  return { ok: true, killSwitch: await readKillSwitch(), abortedScans: 0 };
}
