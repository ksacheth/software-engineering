import type { FindingSeverity } from "@wvs/shared";
import { escapeHtml } from "../../../lib/email";
import {
  SEVERITIES_DESCENDING,
  type ReportDocument,
  type ReportFinding,
} from "../report-document";
import {
  EVIDENCE_STATUS_TEXT,
  formatTimestamp,
  headerLines,
  locationText,
  metadataLines,
  postureStatement,
  reportTitle,
  SEVERITY_LABELS,
} from "./labels";

/**
 * HTML export: one self-contained file, no scripts, no external requests.
 *
 * Everything that came from the scanned site is escaped. The file is served as
 * an attachment under a sandbox policy as well (reports.routes.ts), because a
 * report is mostly target-controlled text.
 *
 * Severity is carried by label and shape as well as colour (SRS 3.2.1).
 */

const SEVERITY_STYLE: Record<FindingSeverity, { colour: string; shape: string }> = {
  CRITICAL: { colour: "#9f1239", shape: "&#9650;" }, // triangle
  HIGH: { colour: "#c2410c", shape: "&#9670;" }, // diamond
  MEDIUM: { colour: "#a16207", shape: "&#9632;" }, // square
  LOW: { colour: "#1d4ed8", shape: "&#9679;" }, // circle
  INFO: { colour: "#475569", shape: "&#9675;" }, // ring
};

