import {
  prisma,
  type Finding,
  type FindingEvidence,
  type Prisma,
  type ScanJob,
  type Target,
} from "@wvs/database";
import {
  TRIAGE_STATES,
  type ComparisonStatus,
  type FindingConfidence,
  type FindingSeverity,
  type ScanProfile,
  type ScanStatus,
  type TriageState,
} from "@wvs/shared";
import type { AuthContext } from "../../common/session";
import type { FindingListQuery } from "./finding-request";
import {
  encodeFindingCursor,
  findingOrderBy,
  findingsAfter,
} from "./finding-sort";

/**
 * F.6 finding reads.
 *
 * Reads are open to every role. `Finding` carries no organisation, so every
 * query is scoped through its target, and another organisation's finding or
 * scan is not found rather than forbidden: the response must not confirm that
 * it exists (NFR-SEC-2).
 *
 * Triage state is held per `(target, fingerprint)` in the trigger-managed
 * projection (ADR-0003), not on the finding row. A fingerprint with no
 * projection row has never been triaged and is OPEN.
 */

export interface FindingTriageDto {
  state: TriageState;
  justification: string | null;
  updatedAt: Date | null;
  updatedBy: { id: string; name: string } | null;
}

export interface FindingSummaryDto {
  id: string;
  fingerprint: string;
  scanJobId: string;
  target: { id: string; label: string; origin: string };
  detectorId: string;
  name: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  cwe: string | null;
  owaspCategory: string | null;
  affectedUrl: string;
  affectedParameter: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  occurrenceCount: number;
  createdAt: Date;
  /** Null when the orchestrator recorded no comparison for this scan. */
  diffStatus: ComparisonStatus | null;
  triage: FindingTriageDto;
}

export type EvidenceDto =
  | { status: "NONE" }
  | { status: "PURGED"; purgedAt: Date | null }
  | { status: "WITHHELD_ROLE" | "WITHHELD_UNREDACTED"; expiresAt: Date }
  | {
      status: "AVAILABLE";
      expiresAt: Date;
      redactionVersion: number;
      requestHeaders: unknown;
      requestBody: string | null;
      responseHeaders: unknown;
      responseBody: string | null;
      curlCommand: string | null;
      extractedSnippet: string | null;
    };

export interface TriageHistoryEntryDto {
  id: string;
  state: TriageState;
  justification: string | null;
  createdAt: Date;
  user: { id: string; name: string } | null;
}

export interface FindingDetailDto extends FindingSummaryDto {
  description: string;
  remediation: string;
  cvssVector: string | null;
  cveId: string | null;
  epssPercentile: number | null;
  advisoryData: unknown;
  occurrences: unknown;
  scan: {
    id: string;
    status: ScanStatus;
    profile: ScanProfile;
    completedAt: Date | null;
  };
  /** When the fingerprint was first and last written for this target. */
  seen: { first: Date; last: Date; scans: number };
  evidence: EvidenceDto;
  triageHistory: TriageHistoryEntryDto[];
}

const TARGET_SELECT = { id: true, label: true, origin: true } as const;

const SUMMARY_SELECT = {
  id: true,
  fingerprint: true,
  scanJobId: true,
  targetId: true,
  detectorId: true,
  name: true,
  severity: true,
  confidence: true,
  cwe: true,
  owaspCategory: true,
  affectedUrl: true,
  affectedParameter: true,
  cvssScore: true,
  epssScore: true,
  occurrenceCount: true,
  createdAt: true,
  target: { select: TARGET_SELECT },
} as const satisfies Prisma.FindingSelect;

type SummaryRow = Prisma.FindingGetPayload<{ select: typeof SUMMARY_SELECT }>;

const UNTRIAGED: FindingTriageDto = {
  state: "OPEN",
  justification: null,
  updatedAt: null,
  updatedBy: null,
};

function pairKey(targetId: string, fingerprint: string): string {
  return `${targetId}\u0000${fingerprint}`;
}

/** Current triage for a set of findings, keyed by `(target, fingerprint)`. */
async function loadTriage(
  rows: { targetId: string; fingerprint: string }[],
): Promise<Map<string, FindingTriageDto>> {
  if (rows.length === 0) return new Map();
  const projection = await prisma.targetFindingTriage.findMany({
    where: {
      targetId: { in: [...new Set(rows.map((row) => row.targetId))] },
      findingFingerprint: {
        in: [...new Set(rows.map((row) => row.fingerprint))],
      },
    },
    include: { updatedBy: { select: { id: true, name: true } } },
  });
  return new Map(
    projection.map((row) => [
      pairKey(row.targetId, row.findingFingerprint),
      {
        state: row.state,
        justification: row.justification,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      },
    ]),
  );
}

