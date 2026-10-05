import { prisma, type Prisma, type ScanReport } from "@wvs/database";
import {
  FINDING_SEVERITIES,
  type ComparisonStatus,
  type FindingConfidence,
  type FindingSeverity,
  type ReportFormat,
  type ReportTemplate,
  type ScanProfile,
  type TriageState,
} from "@wvs/shared";
import { presentEvidence, type EvidenceDto } from "../findings/finding-queries";
import { coverageLimitations, type EvidenceCounts } from "./coverage";

/**
 * F.7: the report as data, before it is a file.
 *
 * Every format renders this one document, so the five formats cannot disagree
 * about what a scan found, and the mandatory metadata and limitations statement
 * are present by construction rather than by each renderer remembering them.
 *
 * The executive summary never loads evidence at all. "No raw evidence" is then
 * a property of the document, not a promise five renderers each have to keep.
 */

export const REPORT_GENERATOR = {
  name: "WVS",
  fullName: "Website Vulnerability Scanner",
  version: "1.0.0",
  informationUri: "https://github.com/ksacheth/software-engineering",
} as const;

/** Trend covers this scan and up to this many before it. */
export const TREND_SCANS = 6;

/**
 * Evidence bodies are capped so a 500-finding report stays within the
 * NFR-PERF-2 budget. The cap is stated in the body itself, never silent.
 */
export const EVIDENCE_BODY_LIMIT = 16 * 1024;

export type SeverityCounts = Record<FindingSeverity, number>;

export interface ReportFinding {
  id: string;
  fingerprint: string;
  detectorId: string;
  name: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  cwe: string | null;
  owaspCategory: string | null;
  affectedUrl: string;
  affectedParameter: string | null;
  cvssScore: number | null;
  cvssVector: string | null;
  cveId: string | null;
  epssScore: number | null;
  epssPercentile: number | null;
  occurrenceCount: number;
  diffStatus: ComparisonStatus | null;
  triage: { state: TriageState; justification: string | null };
  description: string;
  remediation: string;
  /** Absent from an executive summary, always. */
  evidence?: EvidenceDto;
}

export interface TrendPoint {
  scanId: string;
  completedAt: Date | null;
  total: number;
  bySeverity: SeverityCounts;
}

export interface ReportDocument {
  report: {
    id: string;
    template: ReportTemplate;
    format: ReportFormat;
    generatedAt: Date;
    filters: { minSeverity: FindingSeverity | null; triageStates: TriageState[] };
  };
  target: { id: string; label: string; origin: string };
  scan: {
    id: string;
    profile: ScanProfile;
    queuedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    pagesCrawled: number;
    requestsMade: number;
    scope: {
      includedPaths: string[];
      excludedPaths: string[];
      maxDepth: number;
      maxPages: number;
      maxRequests: number;
      rateLimit: number;
      concurrency: number;
    };
    detectorVersions: { detectorId: string; version: string }[];
  };
  coverageLimitations: string[];
  summary: {
    total: number;
    bySeverity: SeverityCounts;
    /** Findings still needing action: triaged OPEN or CONFIRMED. */
    actionable: number;
    highestActionable: FindingSeverity | null;
    /** Null when the orchestrator recorded no comparison for this scan. */
    diff: Record<ComparisonStatus, number> | null;
  };
  trend: TrendPoint[];
  /** Most severe first. */
  findings: ReportFinding[];
}

/** Most severe first, the order every report lists findings in. */
export const SEVERITIES_DESCENDING: readonly FindingSeverity[] = [
  ...FINDING_SEVERITIES,
].reverse();

export function emptySeverityCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
}

export function severitiesAtOrAbove(
  minimum: FindingSeverity | null,
): FindingSeverity[] {
  if (!minimum) return [...FINDING_SEVERITIES];
  return FINDING_SEVERITIES.slice(FINDING_SEVERITIES.indexOf(minimum));
}

function severityRank(severity: FindingSeverity): number {
  return SEVERITIES_DESCENDING.indexOf(severity);
}

// ------------------------------------------------------------ json columns ---

/**
 * `ScanJob.detectorVersions` is written by the orchestrator and its shape is
 * not pinned yet. Accept a `{ id: version }` map or a list of `{ id, version }`
 * and report anything else as not recorded rather than guessing.
 */
export function readDetectorVersions(
  value: unknown,
): { detectorId: string; version: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const row = entry as Record<string, unknown>;
      const id = row.detectorId ?? row.id;
      const version = row.version;
      return typeof id === "string" &&
        (typeof version === "string" || typeof version === "number")
        ? [{ detectorId: id, version: String(version) }]
        : [];
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([detectorId, version]) =>
        typeof version === "string" || typeof version === "number"
          ? [{ detectorId, version: String(version) }]
          : [],
    );
  }
  return [];
}

function capBody(body: string | null): string | null {
  if (body === null || body.length <= EVIDENCE_BODY_LIMIT) return body;
  const dropped = body.length - EVIDENCE_BODY_LIMIT;
  return `${body.slice(0, EVIDENCE_BODY_LIMIT)}\n[truncated: ${dropped} more characters]`;
}

