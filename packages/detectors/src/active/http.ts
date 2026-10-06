import type { FindingSeverity } from "@wvs/shared";
import { cspDirective } from "../passive/headers";
import type { Observation } from "../types";
import type { ActiveDetector, OkProbeResponse } from "./types";
import { isHtml, isRedirect, isSuccess, probeRoot, safeProbe, selectParameters, targetFor, withParameter } from "./probe-helpers";

/** An unroutable sentinel: if a redirect or link points here, the target
 *  followed attacker input. `.invalid` never resolves (RFC 6761). */
const SENTINEL_HOST = "wvs-sentinel.invalid";

/** Query parameters that commonly carry a redirect destination. */
const REDIRECT_PARAMS = /^(?:url|next|redirect|redirect_uri|return|returnurl|dest|destination|continue|target)$/i;

/** The host a redirect points at, resolved against the request URL, or null
 *  when the Location header is unusable. */
function redirectHost(location: string, requestUrl: string): string | null {
  try {
    return new URL(location, requestUrl).hostname;
  } catch {
    return null;
  }
}

const a04: ActiveDetector = {
  id: "A-04",
  run: async (context) => {
    const { entryUrls, origin } = context.surface;
    const observations: Observation[] = [];
    for (const parameter of selectParameters(context.surface, (name) => REDIRECT_PARAMS.test(name))) {
      const target = targetFor(parameter, entryUrls, origin);
      const probeUrl = withParameter(target, parameter, `https://${SENTINEL_HOST}/`);
      const response = await safeProbe(context, { url: probeUrl, method: "GET" });
      if (!response.ok || !isRedirect(response)) continue;
      // Only a redirect whose destination host is the sentinel followed the input;
      // a Location that merely carries the sentinel in a query (/login?next=...) did not.
      const location = response.headers.get("location") ?? "";
      if (redirectHost(location, probeUrl) !== SENTINEL_HOST) continue;
      observations.push({
        affectedUrl: probeUrl,
        affectedParameter: parameter,
        detail: `"${parameter}" controls the redirect target; the server sent a ${response.status} to ${location}.`,
        evidence: { extractedSnippet: `Location: ${location}` },
      });
    }
    return observations;
  },
};

const PROBE_ORIGIN = "https://wvs-origin-probe.invalid";

interface CorsProblem {
  detail: string;
  /** Set when the problem is lower than the definition's severity. */
  severity?: FindingSeverity;
}

const a05: ActiveDetector = {
  id: "A-05",
  run: async (context) => {
    const root = await probeRoot(context, { method: "GET", headers: { Origin: PROBE_ORIGIN } });
    if (!root) return [];
    const problem = corsProblem(root.response.headers);
    if (!problem) return [];
    return [
      {
        affectedUrl: root.url,
        detail: problem.detail,
        ...(problem.severity ? { severity: problem.severity } : {}),
        evidence: { responseHeaders: corsHeaders(root.response.headers) },
      },
    ];
  },
};

/** The way a CORS policy over-trusts the probe origin, or null when it does not.
 *  Trusting an origin without credentials only exposes public content, which is
 *  routine for CDNs, so that case is reported at a lower severity. */
function corsProblem(headers: Headers): CorsProblem | null {
  const allowOrigin = headers.get("access-control-allow-origin");
  const allowCredentials = headers.get("access-control-allow-credentials") === "true";
  const unauthenticated: Pick<CorsProblem, "severity"> = allowCredentials ? {} : { severity: "LOW" };
  if (allowOrigin === PROBE_ORIGIN) {
    const varies = /\borigin\b/i.test(headers.get("vary") ?? "");
    const credentials = allowCredentials ? " with credentials allowed" : "";
    const cache = varies ? "" : " Vary: Origin is missing, so shared caches may serve the wrong policy.";
    return { detail: `The server reflected an arbitrary Origin into Access-Control-Allow-Origin${credentials}.${cache}`, ...unauthenticated };
  }
  if (allowOrigin === "null") return { detail: "The server trusts the null origin in Access-Control-Allow-Origin.", ...unauthenticated };
  if (allowOrigin === "*" && allowCredentials) return { detail: "The server combines a wildcard Access-Control-Allow-Origin with credentials." };
  return null;
}

function corsHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "vary"]) {
    const value = headers.get(name);
    if (value !== null) record[name] = value;
  }
  return record;
}

