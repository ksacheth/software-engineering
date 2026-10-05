import { REPORT_GENERATOR, type ReportDocument } from "../report-document";

/**
 * JSON export: the report document itself, with a format version so a consumer
 * can tell a later shape from this one.
 */

export const JSON_REPORT_VERSION = 1;

export function renderJson(doc: ReportDocument): Buffer {
  const body = {
    formatVersion: JSON_REPORT_VERSION,
    generator: REPORT_GENERATOR,
    ...doc,
  };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
}
