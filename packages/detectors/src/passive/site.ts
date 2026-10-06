import type { PageView, SiteDetector } from "../types";

export const SECURITY_TXT_PATHS = ["/.well-known/security.txt", "/security.txt"];

/** Every response recorded for a security.txt location, whatever its status. */
function securityTxtRecords(pages: PageView[]): PageView[] {
  return pages.filter((page) => SECURITY_TXT_PATHS.includes(new URL(page.url).pathname));
}

/** RFC 9116 makes Contact and Expires required, and an expired file is not to be trusted. */
function securityTxtProblem(body: string): string | null {
  if (!/^contact:\s*\S/im.test(body)) return "has no Contact field";
  const expires = /^expires:\s*(.+)$/im.exec(body)?.[1];
  if (!expires) return "has no Expires field";
  const date = Date.parse(expires.trim());
  if (Number.isNaN(date)) return `has an unreadable Expires date (${expires.trim()})`;
  return date < Date.now() ? `expired on ${expires.trim()}` : null;
}

const p30: SiteDetector = {
  id: "P-30",
  inspect(site) {
    // The crawler skips paths outside the scan's scope or disallowed by robots.txt;
    // a file that was never requested was not found to be missing.
    const records = securityTxtRecords(site.pages);
    if (records.length === 0) return [];
    const file = records.find((page) => page.statusCode === 200);
    const isText = file?.contentType.startsWith("text/plain");
    const problem = !file || !isText ? "is not published" : securityTxtProblem(file.body ?? "");
    if (!problem) return [];
    return [
      {
        affectedUrl: `${site.origin}/`,
        affectedParameter: "security.txt",
        detail: `/.well-known/security.txt ${problem}.`,
        evidence: file?.body ? { extractedSnippet: file.body.slice(0, 200) } : undefined,
      },
    ];
  },
};

export const SITE_DETECTORS: SiteDetector[] = [p30];
