import {
  SEVERITIES_DESCENDING,
  type ReportDocument,
  type ReportFinding,
} from "../report-document";
import {
  EVIDENCE_STATUS_TEXT,
  formatTimestamp,
  metadataLines,
  reportTitle,
  SEVERITY_LABELS,
} from "./labels";

/**
 * CSV export (RFC 4180).
 *
 * The file opens with the mandatory metadata and limitations as label/value
 * rows, then a blank row, then the tables. A spreadsheet shows all of it, and
 * a consumer after the findings alone skips to the row that starts with the
 * findings header.
 */

/**
 * A cell a spreadsheet would evaluate is defused with a leading apostrophe.
 * URLs, parameter names and evidence come from the scanned site, so a target
 * that wants to run a formula on the reader's machine controls them.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

const SUMMARY_COLUMNS = [
  "Severity",
  "Name",
  "Location",
  "Parameter",
  "Confidence",
  "CWE",
  "OWASP category",
  "CVSS",
  "Occurrences",
  "Compared with previous scan",
  "Triage state",
  "Detector",
  "Fingerprint",
];

const TECHNICAL_COLUMNS = [
  ...SUMMARY_COLUMNS,
  "Triage justification",
  "CVSS vector",
  "CVE",
  "EPSS",
  "Description",
  "Remediation",
  "Evidence",
  "Curl command",
  "Extracted snippet",
];

function summaryCells(finding: ReportFinding) {
  return [
    SEVERITY_LABELS[finding.severity],
    finding.name,
    finding.affectedUrl,
    finding.affectedParameter,
    finding.confidence,
    finding.cwe,
    finding.owaspCategory,
    finding.cvssScore,
    finding.occurrenceCount,
    finding.diffStatus,
    finding.triage.state,
    finding.detectorId,
    finding.fingerprint,
  ];
}

function evidenceCells(finding: ReportFinding) {
  const evidence = finding.evidence;
  if (!evidence || evidence.status === "NONE") {
    return [EVIDENCE_STATUS_TEXT.NONE, null, null];
  }
  if (evidence.status !== "AVAILABLE") {
    return [EVIDENCE_STATUS_TEXT[evidence.status], null, null];
  }
  return ["Available", evidence.curlCommand, evidence.extractedSnippet];
}

function technicalCells(finding: ReportFinding) {
  return [
    ...summaryCells(finding),
    finding.triage.justification,
    finding.cvssVector,
    finding.cveId,
    finding.epssScore,
    finding.description,
    finding.remediation,
    ...evidenceCells(finding),
  ];
}

function executiveTables(doc: ReportDocument): string[] {
  const lines = [row(["Severity", "Findings"])];
  for (const severity of SEVERITIES_DESCENDING) {
    lines.push(row([SEVERITY_LABELS[severity], doc.summary.bySeverity[severity]]));
  }
  lines.push("");
  lines.push(
    row([
      "Scan",
      "Completed",
      ...SEVERITIES_DESCENDING.map((s) => SEVERITY_LABELS[s]),
      "Total",
    ]),
  );
  for (const point of doc.trend) {
    lines.push(
      row([
        point.scanId,
        formatTimestamp(point.completedAt),
        ...SEVERITIES_DESCENDING.map((s) => point.bySeverity[s]),
        point.total,
      ]),
    );
  }
  lines.push("");
  return lines;
}

export function renderCsv(doc: ReportDocument): Buffer {
  const technical = doc.report.template === "TECHNICAL_REPORT";
  const lines: string[] = [row(["Report", reportTitle(doc)])];
  for (const [label, value] of metadataLines(doc)) lines.push(row([label, value]));
  for (const limitation of doc.coverageLimitations) {
    lines.push(row(["Coverage limitation", limitation]));
  }
  lines.push("");

  if (!technical) lines.push(...executiveTables(doc));

  lines.push(row(technical ? TECHNICAL_COLUMNS : SUMMARY_COLUMNS));
  for (const finding of doc.findings) {
    lines.push(row(technical ? technicalCells(finding) : summaryCells(finding)));
  }

  // RFC 4180 line endings, and a BOM so spreadsheets read the file as UTF-8.
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}