/** Diff status for a set of findings, keyed by `(scan, fingerprint)`. */
async function loadDiffs(
  rows: { scanJobId: string; fingerprint: string }[],
): Promise<Map<string, ComparisonStatus>> {
  if (rows.length === 0) return new Map();
  const diffs = await prisma.scanFindingDiff.findMany({
    where: {
      scanJobId: { in: [...new Set(rows.map((row) => row.scanJobId))] },
      fingerprint: { in: [...new Set(rows.map((row) => row.fingerprint))] },
    },
    select: { scanJobId: true, fingerprint: true, status: true },
  });
  return new Map(
    diffs.map((row) => [pairKey(row.scanJobId, row.fingerprint), row.status]),
  );
}

async function toSummaries(rows: SummaryRow[]): Promise<FindingSummaryDto[]> {
  const [triage, diffs] = await Promise.all([loadTriage(rows), loadDiffs(rows)]);
  return rows.map((row) => ({
    id: row.id,
    fingerprint: row.fingerprint,
    scanJobId: row.scanJobId,
    target: row.target,
    detectorId: row.detectorId,
    name: row.name,
    severity: row.severity,
    confidence: row.confidence,
    cwe: row.cwe,
    owaspCategory: row.owaspCategory,
    affectedUrl: row.affectedUrl,
    affectedParameter: row.affectedParameter,
    cvssScore: row.cvssScore,
    epssScore: row.epssScore,
    occurrenceCount: row.occurrenceCount,
    createdAt: row.createdAt,
    diffStatus: diffs.get(pairKey(row.scanJobId, row.fingerprint)) ?? null,
    triage: triage.get(pairKey(row.targetId, row.fingerprint)) ?? UNTRIAGED,
  }));
}

// -------------------------------------------------------------------- list ---

interface FindingScope {
  scanIds: string[];
  targetIds: string[];
}

/**
 * The scans a list reads from: one named scan, or the current posture, which
 * is each target's most recent COMPLETED scan. Archived targets are retired, so
 * they leave the posture unless asked for by name.
 */
async function resolveScope(
  ctx: AuthContext,
  query: FindingListQuery,
): Promise<FindingScope | "SCAN_NOT_FOUND"> {
  if (query.scanId) {
    const scan = await prisma.scanJob.findFirst({
      where: { id: query.scanId, organizationId: ctx.organizationId },
      select: { id: true, targetId: true },
    });
    if (!scan) return "SCAN_NOT_FOUND";
    if (query.targetId && query.targetId !== scan.targetId) {
      return { scanIds: [], targetIds: [] };
    }
    return { scanIds: [scan.id], targetIds: [scan.targetId] };
  }

  const latest = await prisma.scanJob.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "COMPLETED",
      ...(query.targetId
        ? { targetId: query.targetId }
        : { target: { isArchived: false } }),
    },
    orderBy: [{ targetId: "asc" }, { completedAt: "desc" }, { id: "desc" }],
    distinct: ["targetId"],
    select: { id: true, targetId: true },
  });
  return {
    scanIds: latest.map((scan) => scan.id),
    targetIds: latest.map((scan) => scan.targetId),
  };
}

/** `{ targetId, fingerprint in [...] }` per target, for a set of pairs. */
function byTarget(
  pairs: { targetId: string; findingFingerprint: string }[],
): Prisma.FindingWhereInput[] {
  const grouped = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = grouped.get(pair.targetId) ?? [];
    list.push(pair.findingFingerprint);
    grouped.set(pair.targetId, list);
  }
  return [...grouped].map(([targetId, fingerprints]) => ({
    targetId,
    fingerprint: { in: fingerprints },
  }));
}

/**
 * Filter by triage state through the projection.
 *
 * Untriaged fingerprints have no projection row and count as OPEN, so a filter
 * that includes OPEN excludes the rows in other states rather than including
 * the rows in the requested ones. Returns null when nothing can match.
 */
async function triageFilter(
  targetIds: string[],
  states: TriageState[],
): Promise<Prisma.FindingWhereInput | null> {
  if (states.length === TRIAGE_STATES.length) return {};

  if (states.includes("OPEN")) {
    const excluded = await prisma.targetFindingTriage.findMany({
      where: { targetId: { in: targetIds }, state: { notIn: states } },
      select: { targetId: true, findingFingerprint: true },
    });
    return excluded.length === 0 ? {} : { NOT: { OR: byTarget(excluded) } };
  }

  const included = await prisma.targetFindingTriage.findMany({
    where: { targetId: { in: targetIds }, state: { in: states } },
    select: { targetId: true, findingFingerprint: true },
  });
  return included.length === 0 ? null : { OR: byTarget(included) };
}

