import { cspDirective } from "../passive/headers";
import type { Observation } from "../types";
import type { ActiveContext, ActiveDetector } from "./types";
import { isRedirect, targetFor, withParameter } from "./probe-helpers";

/** An unroutable sentinel: if a redirect or link points here, the target
 *  followed attacker input. `.invalid` never resolves (RFC 6761). */
const SENTINEL_HOST = "wvs-sentinel.invalid";

/** Query parameters that commonly carry a redirect destination. */
const REDIRECT_PARAMS = /^(?:url|next|redirect|redirect_uri|return|returnurl|dest|destination|continue|target)$/i;

const a04: ActiveDetector = {
  id: "A-04",
  run: async (context) => {
    const { parameters, entryUrls, origin } = context.surface;
    const observations: Observation[] = [];
    for (const parameter of parameters.filter((name) => REDIRECT_PARAMS.test(name))) {
      const target = targetFor(parameter, entryUrls, origin);
      const sentinel = `https://${SENTINEL_HOST}/`;
      const response = await context.probe({ url: withParameter(target, parameter, sentinel), method: "GET" });
      if (!response.ok || !isRedirect(response)) continue;
      const location = response.headers.get("location") ?? "";
      if (!location.includes(SENTINEL_HOST)) continue;
      observations.push({
        affectedUrl: withParameter(target, parameter, sentinel),
        affectedParameter: parameter,
        detail: `"${parameter}" controls the redirect target; the server sent a ${response.status} to ${location}.`,
        evidence: { extractedSnippet: `Location: ${location}` },
      });
    }
    return observations;
  },
};

const PROBE_ORIGIN = "https://wvs-origin-probe.invalid";

const a05: ActiveDetector = {
  id: "A-05",
  run: async (context) => {
    const response = await context.probe({
      url: `${context.surface.origin}/`,
      method: "GET",
      headers: { Origin: PROBE_ORIGIN },
    });
    if (!response.ok) return [];
    const allowOrigin = response.headers.get("access-control-allow-origin");
    const allowCredentials = response.headers.get("access-control-allow-credentials") === "true";
    const detail = corsProblem(allowOrigin, allowCredentials);
    if (!detail) return [];
    return [
      {
        affectedUrl: `${context.surface.origin}/`,
        detail,
        evidence: { responseHeaders: corsHeaders(response.headers) },
      },
    ];
  },
};

/** The way a CORS policy over-trusts the probe origin, or null when it does not. */
function corsProblem(allowOrigin: string | null, allowCredentials: boolean): string | null {
  if (allowOrigin === PROBE_ORIGIN) {
    return `The server reflected an arbitrary Origin into Access-Control-Allow-Origin${allowCredentials ? " with credentials allowed" : ""}.`;
  }
  if (allowOrigin === "null") return "The server trusts the null origin in Access-Control-Allow-Origin.";
  if (allowOrigin === "*" && allowCredentials) return "The server combines a wildcard Access-Control-Allow-Origin with credentials.";
  return null;
}

function corsHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of ["access-control-allow-origin", "access-control-allow-credentials"]) {
    const value = headers.get(name);
    if (value !== null) record[name] = value;
  }
  return record;
}

const a06: ActiveDetector = {
  id: "A-06",
  run: async (context) => {
    const response = await context.probe({ url: `${context.surface.origin}/`, method: "GET" });
    if (!response.ok) return [];
    const xfo = response.headers.get("x-frame-options")?.trim().toUpperCase();
    if (!isFramable(response.headers.get("content-security-policy"), xfo)) return [];
    return [
      {
        affectedUrl: `${context.surface.origin}/`,
        detail: "The page sets no frame-ancestors and no X-Frame-Options, so another site can frame it.",
        evidence: { responseHeaders: { "x-frame-options": xfo ?? "(absent)" } },
      },
    ];
  },
};

/** Methods an idempotent scanner should flag if a server advertises them. */
/** True when neither a CSP frame-ancestors restriction nor X-Frame-Options stops framing. */
function isFramable(csp: string | null, xframeOptions: string | undefined): boolean {
  const ancestors = cspDirective(csp ?? "", "frame-ancestors");
  const restrictedByCsp = ancestors?.some((source) => source === "'none'" || source === "'self'") ?? false;
  const restrictedByHeader = xframeOptions === "DENY" || xframeOptions === "SAMEORIGIN";
  return !restrictedByCsp && !restrictedByHeader;
}

const RISKY_METHODS = ["TRACE", "TRACK", "PUT", "DELETE", "CONNECT", "PATCH"];

const a07: ActiveDetector = {
  id: "A-07",
  run: async (context) => {
    // OPTIONS only enumerates; the risky methods themselves are never sent.
    const response = await context.probe({ url: `${context.surface.origin}/`, method: "OPTIONS" });
    if (!response.ok) return [];
    const allow = response.headers.get("allow");
    if (!allow) return [];
    const advertised = allow.split(",").map((method) => method.trim().toUpperCase());
    const risky = RISKY_METHODS.filter((method) => advertised.includes(method));
    if (risky.length === 0) return [];
    return [
      {
        affectedUrl: `${context.surface.origin}/`,
        detail: `OPTIONS advertises ${risky.join(", ")}.`,
        evidence: { responseHeaders: { allow } },
      },
    ];
  },
};

const a08: ActiveDetector = {
  id: "A-08",
  run: async (context) => {
    const marker = context.marker();
    const injectedHost = `${marker}.invalid`;
    const response = await context.probe({
      url: `${context.surface.origin}/`,
      method: "GET",
      headers: { Host: injectedHost },
    });
    if (!response.ok) return [];
    const location = response.headers.get("location") ?? "";
    const reflectedIn = location.includes(injectedHost) ? "Location header" : response.body.includes(injectedHost) ? "response body" : null;
    if (!reflectedIn) return [];
    return [
      {
        affectedUrl: `${context.surface.origin}/`,
        affectedParameter: "Host",
        detail: `An unvalidated Host header was reflected into the ${reflectedIn}, which can poison links and redirects.`,
        evidence: { extractedSnippet: location.includes(injectedHost) ? `Location: ${location}` : `reflected ${injectedHost}` },
      },
    ];
  },
};

const a14: ActiveDetector = {
  id: "A-14",
  run: async (context) => {
    const origin = new URL(context.surface.origin);
    if (origin.protocol !== "https:") return [];
    const plaintext = `http://${origin.host}/`;
    const response = await context.probe({ url: plaintext, method: "GET" });
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
