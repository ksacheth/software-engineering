/**
 * F.7 reporting contract: the enums the API and the dashboard both speak.
 *
 * Duplicated from the Prisma enums, like the scan and findings contracts; the
 * API asserts the copies stay assignable (apps/api/src/modules/scans/enum-drift.ts).
 */

export const REPORT_TEMPLATES = ["EXECUTIVE_SUMMARY", "TECHNICAL_REPORT"] as const;

export type ReportTemplate = (typeof REPORT_TEMPLATES)[number];

export const REPORT_FORMATS = ["PDF", "HTML", "JSON", "CSV", "SARIF"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_STATUSES = ["QUEUED", "GENERATING", "READY", "FAILED"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Statuses a report can still leave without anyone acting on it. */
export const PENDING_REPORT_STATUSES: readonly ReportStatus[] = [
  "QUEUED",
  "GENERATING",
];

/** Share link lifetimes the API accepts, in days (ADR-0011). */
export const REPORT_SHARE_BOUNDS = { minDays: 1, maxDays: 30, defaultDays: 7 } as const;

/**
 * BullMQ queue for report generation (DC-4). No colon: BullMQ uses `:` as its
 * Redis key separator.
 */
export const REPORT_QUEUE_NAME = "wvs-reports";

/** The queue payload. The report row holds everything else. */
export interface ReportJobPayload {
  reportId: string;
}

export function isReportJobPayload(value: unknown): value is ReportJobPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).reportId === "string" &&
    ((value as Record<string, unknown>).reportId as string).length > 0
  );
}