async function diffFilter(
  scanIds: string[],
  statuses: ComparisonStatus[],
): Promise<Prisma.FindingWhereInput | null> {
  const diffs = await prisma.scanFindingDiff.findMany({
    where: { scanJobId: { in: scanIds }, status: { in: statuses } },
    select: { scanJobId: true, fingerprint: true },
  });
  if (diffs.length === 0) return null;

  const grouped = new Map<string, string[]>();
  for (const diff of diffs) {
    const list = grouped.get(diff.scanJobId) ?? [];
    list.push(diff.fingerprint);
    grouped.set(diff.scanJobId, list);
  }
  return {
    OR: [...grouped].map(([scanJobId, fingerprints]) => ({
      scanJobId,
      fingerprint: { in: fingerprints },
    })),
  };
}

/**
 * Filters held outside the finding row: triage state in the projection, diff
 * status in the scan comparison. Null when nothing can match.
 */
async function stateConditions(
  scope: FindingScope,
  query: FindingListQuery,
): Promise<Prisma.FindingWhereInput[] | null> {
  const [triage, diff] = await Promise.all([
    query.triageStates ? triageFilter(scope.targetIds, query.triageStates) : {},
    query.diffStatuses ? diffFilter(scope.scanIds, query.diffStatuses) : {},
  ]);
  return triage && diff ? [triage, diff] : null;
}

/** Filters on the finding row's own columns. */
function columnConditions(query: FindingListQuery): Prisma.FindingWhereInput[] {
  const conditions: Prisma.FindingWhereInput[] = [];
  if (query.severities) conditions.push({ severity: { in: query.severities } });
  if (query.confidences) {
    conditions.push({ confidence: { in: query.confidences } });
  }
  if (query.detectorId) conditions.push({ detectorId: query.detectorId });
  if (query.owaspCategory) {
    conditions.push({ owaspCategory: query.owaspCategory });
  }
  if (query.search) {
    conditions.push({
      OR: [
        { name: { contains: query.search, mode: "insensitive" } },
        { affectedUrl: { contains: query.search, mode: "insensitive" } },
      ],
    });
  }
  return conditions;
}

export interface FindingListResult {
  findings: FindingSummaryDto[];
  nextCursor: string | null;
}

const EMPTY: FindingListResult = { findings: [], nextCursor: null };

export async function listFindings(
  ctx: AuthContext,
  query: FindingListQuery,
): Promise<FindingListResult | "SCAN_NOT_FOUND"> {
  const scope = await resolveScope(ctx, query);
  if (scope === "SCAN_NOT_FOUND") return scope;
  if (scope.scanIds.length === 0) return EMPTY;

  const stateFilters = await stateConditions(scope, query);
  if (!stateFilters) return EMPTY;

  const conditions: Prisma.FindingWhereInput[] = [
    { scanJobId: { in: scope.scanIds } },
    ...stateFilters,
    ...columnConditions(query),
  ];
  if (query.cursor) conditions.push(findingsAfter(query.cursor));

  const rows = await prisma.finding.findMany({
    where: { AND: conditions },
    orderBy: findingOrderBy(query.sort, query.direction),
    take: query.limit + 1,
    select: SUMMARY_SELECT,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    findings: await toSummaries(page),
    nextCursor: hasMore
      ? encodeFindingCursor(page[page.length - 1]!, query.sort, query.direction)
      : null,
  };
}

// ---------------------------------------------------- resolved since last ---

/**
 * The findings a scan no longer saw: fingerprints its diff marks RESOLVED,
 * each shown as the most recent earlier row for that fingerprint, since the
 * resolving scan wrote no row of its own.
 */
export async function listResolvedSince(
  ctx: AuthContext,
  scanId: string,
): Promise<FindingSummaryDto[] | "SCAN_NOT_FOUND"> {
  const scan = await prisma.scanJob.findFirst({
    where: { id: scanId, organizationId: ctx.organizationId },
    select: { id: true, targetId: true, createdAt: true },
  });
  if (!scan) return "SCAN_NOT_FOUND";

  const resolved = await prisma.scanFindingDiff.findMany({
    where: { scanJobId: scan.id, status: "RESOLVED" },
    select: { fingerprint: true },
  });
  if (resolved.length === 0) return [];

  const rows = await prisma.finding.findMany({
    where: {
      targetId: scan.targetId,
      fingerprint: { in: resolved.map((diff) => diff.fingerprint) },
      scanJob: { createdAt: { lt: scan.createdAt } },
    },
    orderBy: [{ fingerprint: "asc" }, { createdAt: "desc" }],
    distinct: ["fingerprint"],
    select: SUMMARY_SELECT,
  });

  const summaries = await toSummaries(rows);
  return summaries
    .map((summary) => ({ ...summary, diffStatus: "RESOLVED" as const }))
    .sort(bySeverityThenName);
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

function bySeverityThenName(a: FindingSummaryDto, b: FindingSummaryDto): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.name.localeCompare(b.name)
  );
}

