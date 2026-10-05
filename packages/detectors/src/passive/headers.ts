import type { Observation, PageView, PassiveDetector } from "../types";

/**
 * P-01..P-06: response header policies. They are set per site, not per page,
 * so each reports once against the origin root, with the header as the
 * parameter; the evidence names the first page found without it.
 */
function siteWide(page: PageView, headerName: string, detail: string): Observation[] {
  return [
    {
      affectedUrl: `${page.origin}/`,
      affectedParameter: headerName,
      detail: `${detail} First seen on ${page.url}.`,
      evidence: { responseHeaders: page.responseHeaders },
    },
  ];
}

/** CSP sources that let an injected script run. */
const WEAK_SCRIPT_SOURCES = ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "data:"];

export function cspDirective(csp: string, name: string): string[] | undefined {
  for (const directive of csp.split(";")) {
    const [directiveName, ...sources] = directive.trim().split(/\s+/);
    if (directiveName?.toLowerCase() === name) return sources.map((s) => s.toLowerCase());
  }
  return undefined;
}

const p01: PassiveDetector = {
  id: "P-01",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    const csp = page.header("content-security-policy");
    if (!csp) return siteWide(page, "content-security-policy", "No Content-Security-Policy header is sent.");

    const scriptSources = cspDirective(csp, "script-src") ?? cspDirective(csp, "default-src");
    if (!scriptSources) {
      return siteWide(page, "content-security-policy", "The policy sets neither script-src nor default-src.");
    }
    const weak = scriptSources.filter((source) => WEAK_SCRIPT_SOURCES.includes(source));
    return weak.length > 0
      ? siteWide(page, "content-security-policy", `Script sources allow ${weak.join(", ")}.`)
      : [];
  },
};

const ONE_YEAR_SECONDS = 31_536_000;

const p02: PassiveDetector = {
  id: "P-02",
  inspect(page) {
    if (!page.isHttps || !page.isHtmlDocument) return [];
    const hsts = page.header("strict-transport-security");
    if (!hsts) return siteWide(page, "strict-transport-security", "No Strict-Transport-Security header is sent.");

    const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
    return maxAge < ONE_YEAR_SECONDS
      ? siteWide(page, "strict-transport-security", `max-age is ${maxAge} seconds, under one year.`)
      : [];
  },
};

const p03: PassiveDetector = {
  id: "P-03",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    return page.header("x-content-type-options")?.trim().toLowerCase() === "nosniff"
      ? []
      : siteWide(page, "x-content-type-options", "X-Content-Type-Options: nosniff is not sent.");
  },
};

const p04: PassiveDetector = {
  id: "P-04",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    const ancestors = cspDirective(page.header("content-security-policy") ?? "", "frame-ancestors");
    const xfo = page.header("x-frame-options")?.trim().toUpperCase();

    if (ancestors) {
      return ancestors.includes("*")
        ? siteWide(page, "content-security-policy", "frame-ancestors allows any origin.")
        : [];
    }
    if (xfo === "DENY" || xfo === "SAMEORIGIN") return [];
    return siteWide(
      page,
      "x-frame-options",
      xfo ? `X-Frame-Options is "${xfo}", which browsers ignore.` : "Neither frame-ancestors nor X-Frame-Options is set.",
    );
  },
};

/** Policies that send the full URL, path and query included, to other origins. */
const PERMISSIVE_REFERRER_POLICIES = new Set(["unsafe-url", "no-referrer-when-downgrade"]);

const p05: PassiveDetector = {
  id: "P-05",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    const policy = page.header("referrer-policy");
    if (!policy) return siteWide(page, "referrer-policy", "No Referrer-Policy header is sent.");

    // The last policy the browser recognises wins.
    const effective = policy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean).at(-1) ?? "";
    return PERMISSIVE_REFERRER_POLICIES.has(effective)
      ? siteWide(page, "referrer-policy", `Referrer-Policy is "${effective}", which sends full URLs cross-origin.`)
      : [];
  },
};

const p06: PassiveDetector = {
  id: "P-06",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    return page.header("permissions-policy") || page.header("feature-policy")
      ? []
      : siteWide(page, "permissions-policy", "No Permissions-Policy header is sent.");
  },
};

export const HEADER_DETECTORS: PassiveDetector[] = [p01, p02, p03, p04, p05, p06];