function capEvidence(evidence: EvidenceDto): EvidenceDto {
  if (evidence.status !== "AVAILABLE") return evidence;
  return {
    ...evidence,
    requestBody: capBody(evidence.requestBody),
    responseBody: capBody(evidence.responseBody),
  };
}

// ---------------------------------------------------------------- loading ---

const SCAN_SELECT = {
  id: true,
  targetId: true,
  profile: true,
  status: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  pagesCrawled: true,
  requestsMade: true,
  includedPaths: true,
  excludedPaths: true,
  maxDepth: true,
  maxPages: true,
  maxRequests: true,
  rateLimit: true,
  concurrency: true,
  detectorVersions: true,
  degradations: true,
  blockingDetected: true,
  bindingLimit: true,
  target: { select: { id: true, label: true, origin: true } },
} as const satisfies Prisma.ScanJobSelect;

type ScanRow = Prisma.ScanJobGetPayload<{ select: typeof SCAN_SELECT }>;

type ReportRow = Pick<
  ScanReport,
  | "id"
  | "scanJobId"
  | "template"
  | "format"
  | "minSeverityFilter"
  | "triageStateFilter"
  | "createdById"
>;

async function loadTriage(
  targetId: string,
  fingerprints: string[],
): Promise<Map<string, { state: TriageState; justification: string | null }>> {
  if (fingerprints.length === 0) return new Map();
  const rows = await prisma.targetFindingTriage.findMany({
    where: { targetId, findingFingerprint: { in: fingerprints } },
    select: { findingFingerprint: true, state: true, justification: true },
  });
  return new Map(
    rows.map((row) => [
      row.findingFingerprint,
      { state: row.state, justification: row.justification },
    ]),
  );
}

async function loadDiffs(
  scanId: string,
): Promise<Map<string, ComparisonStatus>> {
  const rows = await prisma.scanFindingDiff.findMany({
    where: { scanJobId: scanId },
    select: { fingerprint: true, status: true },
  });
  return new Map(rows.map((row) => [row.fingerprint, row.status]));
}

async function loadTrend(
  scan: ScanRow,
  severities: FindingSeverity[],
): Promise<TrendPoint[]> {
  const scans = await prisma.scanJob.findMany({
    where: {
      targetId: scan.targetId,
      status: "COMPLETED",
      ...(scan.completedAt ? { completedAt: { lte: scan.completedAt } } : {}),
    },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: TREND_SCANS,
    select: { id: true, completedAt: true },
  });
  const counts = await prisma.finding.groupBy({
    by: ["scanJobId", "severity"],
    where: {
      scanJobId: { in: scans.map((row) => row.id) },
      severity: { in: severities },
    },
    _count: { _all: true },
  });

  return scans.reverse().map((row) => {
    const bySeverity = emptySeverityCounts();
    for (const count of counts) {
      if (count.scanJobId === row.id) bySeverity[count.severity] = count._count._all;
    }
    const total = Object.values(bySeverity).reduce((sum, n) => sum + n, 0);
    return { scanId: row.id, completedAt: row.completedAt, total, bySeverity };
  });
}

async function loadCrawlFacts(scanId: string) {
  const [reducedConfidencePages, detectorErrors] = await Promise.all([
    prisma.crawledPage.count({
      where: {
        scanJobId: scanId,
        OR: [{ reducedConfidence: true }, { isBlocked: true }],
      },
    }),
    prisma.detectorExecutionError.findMany({
      where: { scanJobId: scanId },
      distinct: ["detectorId"],
      orderBy: { detectorId: "asc" },
      select: { detectorId: true },
    }),
  ]);
  return {
    reducedConfidencePages,
    failedDetectorIds: detectorErrors.map((row) => row.detectorId),
  };
}

/**
 * The author's role decides what evidence the file may hold (ADR-0011). An
 * author who no longer exists is treated as the least privileged role, so a
 * deleted account cannot widen what a report shows.
 */
async function authorRole(createdById: string | null): Promise<string> {
  if (!createdById) return "VIEWER";
  const user = await prisma.user.findUnique({
    where: { id: createdById },
    select: { role: true },
  });
  return user?.role ?? "VIEWER";
}

function countEvidence(findings: ReportFinding[]): EvidenceCounts {
  const counts: EvidenceCounts = { unredacted: 0, role: 0, purged: 0 };
  for (const finding of findings) {
    const status = finding.evidence?.status;
    if (status === "WITHHELD_UNREDACTED") counts.unredacted += 1;
    if (status === "WITHHELD_ROLE") counts.role += 1;
    if (status === "PURGED") counts.purged += 1;
  }
  return counts;
}