// ------------------------------------------------------------------ detail ---

type FindingForOrg = Finding & {
  target: Pick<Target, "id" | "label" | "origin">;
  scanJob: Pick<ScanJob, "id" | "status" | "profile" | "completedAt">;
  evidence: FindingEvidence | null;
};

export async function findFindingForOrg(
  ctx: AuthContext,
  findingId: string,
): Promise<FindingForOrg | null> {
  return prisma.finding.findFirst({
    where: { id: findingId, target: { organizationId: ctx.organizationId } },
    include: {
      target: { select: TARGET_SELECT },
      scanJob: {
        select: { id: true, status: true, profile: true, completedAt: true },
      },
      evidence: true,
    },
  });
}

/**
 * Raw evidence is shown only when redaction is confirmed, and never to VIEWER
 * (ADR-0010). Both are enforced here rather than left to the dashboard.
 */
export function presentEvidence(
  evidence: FindingEvidence | null,
  role: string,
): EvidenceDto {
  if (!evidence) return { status: "NONE" };
  if (evidence.isPurged) return { status: "PURGED", purgedAt: evidence.purgedAt };
  if (role === "VIEWER") {
    return { status: "WITHHELD_ROLE", expiresAt: evidence.expiresAt };
  }
  if (!evidence.isRedacted) {
    return { status: "WITHHELD_UNREDACTED", expiresAt: evidence.expiresAt };
  }
  return {
    status: "AVAILABLE",
    expiresAt: evidence.expiresAt,
    redactionVersion: evidence.redactionVersion,
    requestHeaders: evidence.requestHeaders,
    requestBody: evidence.requestBody,
    responseHeaders: evidence.responseHeaders,
    responseBody: evidence.responseBody,
    curlCommand: evidence.curlCommand,
    extractedSnippet: evidence.extractedSnippet,
  };
}

export async function listTriageHistory(
  targetId: string,
  fingerprint: string,
): Promise<TriageHistoryEntryDto[]> {
  const history = await prisma.findingTriageHistory.findMany({
    where: { targetId, findingFingerprint: fingerprint },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  // History has no foreign keys (ADR-0002), so a deleted user leaves an id
  // that resolves to nobody rather than a broken row.
  const userIds = [
    ...new Set(history.flatMap((entry) => (entry.userId ? [entry.userId] : []))),
  ];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const byId = new Map(users.map((user) => [user.id, user]));

  return history.map((entry) => ({
    id: entry.id,
    state: entry.state,
    justification: entry.justification,
    createdAt: entry.createdAt,
    user: entry.userId ? (byId.get(entry.userId) ?? null) : null,
  }));
}

export async function getFindingDetail(
  ctx: AuthContext,
  findingId: string,
): Promise<FindingDetailDto | null> {
  const finding = await findFindingForOrg(ctx, findingId);
  if (!finding) return null;

  const [[summary], seen, triageHistory] = await Promise.all([
    toSummaries([finding]),
    prisma.finding.aggregate({
      where: { targetId: finding.targetId, fingerprint: finding.fingerprint },
      _min: { createdAt: true },
      _max: { createdAt: true },
      _count: { _all: true },
    }),
    listTriageHistory(finding.targetId, finding.fingerprint),
  ]);

  return {
    ...summary!,
    description: finding.description,
    remediation: finding.remediation,
    cvssVector: finding.cvssVector,
    cveId: finding.cveId,
    epssPercentile: finding.epssPercentile,
    advisoryData: finding.advisoryData,
    occurrences: finding.occurrences,
    scan: finding.scanJob,
    seen: {
      first: seen._min.createdAt ?? finding.createdAt,
      last: seen._max.createdAt ?? finding.createdAt,
      scans: seen._count._all,
    },
    evidence: presentEvidence(finding.evidence, ctx.role),
    triageHistory,
  };
}
