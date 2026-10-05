import type { PageView, SiteDetector } from "../types";

export const SECURITY_TXT_PATHS = ["/.well-known/security.txt", "/security.txt"];

function securityTxt(pages: PageView[]): PageView | undefined {
  return SECURITY_TXT_PATHS.map((path) => pages.find((page) => new URL(page.url).pathname === path && page.statusCode === 200))
    .find(Boolean);
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
    const file = securityTxt(site.pages);
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