const a06: ActiveDetector = {
  id: "A-06",
  run: async (context) => {
    const root = await probeRoot(context, { method: "GET" });
    if (!root) return [];
    // A redirect, error page or non-HTML reply is not a page anyone would frame.
    const { response } = root;
    if (!isSuccess(response) || !isHtml(response)) return [];
    const xfo = response.headers.get("x-frame-options")?.trim().toUpperCase();
    if (!isFramable(response.headers.get("content-security-policy"), xfo)) return [];
    return [
      {
        affectedUrl: root.url,
        detail: "The page sets no frame-ancestors and no X-Frame-Options, so another site can frame it.",
        evidence: { responseHeaders: { "x-frame-options": xfo ?? "(absent)" } },
      },
    ];
  },
};

/** True when neither a CSP frame-ancestors restriction nor X-Frame-Options stops framing. */
function isFramable(csp: string | null, xframeOptions: string | undefined): boolean {
  const ancestors = cspDirective(csp ?? "", "frame-ancestors");
  const restrictedByCsp = ancestors?.some((source) => source === "'none'" || source === "'self'") ?? false;
  const restrictedByHeader = xframeOptions === "DENY" || xframeOptions === "SAMEORIGIN";
  return !restrictedByCsp && !restrictedByHeader;
}

/** Methods an idempotent scanner should flag if a server advertises them. */
const RISKY_METHODS = ["TRACE", "TRACK", "PUT", "DELETE", "CONNECT", "PATCH"];

const a07: ActiveDetector = {
  id: "A-07",
  run: async (context) => {
    // OPTIONS only enumerates; the risky methods themselves are never sent.
    const root = await probeRoot(context, { method: "OPTIONS" });
    if (!root) return [];
    const allow = root.response.headers.get("allow");
    if (!allow) return [];
    const advertised = allow.split(",").map((method) => method.trim().toUpperCase());
    const risky = RISKY_METHODS.filter((method) => advertised.includes(method));
    if (risky.length === 0) return [];
    return [
      {
        affectedUrl: root.url,
        detail: `OPTIONS advertises ${risky.join(", ")}.`,
        evidence: { responseHeaders: { allow } },
      },
    ];
  },
};

/** Where `host` appears in the reply (the Location header or the body), if anywhere. */
function reflectionOf(response: OkProbeResponse, host: string): { where: string; snippet: string } | null {
  const location = response.headers.get("location") ?? "";
  if (location.includes(host)) return { where: "Location header", snippet: `Location: ${location}` };
  if (response.body.includes(host)) return { where: "response body", snippet: `reflected ${host}` };
  return null;
}

/** A 2xx or 3xx reply, as opposed to an error page. */
function isNormalReply(status: number): boolean {
  return status >= 200 && status < 400;
}

const a08: ActiveDetector = {
  id: "A-08",
  run: async (context) => {
    const injectedHost = `${context.marker()}.invalid`;
    const root = await probeRoot(context, { method: "GET", headers: { Host: injectedHost } });
    // An error page that prints the unknown host (common for reverse proxies) is not reflection.
    if (!root || !isNormalReply(root.response.status)) return [];
    const reflection = reflectionOf(root.response, injectedHost);
    if (!reflection) return [];
    // The same URL without the injected Host must be a normal reply that lacks the value.
    const baseline = await safeProbe(context, { url: root.url, method: "GET" });
    if (!baseline.ok || !isNormalReply(baseline.status) || reflectionOf(baseline, injectedHost)) return [];
    return [
      {
        affectedUrl: root.url,
        affectedParameter: "Host",
        detail: `An unvalidated Host header was reflected into the ${reflection.where}, which can poison links and redirects.`,
        evidence: { extractedSnippet: reflection.snippet },
      },
    ];
  },
};

const a14: ActiveDetector = {
  id: "A-14",
  run: async (context) => {
    const origin = new URL(context.surface.origin);
    if (origin.protocol !== "https:") return [];
    // The plaintext twin on the default port: the guard admits exactly this URL
    // for A-14, and a non-default https port says nothing about port 80.
    const plaintext = `http://${origin.hostname}/`;
    const response = await safeProbe(context, { url: plaintext, method: "GET" });
    if (!response.ok) return [];
    const location = response.headers.get("location");
    if (isRedirect(response) && location?.startsWith("https://")) return [];
    return [
      {
        affectedUrl: plaintext,
        detail: isRedirect(response)
          ? `The plaintext origin redirects to ${location}, not an HTTPS URL.`
          : `The plaintext origin served content (HTTP ${response.status}) instead of redirecting to HTTPS.`,
      },
    ];
  },
};

export const HTTP_DETECTORS: ActiveDetector[] = [a04, a05, a06, a07, a08, a14];
