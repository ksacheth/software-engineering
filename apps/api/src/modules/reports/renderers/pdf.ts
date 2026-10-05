import PDFDocument from "pdfkit";
import type { FindingSeverity } from "@wvs/shared";
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
 * PDF export, drawn with pdfkit's built-in fonts so it needs no browser and no
 * font files (C.4).
 *
 * Severity is a drawn shape plus its label as well as a colour (SRS 3.2.1).
 * The built-in fonts only cover Latin-1, so other characters are replaced
 * rather than rendered as the wrong glyph. Evidence bodies are cut shorter
 * than in the other formats to keep a 500-finding report inside NFR-PERF-2's
 * 60 seconds; the cut is stated where it happens.
 */

export const PDF_EVIDENCE_LIMIT = 2_000;

const MARGIN = 50;
const COLOURS: Record<FindingSeverity, string> = {
  CRITICAL: "#9f1239",
  HIGH: "#c2410c",
  MEDIUM: "#a16207",
  LOW: "#1d4ed8",
  INFO: "#475569",
};
const TEXT = "#0f172a";
const MUTED = "#475569";

/** Map text onto what the standard fonts can draw (WinAnsi, roughly Latin-1). */
export function pdfSafe(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\n\t\x20-\x7E\xA0-\xFF]/g, "?");
}