function summarise(
  findings: ReportFinding[],
  diffs: Map<string, ComparisonStatus>,
): ReportDocument["summary"] {
  const bySeverity = emptySeverityCounts();
  let actionable = 0;
  let highestActionable: FindingSeverity | null = null;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    if (finding.triage.state === "OPEN" || finding.triage.state === "CONFIRMED") {
      actionable += 1;
      if (
        highestActionable === null ||
        severityRank(finding.severity) < severityRank(highestActionable)
      ) {
        highestActionable = finding.severity;
      }
    }
  }

  let diff: Record<ComparisonStatus, number> | null = null;
  if (diffs.size > 0) {
    diff = { NEW: 0, PERSISTING: 0, RESOLVED: 0 };
    for (const status of diffs.values()) diff[status] += 1;
  }

  return { total: findings.length, bySeverity, actionable, highestActionable, diff };
}

export interface BuiltReport {
  document: ReportDocument;
  includesEvidence: boolean;
  /** Earliest retention expiry of any evidence the document holds (C.7). */
  evidenceExpiresAt: Date | null;
}

export async function buildReportDocument(
  report: ReportRow,
  now: Date = new Date(),
): Promise<BuiltReport> {
  const scan = await prisma.scanJob.findUniqueOrThrow({
    where: { id: report.scanJobId },
    select: SCAN_SELECT,
  });
  const technical = report.template === "TECHNICAL_REPORT";
  const severities = severitiesAtOrAbove(report.minSeverityFilter);
  const triageStates = report.triageStateFilter;

  const [rows, diffs, trend, crawl, role] = await Promise.all([
    prisma.finding.findMany({
      where: { scanJobId: scan.id, severity: { in: severities } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: { evidence: technical },
    }),
    loadDiffs(scan.id),
    loadTrend(scan, severities),
    loadCrawlFacts(scan.id),
    technical ? authorRole(report.createdById) : Promise.resolve("VIEWER"),
  ]);
  const triage = await loadTriage(
    scan.targetId,
    rows.map((row) => row.fingerprint),
  );

  const findings: ReportFinding[] = rows
    .map((row) => {
      const finding: ReportFinding = {
        id: row.id,
        fingerprint: row.fingerprint,
        detectorId: row.detectorId,
        name: row.name,
        severity: row.severity,
        confidence: row.confidence,
        cwe: row.cwe,
        owaspCategory: row.owaspCategory,
        affectedUrl: row.affectedUrl,
        affectedParameter: row.affectedParameter,
        cvssScore: row.cvssScore,
        cvssVector: row.cvssVector,
        cveId: row.cveId,
        epssScore: row.epssScore,
        epssPercentile: row.epssPercentile,
        occurrenceCount: row.occurrenceCount,
        diffStatus: diffs.get(row.fingerprint) ?? null,
        triage: triage.get(row.fingerprint) ?? { state: "OPEN", justification: null },
        description: row.description,
        remediation: row.remediation,
      };
      if (technical) {
        finding.evidence = capEvidence(presentEvidence(row.evidence ?? null, role));
      }
      return finding;
    })
    .filter(
      (finding) =>
        triageStates.length === 0 || triageStates.includes(finding.triage.state),
    )
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const detectorVersions = readDetectorVersions(scan.detectorVersions);
  const filters = { minSeverity: report.minSeverityFilter, triageStates };

  const limitations = coverageLimitations({
    profile: scan.profile,
    includedPaths: scan.includedPaths,
    excludedPaths: scan.excludedPaths,
    degradations: scan.degradations,
    blockingDetected: scan.blockingDetected,
    bindingLimit: scan.bindingLimit,
    reducedConfidencePages: crawl.reducedConfidencePages,
    failedDetectorIds: crawl.failedDetectorIds,
    detectorVersionsRecorded: detectorVersions.length > 0,
    filters,
    evidence: technical ? countEvidence(findings) : undefined,
  });

  const available = findings.flatMap((finding) =>
    finding.evidence?.status === "AVAILABLE" ? [finding.evidence.expiresAt] : [],
  );
  const evidenceExpiresAt =
    available.length > 0
      ? new Date(Math.min(...available.map((date) => date.getTime())))
      : null;

  return {
    includesEvidence: available.length > 0,
    evidenceExpiresAt,
    document: {
      report: {
        id: report.id,
        template: report.template,
        format: report.format,
        generatedAt: now,
        filters,
      },
      target: scan.target,
      scan: {
        id: scan.id,
        profile: scan.profile,
        queuedAt: scan.queuedAt,
        startedAt: scan.startedAt,
        completedAt: scan.completedAt,
        pagesCrawled: scan.pagesCrawled,
        requestsMade: scan.requestsMade,
        scope: {
          includedPaths: scan.includedPaths,
          excludedPaths: scan.excludedPaths,
          maxDepth: scan.maxDepth,
          maxPages: scan.maxPages,
          maxRequests: scan.maxRequests,
          rateLimit: scan.rateLimit,
          concurrency: scan.concurrency,
        },
        detectorVersions,
      },
      coverageLimitations: limitations,
      summary: summarise(findings, diffs),
      trend,
      findings,
    },
  };
}
