import type { ReportFormat } from "@wvs/shared";
import type { ReportDocument } from "../report-document";
import { renderCsv } from "./csv";
import { renderHtml } from "./html";
import { renderJson } from "./json";
import { renderPdf } from "./pdf";
import { renderSarif } from "./sarif";

export interface FormatSpec {
  contentType: string;
  extension: string;
  render(doc: ReportDocument): Buffer | Promise<Buffer>;
}

export const FORMATS: Record<ReportFormat, FormatSpec> = {
  PDF: { contentType: "application/pdf", extension: "pdf", render: renderPdf },
  HTML: { contentType: "text/html; charset=utf-8", extension: "html", render: renderHtml },
  JSON: { contentType: "application/json; charset=utf-8", extension: "json", render: renderJson },
  CSV: { contentType: "text/csv; charset=utf-8", extension: "csv", render: renderCsv },
  SARIF: { contentType: "application/sarif+json", extension: "sarif", render: renderSarif },
};

export async function renderReport(doc: ReportDocument): Promise<Buffer> {
  return FORMATS[doc.report.format].render(doc);
}
