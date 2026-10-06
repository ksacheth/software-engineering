import type { Observation } from "../types";
import type { ActiveContext, ActiveDetector, OkProbeResponse, ProbeResponse } from "./types";
import { isHtml, isSuccess, matchesBaseline, safeProbe } from "./probe-helpers";

/** Content that marks a page as the administrative interface itself, rather
 *  than a login prompt guarding it: an admin heading plus a management or
 *  session control. The bare words "admin" or "dashboard" appear on any site. */
const ADMIN_HEADING = /(admin(?:istrat(?:or|ion))?[\s-]*(?:panel|console|area|dashboard|interface)|control panel|管理)/i;
const ADMIN_CONTROLS = /(log ?out|sign ?out|\b(?:manage|users|settings|roles|permissions)\b)/i;
const LOGIN_CONTENT = /(sign in|log ?in|password|authenticate|unauthori[sz]ed)/i;

function looksLikeOpenAdmin(body: string): boolean {
  return ADMIN_HEADING.test(body) && ADMIN_CONTROLS.test(body) && !LOGIN_CONTENT.test(body);
}

/** What a real exposure of one path looks like. A 2xx alone proves nothing on
 *  a site with a catch-all route, so every path needs a content signature. */
interface Artefact {
  path: string;
  severity: "HIGH" | "MEDIUM";
  /** False for files that are never HTML; an HTML reply to those is a shell page. */
  html: boolean;
  /** True when the body is what the path exposes. */
  matches: (body: string) => boolean;
}

/** A small, fixed list of administrative and backup paths (SRS A-09: "bounded,
 *  rate-limited wordlist"). The token bucket paces the requests; the list stays
 *  short so enumeration cannot become a denial-of-service. Secrets (.env, .git)
 *  are worse than a merely reachable admin area. */
const ARTEFACTS: Artefact[] = [
  { path: "/admin", severity: "MEDIUM", html: true, matches: looksLikeOpenAdmin },
  { path: "/administrator", severity: "MEDIUM", html: true, matches: looksLikeOpenAdmin },
  { path: "/.git/config", severity: "HIGH", html: false, matches: (body) => /\[core\]/.test(body) },
  { path: "/.env", severity: "HIGH", html: false, matches: (body) => /^[A-Z_][A-Z0-9_]*=/m.test(body) },
  { path: "/backup", severity: "MEDIUM", html: true, matches: (body) => /Index of/i.test(body) },
  { path: "/backup.zip", severity: "MEDIUM", html: false, matches: (body) => /^PK[\u0001-\u0008]/.test(body) },
  { path: "/config.php.bak", severity: "MEDIUM", html: false, matches: (body) => /<\?php/.test(body) },
  { path: "/phpinfo.php", severity: "MEDIUM", html: true, matches: (body) => /phpinfo\(\)|PHP Version/.test(body) },
  { path: "/server-status", severity: "MEDIUM", html: true, matches: (body) => /Apache Server Status/.test(body) },
];

/** One request to a random path that cannot exist: whatever it returns is what
 *  the site says for "nothing here" (a 404, or an SPA shell with a 200). */
function fetchBaseline(context: ActiveContext): Promise<ProbeResponse> {
  return safeProbe(context, { url: `${context.surface.origin}/${context.marker()}`, method: "GET" });
}

function isExposed(response: OkProbeResponse, artefact: Artefact, baseline: ProbeResponse): boolean {
  if (!isSuccess(response)) return false;
  if (!artefact.html && isHtml(response)) return false;
  if (matchesBaseline(response, baseline)) return false;
  return artefact.matches(response.body);
}

const a09: ActiveDetector = {
  id: "A-09",
  run: async (context) => {
    const baseline = await fetchBaseline(context);
    const observations: Observation[] = [];
    for (const artefact of ARTEFACTS) {
      const url = `${context.surface.origin}${artefact.path}`;
      const response = await safeProbe(context, { url, method: "GET" });
      if (!response.ok || !isExposed(response, artefact, baseline)) continue;
      observations.push({
        affectedUrl: url,
        severity: artefact.severity, // A-09 severity varies with what the path exposes.
        detail: `${artefact.path} is reachable and returned ${response.status} with content that matches what it should hide.`,
      });
    }
    return observations;
  },
};

/** A hidden field whose name marks it as an anti-CSRF token. */
const TOKEN_FIELD = /csrf|xsrf|authenticity|nonce|_token|requestverificationtoken/i;

const a10: ActiveDetector = {
  // Structural only: forms are read from the crawl, nothing is submitted.
  id: "A-10",
  run: async (context) => {
    return context.surface.forms
      .filter((form) => form.method.toUpperCase() === "POST")
      .filter((form) => !form.inputs.some((input) => input.type === "hidden" && TOKEN_FIELD.test(input.name)))
      .map((form) => ({
        affectedUrl: form.action,
        detail: "A state-changing POST form carries no anti-CSRF token field.",
        evidence: { extractedSnippet: `form action=${form.action} inputs=${form.inputs.map((i) => i.name).join(",")}` },
      }));
  },
};

const a13: ActiveDetector = {
  id: "A-13",
  run: async (context) => {
    const { adminUrls } = context.surface;
    if (adminUrls.length === 0) return [];
    const baseline = await fetchBaseline(context);
    const observations: Observation[] = [];
    for (const adminUrl of adminUrls) {
      const response = await safeProbe(context, { url: adminUrl, method: "GET" });
      if (!response.ok || response.status !== 200 || !isHtml(response)) continue;
      // An admin interface that serves its content without a login prompt is open,
      // but a catch-all page that answers every path the same way is not.
      if (matchesBaseline(response, baseline) || !looksLikeOpenAdmin(response.body)) continue;
      observations.push({
        affectedUrl: adminUrl,
        detail: "An administrative interface served its content without requiring authentication.",
      });
    }
    return observations;
  },
};

export const ACCESS_DETECTORS: ActiveDetector[] = [a09, a10, a13];
