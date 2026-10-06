import type { Observation, PageView, PassiveDetector } from "../types";

/**
 * P-21..P-24 judge what a response is, not what it is called: a single-page
 * app answers every path with its own HTML, so a URL ending in .env proves
 * nothing until the body looks like an environment file.
 */

const SNIPPET_LENGTH = 160;

function served(page: PageView): boolean {
  return page.statusCode === 200 && Boolean(page.body);
}

/** The evidence is the matched signature only, never a prefix of the body (ADR-0010). */
function exposed(page: PageView, detail: string, match: RegExpExecArray | null): Observation[] {
  const snippet = match?.[0] ?? "";
  return [{ affectedUrl: page.url, detail, evidence: { extractedSnippet: snippet.trim().slice(0, SNIPPET_LENGTH) } }];
}

function pathOf(page: PageView): string {
  return new URL(page.url).pathname;
}

/** Version control metadata, and the content that proves it is real. */
const VCS_SIGNATURES: Array<[system: string, path: RegExp, body: RegExp]> = [
  ["Git", /\/\.git(\/|$)/, /^ref: refs\/|^\[core\]|repositoryformatversion|^[0-9a-f]{40}\s*$/m],
  ["Subversion", /\/\.svn(\/|$)/, /^(?:SQLite format 3|\d{1,6}\n(?:[ \t\r]*\n){0,3}[ \t\r]*dir\b)/m],
  ["Mercurial", /\/\.hg(\/|$)/, /^(?:revlogv1|store|fncache|dotencode)$/m],
];

const p21: PassiveDetector = {
  id: "P-21",
  inspect(page) {
    if (!served(page)) return [];
    for (const [system, path, body] of VCS_SIGNATURES) {
      if (!path.test(pathOf(page))) continue;
      const match = body.exec(page.body!) ?? (isListing(page) ? /Index of[^<]*/.exec(page.body!) : null);
      if (match) return exposed(page, `${system} metadata is served from ${pathOf(page)}.`, match);
    }
    return [];
  },
};

/** Configuration files, and a line that shows the file was served raw. */
const CONFIG_SIGNATURES: Array<[file: RegExp, body: RegExp]> = [
  [/\/\.env(\.[\w-]+)?$/, /^[A-Z][A-Z0-9_]*[^\S\n]*=[^\S\n]*\S.*$/m],
  [/\/web\.config$/i, /<configuration[\s>]/],
  [/\/(wp-config|config|settings|database)\.php(\.\w+)?$/i, /^\s*<\?php[\s\S]{0,4000}?(define\s*\(|\$\w+\s*=)/],
  [/\/(application|bootstrap)(-\w+)?\.(ya?ml|properties)$/i, /^[ \t]*(spring|server|datasource)[.:]/m],
  [/\/appsettings(\.\w+)?\.json$/i, /"ConnectionStrings"|"Logging"\s*:/],
  [/\/(\.npmrc|\.aws\/credentials|\.docker\/config\.json|docker-compose\.ya?ml)$/i, /_authToken|aws_secret_access_key|"auths"|^services:/m],
];

const p22: PassiveDetector = {
  id: "P-22",
  inspect(page) {
    if (!served(page) || page.contentType.startsWith("text/html")) return [];
    for (const [file, body] of CONFIG_SIGNATURES) {
      if (!file.test(pathOf(page))) continue;
      const match = body.exec(page.body!);
      if (match) return exposed(page, `The configuration file ${pathOf(page)} is served raw.`, redactValue(match));
    }
    return [];
  },
};

/**
 * Shows the setting's name, never its value. Every line of the match is
 * redacted, since a signature may span several (ADR-0010).
 */
function redactValue(match: RegExpExecArray): RegExpExecArray {
  const redacted = Object.assign([...match], match) as RegExpExecArray;
  redacted[0] = match[0].replace(/(=|:)[^\S\n]*\S[^\n]*/g, "$1 [redacted]");
  return redacted;
}

/** Listings from Apache, nginx, IIS, Python's http.server and Node's serve-index. */
const LISTING = /<title>\s*(Index of \/|Directory listing for \/)|<h1>\s*Index of \/|\[To Parent Directory\]/i;

function isListing(page: PageView): boolean {
  return LISTING.test(page.body ?? "");
}

const p23: PassiveDetector = {
  id: "P-23",
  inspect: (page) =>
    served(page) && isListing(page)
      ? exposed(page, `The server lists the contents of ${pathOf(page)}.`, LISTING.exec(page.body!))
      : [],
};

const BACKUP_SUFFIX = /\.(bak|backup|old|orig|save|swp|tmp)$|~$/i;

const p24: PassiveDetector = {
  id: "P-24",
  inspect(page) {
    // An HTML answer is most likely a catch-all route; the risk is source or
    // data served raw, which never comes back as text/html.
    if (!served(page) || !BACKUP_SUFFIX.test(pathOf(page)) || page.contentType.startsWith("text/html")) return [];
    const original = pathOf(page).replace(BACKUP_SUFFIX, "");
    // A backup of a config file is mostly credentials, so no body content is kept (ADR-0010).
    return [
      {
        affectedUrl: page.url,
        detail: `A backup copy of ${original} is served raw at ${pathOf(page)}.`,
        evidence: { extractedSnippet: `${pathOf(page)} (${page.contentType || "unknown type"}, ${page.body!.length} characters)` },
      },
    ];
  },
};

export const EXPOSURE_DETECTORS: PassiveDetector[] = [p21, p22, p23, p24];
