import type { Observation, PageView, PassiveDetector } from "../types";

export interface ParsedCookie {
  name: string;
  /** Attribute names, lower-cased, mapped to their values ("" for flags). */
  attributes: Map<string, string>;
  /** The header with the value replaced, safe to store as evidence (ADR-0010). */
  redacted: string;
}

export function parseSetCookie(header: string): ParsedCookie {
  const [nameValue = "", ...parts] = header.split(";");
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (key) attributes.set(key, eq === -1 ? "" : part.slice(eq + 1).trim());
  }
  const eq = nameValue.indexOf("=");
  const name = (eq === -1 ? "" : nameValue.slice(0, eq)).trim();
  return { name, attributes, redacted: redactCookie(name, parts) };
}

/**
 * Standard attributes, which carry no secret. Anything else is dropped: a
 * quoted value containing `;` (`sid="a;b"`) splits into fake attributes that
 * would otherwise echo the rest of the value.
 */
const SAFE_ATTRIBUTES = new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly", "priority", "partitioned"]);

/** The cookie as evidence: its name, its standard attributes, and never a value (ADR-0010). */
function redactCookie(name: string, parts: string[]): string {
  const shown = parts
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      return SAFE_ATTRIBUTES.has((eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase());
    });
  return [`${name}=[redacted]`, ...shown].join("; ");
}

/** A Set-Cookie that only deletes the cookie leaves nothing to protect. */
function isDeletion(cookie: ParsedCookie): boolean {
  const maxAge = cookie.attributes.get("max-age");
  if (maxAge !== undefined && Number(maxAge) <= 0) return true;
  const expires = cookie.attributes.get("expires");
  return expires !== undefined && Date.parse(expires) < Date.now();
}

/**
 * P-07..P-10 report once per cookie name against the origin root, since a
 * site sets the same cookie on many responses.
 */
function cookieDetector(id: string, check: (cookie: ParsedCookie, page: PageView) => string | null): PassiveDetector {
  return {
    id,
    inspect(page) {
      const observations: Observation[] = [];
      for (const cookie of page.setCookies.map(parseSetCookie)) {
        if (!cookie.name || isDeletion(cookie)) continue;
        const detail = check(cookie, page);
        if (!detail) continue;
        observations.push({
          affectedUrl: `${page.origin}/`,
          affectedParameter: cookie.name,
          detail: `${detail} First seen on ${page.url}.`,
          evidence: { responseHeaders: { "set-cookie": cookie.redacted }, extractedSnippet: cookie.redacted },
        });
      }
      return observations;
    },
  };
}

const p07 = cookieDetector("P-07", (cookie) =>
  cookie.attributes.has("secure") ? null : `Cookie "${cookie.name}" is set without Secure.`,
);

const p08 = cookieDetector("P-08", (cookie) =>
  cookie.attributes.has("httponly") ? null : `Cookie "${cookie.name}" is set without HttpOnly.`,
);

const p09 = cookieDetector("P-09", (cookie) => {
  const sameSite = cookie.attributes.get("samesite")?.toLowerCase();
  if (sameSite === undefined) return `Cookie "${cookie.name}" has no SameSite attribute.`;
  if (sameSite === "none") return `Cookie "${cookie.name}" is SameSite=None and is sent on cross-site requests.`;
  return null;
});

const p10 = cookieDetector("P-10", (cookie, page) => {
  const domain = cookie.attributes.get("domain")?.replace(/^\./, "").toLowerCase();
  const host = new URL(page.url).hostname.toLowerCase();
  if (!domain || domain === host || !host.endsWith(`.${domain}`)) return null;
  return `Cookie "${cookie.name}" is scoped to the parent domain ${domain}, so every subdomain of it receives the cookie.`;
});

export const COOKIE_DETECTORS: PassiveDetector[] = [p07, p08, p09, p10];
