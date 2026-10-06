import type { Observation, PageView, PassiveDetector } from "../types";

/**
 * P-01..P-06: response header policies. They are set per site, not per page,
 * so each reports once against the origin root, with the header as the
 * parameter; the evidence names the first page found without it. Only the
 * header concerned is stored, never Set-Cookie or Authorization (ADR-0010).
 */
function siteWide(page: PageView, headerName: string, detail: string): Observation[] {
  return [
    {
      affectedUrl: `${page.origin}/`,
      affectedParameter: headerName,
      detail: `${detail} First seen on ${page.url}.`,
      evidence: { responseHeaders: { [headerName]: page.header(headerName) ?? "(absent)" } },
    },
  ];
}

/** CSP sources that let an injected script run. */
const WEAK_SCRIPT_SOURCES = ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "data:"];
/** Sources a browser ignores once 'strict-dynamic' is present. */
const IGNORED_BY_STRICT_DYNAMIC = ["*", "http:", "https:", "data:"];
const NONCE_OR_HASH = /^'(?:nonce-|sha(?:256|384|512)-)/;

/** Multiple policies arrive comma-joined, and the browser enforces each one. */
function splitPolicies(header: string): string[] {
  return header.split(",").map((policy) => policy.trim()).filter(Boolean);
}

/** The script sources a browser would still honour as permissive, given nonces, hashes and strict-dynamic. */
function weakScriptSources(sources: string[]): string[] {
  const hasNonceOrHash = sources.some((source) => NONCE_OR_HASH.test(source));
  const strictDynamic = sources.includes("'strict-dynamic'");
  return sources.filter((source) => {
    if (!WEAK_SCRIPT_SOURCES.includes(source)) return false;
    if (source === "'unsafe-inline'" && hasNonceOrHash) return false;
    return !(strictDynamic && IGNORED_BY_STRICT_DYNAMIC.includes(source));
  });
}

export function cspDirective(csp: string, name: string): string[] | undefined {
  for (const directive of csp.split(";")) {
    const [directiveName, ...sources] = directive.trim().split(/\s+/);
    if (directiveName?.toLowerCase() === name) return sources.map((s) => s.toLowerCase());
  }
  return undefined;
}

/**
 * What is wrong with the policies as a set, or null. Every policy is enforced,
 * so one that restricts scripts is enough; the weakest is reported otherwise.
 */
function cspProblem(policies: string[]): string | null {
  const scriptSources = policies.map((policy) => cspDirective(policy, "script-src") ?? cspDirective(policy, "default-src"));
  if (scriptSources.every((sources) => !sources)) return "The policy sets neither script-src nor default-src.";
  const weakness = scriptSources.filter((sources): sources is string[] => Boolean(sources)).map(weakScriptSources);
  if (weakness.some((weak) => weak.length === 0)) return null;
  return `Script sources allow ${weakness[0]!.join(", ")}.`;
}

const p01: PassiveDetector = {
  id: "P-01",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    const csp = page.header("content-security-policy");
    if (!csp) return siteWide(page, "content-security-policy", "No Content-Security-Policy header is sent.");
    const problem = cspProblem(splitPolicies(csp));
    return problem ? siteWide(page, "content-security-policy", problem) : [];
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

/** frame-ancestors from every policy that sets it; empty when none does. */
function frameAncestors(csp: string | undefined): string[][] {
  return splitPolicies(csp ?? "").flatMap((policy) => {
    const sources = cspDirective(policy, "frame-ancestors");
    return sources ? [sources] : [];
  });
}

const p04: PassiveDetector = {
  id: "P-04",
  inspect(page) {
    if (!page.isHtmlDocument) return [];
    const ancestors = frameAncestors(page.header("content-security-policy"));
    // A proxy and the app may each send the header; judge the distinct values.
    const xfo = [...new Set((page.header("x-frame-options") ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];

    if (ancestors.length > 0) {
      return ancestors.every((sources) => sources.includes("*"))
        ? siteWide(page, "content-security-policy", "frame-ancestors allows any origin.")
        : [];
    }
    if (xfo.length > 0 && xfo.every((value) => value === "DENY" || value === "SAMEORIGIN")) return [];
    return siteWide(
      page,
      "x-frame-options",
      xfo.length > 0 ? `X-Frame-Options is "${xfo.join(", ")}", which browsers ignore.` : "Neither frame-ancestors nor X-Frame-Options is set.",
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
