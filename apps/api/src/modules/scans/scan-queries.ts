import { prisma, type ScanJob, type Target, type User } from "@wvs/database";
import {
  deriveScanWarnings,
  isScanStatus,
  type ScanConfiguration,
  type ScanPhase,
  type ScanProfile,
  type ScanStatus,
  type ScanWarning,
} from "@wvs/shared";
import type { AuthContext } from "../../common/session";

/**
 * F.3 scan reads.
 *
 * Reads are open to every role; scoping always comes from the session, so a
 * scan belonging to another organisation is not found rather than forbidden,
 * and the endpoint does not confirm that it exists.
 */

export interface ScanDto {
  id: string;
  organizationId: string;
  targetId: string;
  target: { id: string; label: string; origin: string } | null;
  /** Who requested the scan, so activity can be attributed (F.3, F.8). */
  startedBy: { id: string; name: string } | null;
  scheduleId: string | null;
  profile: ScanProfile;
  status: ScanStatus;
  phase: ScanPhase;
  configuration: ScanConfiguration;
  includedPaths: string[];
  excludedPaths: string[];
  detectorVersions: unknown;
  workerId: string | null;
  pagesCrawled: number;
  requestsMade: number;
  findingsCount: number;
  progressPercentage: number;
  isDegraded: boolean;
  blockingDetected: boolean;
  bindingLimit: string | null;
  failureReason: string | null;
  warnings: ScanWarning[];
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
}

type ScanWithRelations = ScanJob & {
  target?: Pick<Target, "id" | "label" | "origin"> | null;
  createdBy?: Pick<User, "id" | "name"> | null;
};

export function toScanDto(scan: ScanWithRelations): ScanDto {
  return {
    id: scan.id,
    organizationId: scan.organizationId,
    targetId: scan.targetId,
    target: scan.target
      ? { id: scan.target.id, label: scan.target.label, origin: scan.target.origin }
      : null,
    startedBy: scan.createdBy
      ? { id: scan.createdBy.id, name: scan.createdBy.name }
      : null,
    scheduleId: scan.scheduleId,
    profile: scan.profile,
    status: scan.status,
    phase: scan.phase,
    configuration: {
      rateLimit: scan.rateLimit,
      concurrency: scan.concurrency,
      maxDepth: scan.maxDepth,
      maxPages: scan.maxPages,
      maxRequests: scan.maxRequests,
    },
    includedPaths: scan.includedPaths,
    excludedPaths: scan.excludedPaths,
    detectorVersions: scan.detectorVersions,
    workerId: scan.workerId,
    pagesCrawled: scan.pagesCrawled,
    requestsMade: scan.requestsMade,
    findingsCount: scan.findingsCount,
    progressPercentage: scan.progressPercentage,
    isDegraded: scan.isDegraded,
    blockingDetected: scan.blockingDetected,
    bindingLimit: scan.bindingLimit,
    failureReason: scan.failureReason,
    // The durable copy of live warnings: a degradation missed live is still
    // visible after a reload (SRS F.3).
    warnings: deriveScanWarnings({
      degradations: scan.degradations,
      blockingDetected: scan.blockingDetected,
      bindingLimit: scan.bindingLimit,
    }),
    queuedAt: scan.queuedAt,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    pausedAt: scan.pausedAt,
    cancelledAt: scan.cancelledAt,
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
    createdById: scan.createdById,
  };
}

const TARGET_SELECT = { id: true, label: true, origin: true } as const;
const CREATOR_SELECT = { id: true, name: true } as const;
const SCAN_INCLUDE = {
  target: { select: TARGET_SELECT },
  createdBy: { select: CREATOR_SELECT },
} as const;

/**
 * Read-only projection of the findings a scan has written.
 *
 * F.6 owns deduplication, diff status, triage and evidence; this exists so the
 * live view can rebuild its finding list after a reload, which is what stops a
 * degradation or a finding seen live from being lost on refresh. It deliberately
 * carries no triage state and no evidence.
 */
export interface ScanFindingDto {
  id: string;
  fingerprint: string;
  detectorId: string;
  name: string;
  severity: string;
  affectedUrl: string;
  createdAt: Date;
}

export async function listScanFindings(
  scanJobId: string,
): Promise<ScanFindingDto[]> {
  const findings = await prisma.finding.findMany({
    where: { scanJobId },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      fingerprint: true,
      detectorId: true,
      name: true,
      severity: true,
      affectedUrl: true,
      createdAt: true,
    },
  });
  return findings;
}


export async function findScanForOrg(
  ctx: AuthContext,
  scanJobId: string,
): Promise<ScanWithRelations | null> {
  return prisma.scanJob.findFirst({
    where: { id: scanJobId, organizationId: ctx.organizationId },
    include: SCAN_INCLUDE,
  });
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ScanCursor {
  createdAt: string;
  id: string;
}

export function encodeScanCursor(scan: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: scan.createdAt.toISOString(), id: scan.id }),
  ).toString("base64url");
}

/** Returns null for anything that is not a cursor this API issued. */
export function decodeScanCursor(value: string): ScanCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed?.createdAt !== "string" ||
      typeof parsed?.id !== "string" ||
      Number.isNaN(new Date(parsed.createdAt).getTime())
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export interface ScanListQuery {
  targetId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface ScanListResult {
  scans: ScanDto[];
  nextCursor: string | null;
}

export async function listScans(
  ctx: AuthContext,
  query: ScanListQuery,
): Promise<ScanListResult> {
  const take = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const cursor = query.cursor ? decodeScanCursor(query.cursor) : null;

  // Keyset pagination on (createdAt, id) rather than OFFSET: a long scanning
  // history must not make page N cost N rows.
  const cursorFilter = cursor
    ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : {};

  const rows = await prisma.scanJob.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(isScanStatus(query.status) ? { status: query.status } : {}),
      ...cursorFilter,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: SCAN_INCLUDE,
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    scans: page.map(toScanDto),
    nextCursor: hasMore ? encodeScanCursor(page[page.length - 1]!) : null,
  };
}
