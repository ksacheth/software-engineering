import type { ReportFormat, ReportTemplate } from "@wvs/shared";

export const TEMPLATE_LABELS: Record<ReportTemplate, string> = {
  EXECUTIVE_SUMMARY: "Executive Summary",
  TECHNICAL_REPORT: "Technical Report",
};

export const TEMPLATE_DESCRIPTIONS: Record<ReportTemplate, string> = {
  EXECUTIVE_SUMMARY:
    "Posture, severity distribution and trend for a non-technical reader. Never includes raw evidence.",
  TECHNICAL_REPORT:
    "Every finding with its description, remediation and evidence, for the people fixing them.",
};

export const FORMAT_DESCRIPTIONS: Record<ReportFormat, string> = {
  PDF: "PDF, for reading and sending",
  HTML: "HTML, a self-contained page",
  JSON: "JSON, for scripts and integrations",
  CSV: "CSV, for spreadsheets",
  SARIF: "SARIF 2.1.0, for GitHub code scanning",
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
