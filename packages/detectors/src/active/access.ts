import type { Observation } from "../types";
import type { ActiveContext, ActiveDetector } from "./types";

/** A small, fixed list of administrative and backup paths (SRS A-09: "bounded,
 *  rate-limited wordlist"). The token bucket paces the requests; the list stays
 *  short so enumeration cannot become a denial-of-service. */
const PROBE_PATHS = [
  "/admin",
  "/administrator",
  "/.git/config",
  "/.env",
  "/backup",
  "/backup.zip",
  "/config.php.bak",
  "/phpinfo.php",
  "/server-status",
];

const a09: ActiveDetector = {
  id: "A-09",
  run: async (context) => {
    const observations: Observation[] = [];
    for (const path of PROBE_PATHS) {
      const url = `${context.surface.origin}${path}`;
      const response = await context.probe({ url, method: "GET" });
      if (!response.ok || response.status < 200 || response.status >= 300) continue;
      observations.push({
        affectedUrl: url,
        severity: severityForPath(path), // A-09 severity varies with what the path exposes.
        detail: `${path} is reachable and returned ${response.status}.`,
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

/** Content that marks a page as the administrative interface itself, rather
 *  than a login prompt guarding it. */
const ADMIN_CONTENT = /(admin|dashboard|control panel|管理)/i;
const LOGIN_CONTENT = /(sign in|log ?in|password|authenticate|unauthori[sz]ed)/i;

const a13: ActiveDetector = {
  id: "A-13",
  run: async (context) => {
    const observations: Observation[] = [];
    for (const adminUrl of context.surface.adminUrls) {
      const response = await context.probe({ url: adminUrl, method: "GET" });
      if (!response.ok || response.status !== 200) continue;
      // An admin interface that serves its content without a login prompt is open.
      if (!ADMIN_CONTENT.test(response.body) || LOGIN_CONTENT.test(response.body)) continue;
      observations.push({
        affectedUrl: adminUrl,
        detail: "An administrative interface served its content without requiring authentication.",
      });
    }
    return observations;
  },
};

/** Secrets (.env, .git) are worse than a merely reachable admin area. */
function severityForPath(path: string): "HIGH" | "MEDIUM" {
  const exposesSecrets = /\.env|\.git/.test(path);
  return exposesSecrets ? "HIGH" : "MEDIUM";
}

export const ACCESS_DETECTORS: ActiveDetector[] = [a09, a10, a13];
