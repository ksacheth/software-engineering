import { load, type CheerioAPI } from "cheerio";
import { SET_COOKIE_SEPARATOR, type CrawlRecord } from "@wvs/shared";
import type { PageView } from "./types";

const HTML = /^(text\/html|application\/xhtml\+xml)/i;

export function toPageView(record: CrawlRecord): PageView {
  const url = new URL(record.url);
  const headers = lowerCaseKeys(record.responseHeaders ?? {});
  const contentType = headers["content-type"] ?? record.contentType ?? "";
  const statusCode = record.statusCode ?? 0;
  const body = record.responseBody ?? null;
  let document: CheerioAPI | null | undefined;

  return {
    url: record.url,
    origin: url.origin,
    isHttps: url.protocol === "https:",
    statusCode,
    contentType,
    isHtmlDocument: statusCode >= 200 && statusCode < 300 && HTML.test(contentType),
    header: (name) => headers[name.toLowerCase()],
    setCookies: (headers["set-cookie"] ?? "").split(SET_COOKIE_SEPARATOR).filter(Boolean),
    responseHeaders: headers,
    body,
    html: () => (document ??= body && HTML.test(contentType) ? load(body) : null),
  };
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
