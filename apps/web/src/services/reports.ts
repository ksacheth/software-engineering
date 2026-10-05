import type {
  FindingSeverity,
  ReportFormat,
  ReportStatus,
  ReportTemplate,
  TriageState,
} from "@wvs/shared";

/**
 * F.7 reports service.
 *
 * Follows the scans and findings service conventions: plain async functions,
 * same-origin credentials, TanStack Query at the call sites, RFC 9457 problem
 * details surfaced with their `code`. The types mirror the API's DTOs.
 */

export type { ReportFormat, ReportStatus, ReportTemplate };

export interface Report {
  id: string;
  scan: {
    id: string;
    completedAt: string | null;
    target: { id: string; label: string; origin: string };
  };
  template: ReportTemplate;
  format: ReportFormat;
  status: ReportStatus;
  failureReason: string | null;
  fileSize: number | null;
  filters: { minSeverity: FindingSeverity | null; triageStates: TriageState[] };
  coverageLimitations: string[] | null;
  includesEvidence: boolean;
  expiresAt: string | null;
  expired: boolean;
  share: { active: boolean; expiresAt: string | null };
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ProblemFieldError {
  pointer?: string;
  detail: string;
}

export class ReportApiError extends Error {
  status: number;
  code?: string;
  errors?: ProblemFieldError[];

  constructor(
    status: number,
    message: string,
    options: { code?: string; errors?: ProblemFieldError[] } = {},
  ) {
    super(message);
    this.name = "ReportApiError";
    this.status = status;
    this.code = options.code;
    this.errors = options.errors;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ReportApiError(
      res.status,
      data?.errors?.[0]?.detail ||
        data?.detail ||
        data?.error ||
        `Request failed with status ${res.status}`,
      { code: data?.code, errors: data?.errors },
    );
  }
  return data as T;
}

export interface CreateReportInput {
  scanId: string;
  template: ReportTemplate;
  format: ReportFormat;
  minSeverity?: FindingSeverity;
  triageStates?: TriageState[];
}

export async function createReport(
  input: CreateReportInput,
): Promise<{ report: Report }> {
  const res = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
  });
  return handleResponse(res);
}

export async function fetchReports(
  scanId?: string,
): Promise<{ reports: Report[] }> {
  const query = scanId ? `?scanId=${encodeURIComponent(scanId)}` : "";
  const res = await fetch(`/api/reports${query}`, { credentials: "same-origin" });
  return handleResponse(res);
}

/** Same-origin, so a plain link downloads it with the session cookie. */
export function reportDownloadUrl(id: string): string {
  return `/api/reports/${encodeURIComponent(id)}/download`;
}

export async function shareReport(
  id: string,
  expiresInDays: number,
): Promise<{ report: Report; sharePath: string }> {
  const res = await fetch(`/api/reports/${encodeURIComponent(id)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInDays }),
    credentials: "same-origin",
  });
  return handleResponse(res);
}

export async function revokeReportShare(id: string): Promise<{ report: Report }> {
  const res = await fetch(`/api/reports/${encodeURIComponent(id)}/share`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  return handleResponse(res);
}
