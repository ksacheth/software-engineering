import type { ScanJob } from "@wvs/database";
import { isScannable, type NotScannableReason } from "@wvs/scope-rules";
import { serializable } from "../../common/serializable";
import { isScanningHalted } from "../scope-guard/kill-switch";
import { activeBlocklist } from "../scope-guard/blocklist";
import {
  QUOTA_OCCUPYING_SCAN_STATUSES,
  type ScanConfiguration,
  type ScanProfile,
} from "@wvs/shared";

/**
 * F.3 quota enforcement.
 *
 * Concurrency is counted from the database rather than a Redis counter,
 * because database state cannot drift from reality when a worker dies
 * mid-scan. The count and the insert happen in one serializable transaction,
 * retrying on serialization failure, so simultaneous requests cannot both pass
 * the limit. Scan initiation is not a hot path, so correctness is worth more
 * than throughput.
 */

const ACTIVE_STATUSES = [...QUOTA_OCCUPYING_SCAN_STATUSES];

export type ScanReservation =
  | { ok: true; scan: ScanJob }
  | { ok: false; kind: "TARGET_NOT_FOUND" }
  | { ok: false; kind: "TARGET_NOT_SCANNABLE"; reason: NotScannableReason }
  | { ok: false; kind: "ORG_CONCURRENCY"; limit: number }
  | { ok: false; kind: "TARGET_ALREADY_ACTIVE"; scanJobId: string }
  | { ok: false; kind: "KILL_SWITCH_ENGAGED" }
  | { ok: false; kind: "ORG_SCANNING_SUSPENDED" }
  | { ok: false; kind: "RATE_LIMIT_ABOVE_QUOTA"; limit: number };

export interface ReserveScanInput {
  organizationId: string;
  targetId: string;
  profile: ScanProfile;
  configuration: ScanConfiguration;
  /** See `StartScanRequest.rateLimitExplicit`. */
  rateLimitExplicit: boolean;
  createdById: string;
}

/**
 * Claim a concurrency slot and write the QUEUED row in one atomic step.
 *
 * The scope snapshot is copied from the target inside the transaction: a scan
 * runs with the scope that was in force when it was requested, which is what
 * F.2/F.3 reproducibility requires, even if the scope is edited a moment
 * later.
 */
export async function reserveScan(
  input: ReserveScanInput,
): Promise<ScanReservation> {
  return serializable(async (tx): Promise<ScanReservation> => {
    // ADR-0008: read inside the same serializable transaction as the insert.
    // Engaging the switch aborts every active row in its own serializable
    // transaction, so one of the two is retried and a scan cannot be queued
    // in the gap between the switch being set and the rows being aborted.
    if (await isScanningHalted(tx)) {
      return { ok: false, kind: "KILL_SWITCH_ENGAGED" };
    }

    const organization = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { maxConcurrentScans: true, scanRateLimit: true },
    });
    const limit = organization?.maxConcurrentScans ?? 2;

    // F.8 quotas. Zero is an administrator suspending the organisation's
    // scanning, which deserves its own answer rather than "limit 0 reached".
    if (limit === 0) {
      return { ok: false, kind: "ORG_SCANNING_SUSPENDED" } as const;
    }
    const rateCap = organization?.scanRateLimit ?? input.configuration.rateLimit;
    if (input.configuration.rateLimit > rateCap && input.rateLimitExplicit) {
      return {
        ok: false,
        kind: "RATE_LIMIT_ABOVE_QUOTA",
        limit: rateCap,
      } as const;
    }
    const rateLimit = Math.min(input.configuration.rateLimit, rateCap);

    const activeCount = await tx.scanJob.count({
      where: {
        organizationId: input.organizationId,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (activeCount >= limit) {
      return { ok: false, kind: "ORG_CONCURRENCY", limit } as const;
    }

    const target = await tx.target.findUnique({
      where: { id: input.targetId },
      select: {
        id: true,
        organizationId: true,
        origin: true,
        includedPaths: true,
        excludedPaths: true,
        isArchived: true,
        authorisationAck: true,
        verificationStatus: true,
        verificationExpiresAt: true,
        verifiedIpRanges: true,
      },
    });
    if (!target || target.organizationId !== input.organizationId) {
      return { ok: false, kind: "TARGET_NOT_FOUND" } as const;
    }

    // C.2 is re-answered here, inside the serializable transaction, and
    // not only by the caller. The caller's check reads the target in a
    // separate statement, so an archive or a verification revoked in
    // between would otherwise still produce a queued scan: the window is
    // small, but what slips through it is an unauthorised crawl against
    // a third party, which is the one thing C.2 exists to prevent.
    const verdict = isScannable(target, await activeBlocklist(tx));
    if (!verdict.scannable) {
      return {
        ok: false,
        kind: "TARGET_NOT_SCANNABLE",
        reason: verdict.reason!,
      } as const;
    }

    // A second scan of the same target would be two crawls against one
    // host, which the operator of that host experiences as an attack.
    const activeForTarget = await tx.scanJob.findFirst({
      where: {
        organizationId: input.organizationId,
        targetId: input.targetId,
        status: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (activeForTarget) {
      return {
        ok: false,
        kind: "TARGET_ALREADY_ACTIVE",
        scanJobId: activeForTarget.id,
      } as const;
    }

    const scan = await tx.scanJob.create({
      data: {
        targetId: input.targetId,
        organizationId: input.organizationId,
        profile: input.profile,
        status: "QUEUED",
        phase: "DISCOVERY",
        createdById: input.createdById,
        rateLimit,
        concurrency: input.configuration.concurrency,
        maxDepth: input.configuration.maxDepth,
        maxPages: input.configuration.maxPages,
        maxRequests: input.configuration.maxRequests,
        includedPaths: target.includedPaths,
        excludedPaths: target.excludedPaths,
      },
    });

    return { ok: true, scan } as const;
  });
}