function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[cut: ${value.length - limit} more characters; the HTML and JSON exports carry more]`;
}

type Doc = PDFKit.PDFDocument;

function contentWidth(pdf: Doc): number {
  return pdf.page.width - MARGIN * 2;
}

function ensureSpace(pdf: Doc, height: number): void {
  if (pdf.y + height > pdf.page.height - MARGIN - 20) pdf.addPage();
}

function heading(pdf: Doc, text: string): void {
  ensureSpace(pdf, 60);
  pdf.moveDown(0.8);
  pdf.font("Helvetica-Bold").fontSize(14).fillColor(TEXT).text(pdfSafe(text), MARGIN);
  const y = pdf.y + 2;
  pdf.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(pdf), y).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
  pdf.moveDown(0.5);
}

function paragraph(pdf: Doc, text: string, options: { colour?: string; bold?: boolean; size?: number } = {}): void {
  pdf
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(options.size ?? 10)
    .fillColor(options.colour ?? TEXT)
    .text(pdfSafe(text), MARGIN, undefined, { width: contentWidth(pdf) });
}

const SHAPE_SIZE = 8;

/** A severity marker: the shape, filled in the severity's colour. */
function drawShape(pdf: Doc, severity: FindingSeverity, x: number, y: number): void {
  const size = SHAPE_SIZE;
  const half = size / 2;
  const cx = x + half;
  const cy = y + half;
  pdf.save().fillColor(COLOURS[severity]);
  switch (severity) {
    case "CRITICAL":
      pdf.polygon([cx, y], [x + size, y + size], [x, y + size]).fill();
      break;
    case "HIGH":
      pdf.polygon([cx, y], [x + size, cy], [cx, y + size], [x, cy]).fill();
      break;
    case "MEDIUM":
      pdf.rect(x, y, size, size).fill();
      break;
    case "LOW":
      pdf.circle(cx, cy, half).fill();
      break;
    case "INFO":
      pdf.circle(cx, cy, half - 0.75).lineWidth(1.5).strokeColor(COLOURS.INFO).stroke();
      break;
  }
  pdf.restore();
}

/** Shape and label at the current line; returns the x after the label. */
function severityLabel(pdf: Doc, severity: FindingSeverity, x: number, y: number): number {
  drawShape(pdf, severity, x, y + 1);
  pdf.font("Helvetica-Bold").fontSize(10).fillColor(COLOURS[severity]);
  const label = SEVERITY_LABELS[severity];
  pdf.text(label, x + 12, y, { lineBreak: false });
  return x + 12 + pdf.widthOfString(label);
}

function keyValues(pdf: Doc, rows: [string, string][]): void {
  const labelWidth = 130;
  for (const [label, value] of rows) {
    const valueWidth = contentWidth(pdf) - labelWidth;
    pdf.font("Helvetica").fontSize(9);
    const height = Math.max(12, pdf.heightOfString(pdfSafe(value), { width: valueWidth }));
    ensureSpace(pdf, height);
    const y = pdf.y;
    pdf.fillColor(MUTED).text(pdfSafe(label), MARGIN, y, { width: labelWidth - 8 });
    pdf.fillColor(TEXT).text(pdfSafe(value), MARGIN + labelWidth, y, { width: valueWidth });
    pdf.y = y + height + 2;
  }
}

function limitations(pdf: Doc, doc: ReportDocument): void {
  heading(pdf, "Coverage limitations");
  for (const line of doc.coverageLimitations) {
    ensureSpace(pdf, 24);
    pdf.font("Helvetica").fontSize(10).fillColor(TEXT).text(`- ${pdfSafe(line)}`, MARGIN + 6, undefined, {
      width: contentWidth(pdf) - 6,
    });
    pdf.moveDown(0.2);
  }
}

function distribution(pdf: Doc, doc: ReportDocument): void {
  heading(pdf, "Severity distribution");
  const max = Math.max(1, ...Object.values(doc.summary.bySeverity));
  const trackX = MARGIN + 90;
  const trackWidth = contentWidth(pdf) - 130;
  for (const severity of SEVERITIES_DESCENDING) {
    ensureSpace(pdf, 18);
    const y = pdf.y;
    const count = doc.summary.bySeverity[severity];
    severityLabel(pdf, severity, MARGIN, y);
    pdf.rect(trackX, y, trackWidth, 10).fillColor("#f1f5f9").fill();
    if (count > 0) {
      pdf.rect(trackX, y, Math.max(2, (count / max) * trackWidth), 10).fillColor(COLOURS[severity]).fill();
    }
    pdf.font("Helvetica").fontSize(10).fillColor(TEXT).text(String(count), trackX + trackWidth + 8, y, { lineBreak: false });
    pdf.y = y + 16;
  }
  const diff = doc.summary.diff;
  pdf.moveDown(0.3);
  paragraph(
    pdf,
    diff
      ? `Compared with the previous scan: ${diff.NEW} new, ${diff.PERSISTING} persisting, ${diff.RESOLVED} resolved.`
      : "No comparison with an earlier scan was recorded.",
    { colour: MUTED },
  );
}

function table(pdf: Doc, headers: string[], widths: number[], rows: string[][]): void {
  const drawRow = (cells: string[], bold: boolean) => {
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    const heights = cells.map((cell, i) => pdf.heightOfString(pdfSafe(cell), { width: widths[i]! - 6 }));
    const height = Math.max(12, ...heights) + 4;
    ensureSpace(pdf, height);
    const y = pdf.y;
    let x = MARGIN;
    cells.forEach((cell, i) => {
      pdf.fillColor(TEXT).text(pdfSafe(cell), x + 3, y + 2, { width: widths[i]! - 6 });
      x += widths[i]!;
    });
    pdf.moveTo(MARGIN, y + height).lineTo(x, y + height).lineWidth(0.3).strokeColor("#e2e8f0").stroke();
    pdf.y = y + height;
  };
  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
}

function trend(pdf: Doc, doc: ReportDocument): void {
  heading(pdf, "Trend");
  paragraph(pdf, "Findings per completed scan of this target, at the report's severity threshold, regardless of triage.", {
    colour: MUTED,
    size: 9,
  });
  pdf.moveDown(0.3);
  const width = contentWidth(pdf);
  const first = width * 0.3;
  const rest = (width - first) / 6;
  table(
    pdf,
    ["Completed", ...SEVERITIES_DESCENDING.map((s) => SEVERITY_LABELS[s]), "Total"],
    [first, ...Array(6).fill(rest)],
    doc.trend.map((point) => [
      `${formatTimestamp(point.completedAt)}${point.scanId === doc.scan.id ? " (this scan)" : ""}`,
      ...SEVERITIES_DESCENDING.map((s) => String(point.bySeverity[s])),
      String(point.total),
    ]),
  );
}

function findingList(pdf: Doc, findings: ReportFinding[]): void {
  heading(pdf, `Findings (${findings.length})`);
  if (findings.length === 0) {
    paragraph(pdf, "No findings match this report's filters.");
    return;
  }
  const width = contentWidth(pdf);
  table(
    pdf,
    ["Severity", "Finding", "Location", "Triage"],
    [width * 0.12, width * 0.33, width * 0.4, width * 0.15],
    findings.map((f) => [SEVERITY_LABELS[f.severity], f.name, locationText(f), f.triage.state]),
  );
}

function code(pdf: Doc, label: string, value: string): void {
  const text = pdfSafe(cut(value, PDF_EVIDENCE_LIMIT));
  pdf.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(label, MARGIN, undefined, { width: contentWidth(pdf) });
  pdf.font("Courier").fontSize(7.5).fillColor(TEXT).text(text, MARGIN + 6, undefined, { width: contentWidth(pdf) - 6 });
  pdf.moveDown(0.3);
}

function evidence(pdf: Doc, finding: ReportFinding): void {
  const item = finding.evidence;
  if (!item || item.status === "NONE") return paragraph(pdf, EVIDENCE_STATUS_TEXT.NONE, { colour: MUTED, size: 9 });
  if (item.status !== "AVAILABLE") return paragraph(pdf, EVIDENCE_STATUS_TEXT[item.status], { colour: MUTED, size: 9 });
  if (item.extractedSnippet) code(pdf, "Extracted snippet", item.extractedSnippet);
  if (item.curlCommand) code(pdf, "Reproduce", item.curlCommand);
  code(pdf, "Request", [...headerLines(item.requestHeaders), "", item.requestBody ?? ""].join("\n").trim());
  code(pdf, "Response", [...headerLines(item.responseHeaders), "", item.responseBody ?? ""].join("\n").trim());
}

function findingDetail(pdf: Doc, finding: ReportFinding): void {
  ensureSpace(pdf, 120);
  pdf.moveDown(0.6);
  const y = pdf.y;
  const after = severityLabel(pdf, finding.severity, MARGIN, y);
  pdf.font("Helvetica-Bold").fontSize(11).fillColor(TEXT).text(pdfSafe(finding.name), after + 8, y - 1, {
    width: MARGIN + contentWidth(pdf) - after - 8,
  });
  pdf.moveDown(0.3);
  const facts: [string, string | number | null][] = [
    ["Location", locationText(finding)],
    ["Confidence", finding.confidence],
    ["CWE", finding.cwe],
    ["OWASP category", finding.owaspCategory],
    ["CVSS", finding.cvssScore !== null ? `${finding.cvssScore} ${finding.cvssVector ?? ""}`.trim() : null],
    ["CVE", finding.cveId],
    ["EPSS", finding.epssScore],
    ["Occurrences", finding.occurrenceCount],
    ["Compared with previous", finding.diffStatus],
    ["Triage", finding.triage.justification ? `${finding.triage.state}: ${finding.triage.justification}` : finding.triage.state],
    ["Detector", finding.detectorId],
  ];
  keyValues(
    pdf,
    facts.filter(([, value]) => value !== null).map(([label, value]) => [label, String(value)]),
  );
  pdf.moveDown(0.3);
  paragraph(pdf, "Description", { bold: true, size: 9.5 });
  paragraph(pdf, finding.description, { size: 9.5 });
  pdf.moveDown(0.3);
  paragraph(pdf, "Remediation", { bold: true, size: 9.5 });
  paragraph(pdf, finding.remediation, { size: 9.5 });
  pdf.moveDown(0.3);
  evidence(pdf, finding);
}

function footers(pdf: Doc, doc: ReportDocument): void {
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        pdfSafe(`${doc.target.origin}  -  scan ${doc.scan.id}  -  page ${i + 1} of ${range.count}`),
        MARGIN,
        pdf.page.height - 35,
        { width: contentWidth(pdf), align: "center", lineBreak: false },
      );
    pdf.page.margins.bottom = bottom;
  }
}

export function renderPdf(doc: ReportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: pdfSafe(reportTitle(doc)),
        Author: "Website Vulnerability Scanner",
        Subject: pdfSafe(doc.target.origin),
      },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      pdf.font("Helvetica-Bold").fontSize(20).fillColor(TEXT).text(pdfSafe(reportTitle(doc)));
      paragraph(pdf, `${doc.target.origin}  -  generated ${formatTimestamp(doc.report.generatedAt)}`, { colour: MUTED });

      heading(pdf, "Posture");
      paragraph(pdf, postureStatement(doc), { bold: true, size: 11 });
      paragraph(pdf, `${doc.summary.total} ${doc.summary.total === 1 ? "finding" : "findings"} in total.`);

      limitations(pdf, doc);
      distribution(pdf, doc);

      if (doc.report.template === "EXECUTIVE_SUMMARY") {
        trend(pdf, doc);
        findingList(pdf, doc.findings);
      } else {
        heading(pdf, `Findings (${doc.findings.length})`);
        if (doc.findings.length === 0) paragraph(pdf, "No findings match this report's filters.");
        for (const finding of doc.findings) findingDetail(pdf, finding);
      }

      // The metadata reads as one block, so it starts a page rather than split.
      const metadata = metadataLines(doc);
      ensureSpace(pdf, 60 + metadata.length * 14);
      heading(pdf, "About this report");
      keyValues(pdf, metadata);

      footers(pdf, doc);
      pdf.end();
    } catch (error) {
      reject(error);
    }
  });
}
