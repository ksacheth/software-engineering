import { createHash, randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@wvs/database";
import type {
  FindingSeverity,
  ReportFormat,
  ReportStatus,
  ReportTemplate,
  TriageState,
} from "@wvs/shared";
import { auditRow, writeAudit } from "../../common/audit";
import type { AuthContext } from "../../common/session";
import { FORMATS } from "./renderers";
import { enqueueReport } from "./report-queue";
import type { CreateReportRequest, ShareReportRequest } from "./report-request";
import { readReportFile } from "./report-storage";

/**
 * F.7 report requests, reads, downloads and share links.
 *
 * `ScanReport` carries no organisation, so every query is scoped through its
 * scan, and another organisation's report is not found rather than forbidden
 * (NFR-SEC-2). What a file may contain, who may download it, and how sharing
 * works are recorded in ADR-0011.
 */

export const MAX_LISTED_REPORTS = 100;

export interface ReportDto {
  id: string;
  scan: {
    id: string;
    completedAt: Date | null;
    target: { id: string; label: string; origin: string };
  };
  template: ReportTemplate;
  format: ReportFormat;
  status: ReportStatus;
  failureReason: string | null;
  fileSize: number | null;
  filters: { minSeverity: FindingSeverity | null; triageStates: TriageState[] };
  /** Null until generation has produced the statement. */
  coverageLimitations: string[] | null;
  includesEvidence: boolean;
  expiresAt: Date | null;
  /** True once the evidence the file holds has passed retention (C.7). */
  expired: boolean;
  share: { active: boolean; expiresAt: Date | null };
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  completedAt: Date | null;
}

const REPORT_INCLUDE = {
  scanJob: {
    select: {
      id: true,
      completedAt: true,
      target: { select: { id: true, label: true, origin: true } },
    },
  },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ScanReportInclude;

type ReportRow = Prisma.ScanReportGetPayload<{ include: typeof REPORT_INCLUDE }>;

function isExpired(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt !== null && row.expiresAt <= now;
}

function shareActive(
  row: { shareTokenHash: string | null; shareExpiresAt: Date | null },
  now: Date,
): boolean {
  return (
    row.shareTokenHash !== null &&
    row.shareExpiresAt !== null &&
    row.shareExpiresAt > now
  );
}

export function toReportDto(row: ReportRow, now: Date = new Date()): ReportDto {
  const active = shareActive(row, now) && !isExpired(row, now);
  return {
    id: row.id,
    scan: {
      id: row.scanJob.id,
      completedAt: row.scanJob.completedAt,
      target: row.scanJob.target,
    },
    template: row.template,
    format: row.format,
    status: row.status,
    failureReason: row.failureReason,
    fileSize: row.fileSize,
    filters: {
      minSeverity: row.minSeverityFilter,
      triageStates: row.triageStateFilter,
    },
    coverageLimitations: row.coverageLimitations
      ? row.coverageLimitations.split("\n")
      : null,
    includesEvidence: row.includesEvidence,
    expiresAt: row.expiresAt,
    expired: isExpired(row, now),
    share: { active, expiresAt: active ? row.shareExpiresAt : null },
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function scopedWhere(ctx: AuthContext, id: string): Prisma.ScanReportWhereInput {
  return { id, scanJob: { organizationId: ctx.organizationId } };
}

async function findReport(ctx: AuthContext, id: string): Promise<ReportRow | null> {
  return prisma.scanReport.findFirst({
    where: scopedWhere(ctx, id),
    include: REPORT_INCLUDE,
  });
}

// ----------------------------------------------------------------- request ---

export type RequestReportResult =
  | { ok: true; report: ReportDto }
  | { ok: false; reason: "SCAN_NOT_FOUND" | "QUEUE_UNAVAILABLE" }
  | { ok: false; reason: "SCAN_NOT_COMPLETED"; scanStatus: string };

export async function requestReport(
  ctx: AuthContext,
  input: CreateReportRequest,
): Promise<RequestReportResult> {
  const scan = await prisma.scanJob.findFirst({
    where: { id: input.scanId, organizationId: ctx.organizationId },
    select: { id: true, status: true },
  });
  if (!scan) return { ok: false, reason: "SCAN_NOT_FOUND" };
  if (scan.status !== "COMPLETED") {
    return { ok: false, reason: "SCAN_NOT_COMPLETED", scanStatus: scan.status };
  }

  // The request and its audit record commit together: an export with no trace
  // is the gap F.8 exists to close.
  const created = await prisma.$transaction(async (tx) => {
    const report = await tx.scanReport.create({
      data: {
        scanJobId: scan.id,
        template: input.template,
        format: input.format,
        minSeverityFilter: input.minSeverity ?? null,
        triageStateFilter: input.triageStates,
        createdById: ctx.userId,
      },
    });
    await tx.auditLog.create({
      data: auditRow(ctx, {
        action: "REPORT_EXPORTED",
        resourceType: "scan_report",
        resourceId: report.id,
        metadata: {
          scanJobId: scan.id,
          template: input.template,
          format: input.format,
          minSeverity: input.minSeverity ?? null,
          triageStates: input.triageStates,
        },
      }),
    });
    return report;
  });

  try {
    await enqueueReport(created.id);
  } catch (error) {
    // Unlike a scan, a report that never reached the queue holds nothing, so
    // it is ended here rather than left for a reconciler.
    console.error("[reports] enqueue failed", created.id, error);
    await prisma.scanReport.update({
      where: { id: created.id },
      data: {
        status: "FAILED",
        failureReason: "The report queue was unavailable. Try again shortly.",
        completedAt: new Date(),
      },
    });
    return { ok: false, reason: "QUEUE_UNAVAILABLE" };
  }

  const report = await findReport(ctx, created.id);
  return { ok: true, report: toReportDto(report!) };
}

// ------------------------------------------------------------------- reads ---

export async function listReports(
  ctx: AuthContext,
  filter: { scanId?: string },
): Promise<ReportDto[]> {
  const rows = await prisma.scanReport.findMany({
    where: {
      scanJob: { organizationId: ctx.organizationId },
      ...(filter.scanId ? { scanJobId: filter.scanId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_LISTED_REPORTS,
    include: REPORT_INCLUDE,
  });
  const now = new Date();
  return rows.map((row) => toReportDto(row, now));
}

export async function getReport(ctx: AuthContext, id: string): Promise<ReportDto | null> {
  const row = await findReport(ctx, id);
  return row ? toReportDto(row) : null;
}

// ---------------------------------------------------------------- download ---

export type DownloadResult =
  | { ok: true; bytes: Buffer; contentType: string; filename: string }
  | {
      ok: false;
      reason: "NOT_FOUND" | "NOT_READY" | "EXPIRED" | "EVIDENCE_WITHHELD" | "FILE_MISSING";
    };

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
}

export function reportFilename(row: {
  template: ReportTemplate;
  format: ReportFormat;
  scanJobId: string;
  scanJob: { target: { origin: string } };
}): string {
  let host = row.scanJob.target.origin;
  try {
    host = new URL(host).hostname;
  } catch {
    // Keep the origin as given; slug() makes it safe either way.
  }
  const template = row.template === "EXECUTIVE_SUMMARY" ? "executive-summary" : "technical-report";
  return `wvs-${template}-${slug(host)}-${row.scanJobId.slice(0, 8)}.${FORMATS[row.format].extension}`;
}

async function readyFile(row: ReportRow, now: Date): Promise<DownloadResult> {
  if (row.status !== "READY" || !row.filePath) return { ok: false, reason: "NOT_READY" };
  if (isExpired(row, now)) return { ok: false, reason: "EXPIRED" };
  const bytes = await readReportFile(row.filePath);
  if (!bytes) return { ok: false, reason: "FILE_MISSING" };
  return {
    ok: true,
    bytes,
    contentType: FORMATS[row.format].contentType,
    filename: reportFilename(row),
  };
}

export async function downloadReport(ctx: AuthContext, id: string): Promise<DownloadResult> {
  const row = await findReport(ctx, id);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  // ADR-0010 withholds raw evidence from VIEWER at the API. A file that holds
  // some is withheld from them whole, whoever generated it.
  if (row.includesEvidence && ctx.role === "VIEWER") {
    return { ok: false, reason: "EVIDENCE_WITHHELD" };
  }
  return readyFile(row, new Date());
}

// ------------------------------------------------------------------ sharing ---

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ShareResult =
  | { ok: true; report: ReportDto; token: string; sharePath: string }
  | { ok: false; reason: "NOT_FOUND" | "NOT_READY" | "EXPIRED" };

/**
 * Create a link anyone holding it can download the file from until it
 * expires. A new link replaces the old one, which stops working.
 *
 * The link never outlives the evidence in the file (C.7).
 */
export async function shareReport(
  ctx: AuthContext,
  id: string,
  input: ShareReportRequest,
): Promise<ShareResult> {
  const row = await findReport(ctx, id);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.status !== "READY") return { ok: false, reason: "NOT_READY" };
  const now = new Date();
  if (isExpired(row, now)) return { ok: false, reason: "EXPIRED" };

  const requested = new Date(now.getTime() + input.expiresInDays * DAY_MS);
  const expiresAt =
    row.expiresAt && row.expiresAt < requested ? row.expiresAt : requested;
  const token = randomBytes(32).toString("base64url");

  const updated = await prisma.$transaction(async (tx) => {
    const report = await tx.scanReport.update({
      where: { id: row.id },
      data: { shareTokenHash: hashShareToken(token), shareExpiresAt: expiresAt },
      include: REPORT_INCLUDE,
    });
    await tx.auditLog.create({
      data: auditRow(ctx, {
        action: "REPORT_SHARED",
        resourceType: "scan_report",
        resourceId: row.id,
        metadata: { scanJobId: row.scanJobId, expiresAt: expiresAt.toISOString() },
      }),
    });
    return report;
  });

  return {
    ok: true,
    report: toReportDto(updated, now),
    token,
    sharePath: `/api/reports/shared/${token}`,
  };
}

export async function revokeShare(
  ctx: AuthContext,
  id: string,
): Promise<ReportDto | null> {
  const row = await findReport(ctx, id);
  if (!row) return null;
  if (row.shareTokenHash === null) return toReportDto(row);

  const updated = await prisma.scanReport.update({
    where: { id: row.id },
    data: { shareTokenHash: null, shareExpiresAt: null },
    include: REPORT_INCLUDE,
  });
  await writeAudit(ctx, {
    action: "REPORT_SHARE_REVOKED",
    resourceType: "scan_report",
    resourceId: row.id,
    metadata: { scanJobId: row.scanJobId },
  });
  return toReportDto(updated);
}

/**
 * Serve a shared file. Every way a link can fail answers the same, so a
 * guessed, expired or revoked token cannot be told apart.
 */
export async function downloadShared(token: string): Promise<DownloadResult> {
  const row = await prisma.scanReport.findUnique({
    where: { shareTokenHash: hashShareToken(token) },
    include: REPORT_INCLUDE,
  });
  const now = new Date();
  if (!row || !shareActive(row, now)) return { ok: false, reason: "NOT_FOUND" };
  const result = await readyFile(row, now);
  return result.ok ? result : { ok: false, reason: "NOT_FOUND" };
}