const STYLES = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;margin:0;line-height:1.5}
main{max-width:960px;margin:0 auto;padding:32px 24px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 12px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
h3{font-size:16px;margin:0}
.muted{color:#475569}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
th{background:#f8fafc;font-weight:600}
.meta th{width:200px}
.limitations{background:#fff7ed;border:1px solid #fdba74;border-radius:6px;padding:12px 16px}
.limitations li{margin:4px 0}
.badge{display:inline-block;font-weight:600;font-size:12px;padding:1px 8px;border-radius:999px;color:#fff;white-space:nowrap}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0}
.bar .label{width:110px}.bar .track{flex:1;background:#f1f5f9;height:14px;border-radius:3px}
.bar .fill{height:14px;border-radius:3px}
.finding{border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin:12px 0;break-inside:avoid}
.finding dl{display:grid;grid-template-columns:180px 1fr;gap:2px 12px;font-size:14px;margin:8px 0}
.finding dt{color:#475569}.finding dd{margin:0;word-break:break-all}
pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:none}
@media print{main{padding:0}pre{max-height:none}}
`;

function esc(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : escapeHtml(String(value));
}

function badge(severity: FindingSeverity): string {
  const style = SEVERITY_STYLE[severity];
  return `<span class="badge" style="background:${style.colour}"><span aria-hidden="true">${style.shape}</span> ${SEVERITY_LABELS[severity]}</span>`;
}

function metadataTable(doc: ReportDocument): string {
  const rows = metadataLines(doc)
    .map(([label, value]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(value)}</td></tr>`)
    .join("");
  return `<h2>About this report</h2><table class="meta">${rows}</table>`;
}

function limitationsSection(doc: ReportDocument): string {
  const items = doc.coverageLimitations.map((line) => `<li>${esc(line)}</li>`).join("");
  return `<h2>Coverage limitations</h2><section class="limitations"><ul>${items}</ul></section>`;
}

function distribution(doc: ReportDocument): string {
  const max = Math.max(1, ...Object.values(doc.summary.bySeverity));
  const bars = SEVERITIES_DESCENDING.map((severity) => {
    const count = doc.summary.bySeverity[severity];
    const width = Math.round((count / max) * 100);
    return (
      `<div class="bar"><span class="label">${badge(severity)}</span>` +
      `<span class="track"><span class="fill" style="display:block;width:${width}%;background:${SEVERITY_STYLE[severity].colour}"></span></span>` +
      `<span>${count}</span></div>`
    );
  }).join("");
  return `<h2>Severity distribution</h2>${bars}`;
}

function comparison(doc: ReportDocument): string {
  const diff = doc.summary.diff;
  if (!diff) {
    return `<p class="muted">No comparison with an earlier scan was recorded.</p>`;
  }
  return (
    `<p>Compared with the previous scan: <strong>${diff.NEW}</strong> new, ` +
    `<strong>${diff.PERSISTING}</strong> persisting, <strong>${diff.RESOLVED}</strong> resolved.</p>`
  );
}

function trendTable(doc: ReportDocument): string {
  const head = SEVERITIES_DESCENDING.map((s) => `<th scope="col">${SEVERITY_LABELS[s]}</th>`).join("");
  const rows = doc.trend
    .map((point) => {
      const cells = SEVERITIES_DESCENDING.map((s) => `<td>${point.bySeverity[s]}</td>`).join("");
      const current = point.scanId === doc.scan.id ? " (this scan)" : "";
      return `<tr><td>${esc(formatTimestamp(point.completedAt))}${current}</td>${cells}<td>${point.total}</td></tr>`;
    })
    .join("");
  return (
    `<h2>Trend</h2><p class="muted">Findings per completed scan of this target, at the report's severity threshold, regardless of triage.</p>` +
    `<table><thead><tr><th scope="col">Completed</th>${head}<th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table>`
  );
}

function findingTable(findings: ReportFinding[]): string {
  if (findings.length === 0) return `<p>No findings match this report's filters.</p>`;
  const rows = findings
    .map(
      (f) =>
        `<tr><td>${badge(f.severity)}</td><td>${esc(f.name)}</td><td>${esc(locationText(f))}</td><td>${esc(f.triage.state)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col">Location</th><th scope="col">Triage</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function executiveBody(doc: ReportDocument): string {
  return [
    `<h2>Posture</h2><p><strong>${esc(postureStatement(doc))}</strong> ` +
      `${doc.summary.total} ${doc.summary.total === 1 ? "finding" : "findings"} in total.</p>`,
    comparison(doc),
    distribution(doc),
    trendTable(doc),
    `<h2>Findings</h2>`,
    findingTable(doc.findings),
  ].join("");
}

function evidenceBlock(finding: ReportFinding): string {
  const evidence = finding.evidence;
  if (!evidence || evidence.status === "NONE") return `<p class="muted">${EVIDENCE_STATUS_TEXT.NONE}</p>`;
  if (evidence.status !== "AVAILABLE") {
    return `<p class="muted">${EVIDENCE_STATUS_TEXT[evidence.status]}</p>`;
  }
  const request = [...headerLines(evidence.requestHeaders), "", evidence.requestBody ?? ""].join("\n");
  const response = [...headerLines(evidence.responseHeaders), "", evidence.responseBody ?? ""].join("\n");
  return [
    `<h4>Evidence</h4>`,
    evidence.extractedSnippet ? `<p>Extracted snippet</p><pre>${esc(evidence.extractedSnippet)}</pre>` : "",
    evidence.curlCommand ? `<p>Reproduce</p><pre>${esc(evidence.curlCommand)}</pre>` : "",
    `<p>Request</p><pre>${esc(request.trim())}</pre>`,
    `<p>Response</p><pre>${esc(response.trim())}</pre>`,
  ].join("");
}

function findingDetail(finding: ReportFinding): string {
  const facts: [string, string | number | null][] = [
    ["Location", locationText(finding)],
    ["Confidence", finding.confidence],
    ["CWE", finding.cwe],
    ["OWASP category", finding.owaspCategory],
    ["CVSS", finding.cvssScore !== null ? `${finding.cvssScore} ${finding.cvssVector ?? ""}`.trim() : null],
    ["CVE", finding.cveId],
    ["EPSS", finding.epssScore],
    ["Occurrences", finding.occurrenceCount],
    ["Compared with previous scan", finding.diffStatus],
    ["Triage", finding.triage.justification ? `${finding.triage.state}: ${finding.triage.justification}` : finding.triage.state],
    ["Detector", finding.detectorId],
    ["Fingerprint", finding.fingerprint],
  ];
  const dl = facts
    .filter(([, value]) => value !== null && value !== "")
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`)
    .join("");
  return (
    `<article class="finding"><h3>${badge(finding.severity)} ${esc(finding.name)}</h3><dl>${dl}</dl>` +
    `<h4>Description</h4><p>${esc(finding.description)}</p>` +
    `<h4>Remediation</h4><p>${esc(finding.remediation)}</p>${evidenceBlock(finding)}</article>`
  );
}

function technicalBody(doc: ReportDocument): string {
  return [
    `<h2>Summary</h2><p><strong>${esc(postureStatement(doc))}</strong></p>`,
    comparison(doc),
    distribution(doc),
    `<h2>Findings (${doc.findings.length})</h2>`,
    doc.findings.length === 0
      ? `<p>No findings match this report's filters.</p>`
      : doc.findings.map(findingDetail).join(""),
  ].join("");
}

export function renderHtml(doc: ReportDocument): Buffer {
  const title = reportTitle(doc);
  const body =
    doc.report.template === "EXECUTIVE_SUMMARY" ? executiveBody(doc) : technicalBody(doc);
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // No network access and no script, whatever ends up in the body.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${esc(title)}</title><style>${STYLES}</style></head><body><main>`,
    `<h1>${esc(title)}</h1>`,
    `<p class="muted">${esc(doc.target.origin)} &middot; generated ${esc(formatTimestamp(doc.report.generatedAt))}</p>`,
    limitationsSection(doc),
    body,
    metadataTable(doc),
    "</main></body></html>",
  ].join("");
  return Buffer.from(html, "utf8");
}
