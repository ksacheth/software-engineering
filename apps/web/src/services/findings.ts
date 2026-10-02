import type {
  ComparisonStatus,
  FindingConfidence,
  FindingSeverity,
  ScanProfile,
  ScanStatus,
  TriageState,
} from "@wvs/shared";

/**
 * F.6 findings service.
 *
 * Follows the scans service conventions: plain async functions, same-origin
 * credentials, TanStack Query at the call sites, RFC 9457 problem details
 * surfaced with their field errors. The types mirror the API's DTOs.
 */

export type {
  ComparisonStatus,
  FindingConfidence,
  FindingSeverity,
  TriageState,
};

export interface FindingTriage {
  state: TriageState;
  justification: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}

export interface FindingSummary {
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
  createdAt: string;
  diffStatus: ComparisonStatus | null;
  triage: FindingTriage;
}

export type FindingEvidence =
  | { status: "NONE" }
  | { status: "PURGED"; purgedAt: string | null }
  | { status: "WITHHELD_ROLE" | "WITHHELD_UNREDACTED"; expiresAt: string }
  | {
      status: "AVAILABLE";
      expiresAt: string;
      redactionVersion: number;
      requestHeaders: unknown;
      requestBody: string | null;
      responseHeaders: unknown;
      responseBody: string | null;
      curlCommand: string | null;
      extractedSnippet: string | null;
    };

export interface TriageHistoryEntry {
  id: string;
  state: TriageState;
  justification: string | null;
  createdAt: string;
  user: { id: string; name: string } | null;
}

export interface FindingDetail extends FindingSummary {
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
    completedAt: string | null;
  };
  seen: { first: string; last: string; scans: number };
  evidence: FindingEvidence;
  triageHistory: TriageHistoryEntry[];
}

export const FINDING_SORTS = [
  "severity",
  "cvss",
  "epss",
  "name",
  "detected",
] as const;

export type FindingSort = (typeof FINDING_SORTS)[number];

export interface FindingFilters {
  /** Present: exactly that scan's findings. Absent: the current posture. */
  scanId?: string;
  targetId?: string;
  severities?: FindingSeverity[];
  confidence?: FindingConfidence;
  /** "all" lifts the default, which in the posture is OPEN and CONFIRMED. */
  triage?: TriageState | "all";
  diff?: ComparisonStatus;
  detectorId?: string;
  owaspCategory?: string;
  search?: string;
  sort?: FindingSort;
  direction?: "asc" | "desc";
}

export interface ProblemFieldError {
  pointer?: string;
  detail: string;
}

export class FindingApiError extends Error {
  status: number;
  errors?: ProblemFieldError[];

  constructor(status: number, message: string, errors?: ProblemFieldError[]) {
    super(message);
    this.name = "FindingApiError";
    this.status = status;
    this.errors = errors;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new FindingApiError(
      res.status,
      data?.errors?.[0]?.detail ||
        data?.detail ||
        data?.error ||
        `Request failed with status ${res.status}`,
      data?.errors,
    );
  }
  return data as T;
}

export function findingQueryString(
  filters: FindingFilters,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (filters.scanId) params.set("scanId", filters.scanId);
  if (filters.targetId) params.set("targetId", filters.targetId);
  if (filters.severities?.length) {
    params.set("severity", filters.severities.join(","));
  }
  if (filters.confidence) params.set("confidence", filters.confidence);
  if (filters.triage) params.set("triage", filters.triage);
  if (filters.diff) params.set("diff", filters.diff);
  if (filters.detectorId) params.set("detectorId", filters.detectorId);
  if (filters.owaspCategory) params.set("owaspCategory", filters.owaspCategory);
  if (filters.search) params.set("q", filters.search);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.direction) params.set("direction", filters.direction);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export async function fetchFindings(
  filters: FindingFilters,
  cursor?: string,
): Promise<{ findings: FindingSummary[]; nextCursor: string | null }> {
  const query = findingQueryString(filters, cursor);
  const res = await fetch(`/api/findings${query ? `?${query}` : ""}`, {
    credentials: "same-origin",
  });
  return handleResponse(res);
}

export async function fetchResolvedSince(
  scanId: string,
): Promise<{ findings: FindingSummary[] }> {
  const res = await fetch(
    `/api/findings/resolved?scanId=${encodeURIComponent(scanId)}`,
    { credentials: "same-origin" },
  );
  return handleResponse(res);
}

export async function fetchFinding(
  id: string,
): Promise<{ finding: FindingDetail }> {
  const res = await fetch(`/api/findings/${id}`, { credentials: "same-origin" });
  return handleResponse(res);
}

export interface TriageInput {
  state: TriageState;
  justification?: string;
}

export async function triageFinding(
  id: string,
  input: TriageInput,
): Promise<{ finding: FindingDetail; changed: boolean }> {
  const res = await fetch(`/api/findings/${id}/triage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
  });
  return handleResponse(res);
}

export async function triageFindings(
  findingIds: string[],
  input: TriageInput,
): Promise<{ updated: number; unchanged: number }> {
  const res = await fetch("/api/findings/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ findingIds, ...input }),
    credentials: "same-origin",
  });
  return handleResponse(res);
}
