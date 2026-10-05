import type { FindingSeverity, ReportTemplate, ScanProfile } from "@wvs/shared";
import type { ReportDocument } from "../report-document";

/** Wording shared by every human-readable format, so they read the same. */

export const TEMPLATE_TITLES: Record<ReportTemplate, string> = {
  EXECUTIVE_SUMMARY: "Executive Summary",
  TECHNICAL_REPORT: "Technical Report",
};

export const PROFILE_LABELS: Record<ScanProfile, string> = {
  PASSIVE: "Passive",
  STANDARD: "Standard",
  THOROUGH: "Thorough",
};

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
};

/** Timestamps are UTC (DC-9), and say so. */
export function formatTimestamp(value: Date | null): string {
  if (!value) return "not recorded";
  return `${value.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function reportTitle(doc: ReportDocument): string {
  return `${TEMPLATE_TITLES[doc.report.template]}: ${doc.target.label}`;
}

/** One sentence on the overall posture, for readers who stop there. */
export function postureStatement(doc: ReportDocument): string {
  const { actionable, highestActionable } = doc.summary;
  if (actionable === 0) {
    return "No findings in this report need action.";
  }
  const label = SEVERITY_LABELS[highestActionable!].toLowerCase();
  return (
    `${actionable} ${actionable === 1 ? "finding needs" : "findings need"} action; ` +
    `the most severe is ${label}.`
  );
}

export function scopeLines(doc: ReportDocument): [string, string][] {
  const { scope } = doc.scan;
  return [
    ["Included paths", scope.includedPaths.join(", ") || "Whole origin"],
    ["Excluded paths", scope.excludedPaths.join(", ") || "None"],
    ["Crawl depth limit", String(scope.maxDepth)],
    ["Page limit", String(scope.maxPages)],
    ["Request limit", String(scope.maxRequests)],
    ["Rate limit", `${scope.rateLimit} requests per second`],
  ];
}

/** The mandatory metadata, as label and value pairs (F.7). */
export function metadataLines(doc: ReportDocument): [string, string][] {
  return [
    ["Target", `${doc.target.label} (${doc.target.origin})`],
    ["Scan", doc.scan.id],
    ["Profile", PROFILE_LABELS[doc.scan.profile]],
    ["Queued", formatTimestamp(doc.scan.queuedAt)],
    ["Started", formatTimestamp(doc.scan.startedAt)],
    ["Completed", formatTimestamp(doc.scan.completedAt)],
    ["Pages crawled", String(doc.scan.pagesCrawled)],
    ["Requests made", String(doc.scan.requestsMade)],
    ...scopeLines(doc),
    ["Detector versions", detectorVersionsText(doc)],
    ["Report generated", formatTimestamp(doc.report.generatedAt)],
  ];
}

export function detectorVersionsText(doc: ReportDocument): string {
  if (doc.scan.detectorVersions.length === 0) return "Not recorded";
  return doc.scan.detectorVersions
    .map((entry) => `${entry.detectorId} ${entry.version}`)
    .join(", ");
}

export function locationText(finding: {
  affectedUrl: string;
  affectedParameter: string | null;
}): string {
  return finding.affectedParameter
    ? `${finding.affectedUrl} (parameter: ${finding.affectedParameter})`
    : finding.affectedUrl;
}

/** Evidence headers are stored as JSON; render them as `Name: value` lines. */
export function headerLines(headers: unknown): string[] {
  if (Array.isArray(headers)) {
    return headers.map((entry) =>
      Array.isArray(entry) && entry.length === 2
        ? `${String(entry[0])}: ${String(entry[1])}`
        : JSON.stringify(entry),
    );
  }
  if (typeof headers === "object" && headers !== null) {
    return Object.entries(headers as Record<string, unknown>).map(
      ([name, value]) =>
        `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  return [];
}

export const EVIDENCE_STATUS_TEXT = {
  NONE: "No evidence was recorded for this finding.",
  PURGED: "Evidence was purged under the retention policy.",
  WITHHELD_ROLE:
    "Evidence is withheld: the report's author is not permitted to read raw evidence.",
  WITHHELD_UNREDACTED:
    "Evidence is withheld: its redaction has not been confirmed.",
} as const;
