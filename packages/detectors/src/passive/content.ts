import type { Observation, PageView, PassiveDetector } from "../types";

/** Elements whose plaintext source an attacker on the network could rewrite into script. */
const ACTIVE_CONTENT = "script[src], iframe[src], frame[src], object[data], embed[src], link[rel~=stylesheet][href]";

const p25: PassiveDetector = {
  id: "P-25",
  inspect(page) {
    const $ = page.isHttps ? page.html() : null;
    if (!$) return [];
    return $(ACTIVE_CONTENT)
      .toArray()
      .map((el) => $(el).attr("src") ?? $(el).attr("href") ?? $(el).attr("data") ?? "")
      .filter((src) => src.toLowerCase().startsWith("http://"))
      .map((src) => ({
        affectedUrl: page.url,
        affectedParameter: src,
        detail: `The page loads ${src} over plaintext HTTP.`,
        evidence: { extractedSnippet: src },
      }));
  },
};

const p26: PassiveDetector = {
  id: "P-26",
  inspect(page) {
    const $ = page.html();
    if (!$) return [];
    const observations: Observation[] = [];
    for (const el of $("script[src]").toArray()) {
      const src = $(el).attr("src")!;
      const url = safeUrl(src, page.url);
      if (!url || url.origin === page.origin || $(el).attr("integrity")) continue;
      observations.push({
        affectedUrl: `${page.origin}/`,
        affectedParameter: url.href,
        detail: `${url.href} is loaded from ${url.host} without an integrity hash. First seen on ${page.url}.`,
        evidence: { extractedSnippet: $.html(el).slice(0, 200) },
      });
    }
    return observations;
  },
};

/** Formats a credential has no reason to be in a response, with how to show it safely. */
const SECRET_PATTERNS: Array<[kind: string, pattern: RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe secret key", /\b[rs]k_live_[0-9A-Za-z]{24,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["credential assignment", /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{20,}["']/i],
];

/** Keeps enough to recognise the secret, never enough to use it (ADR-0010). */
export function redactSecret(secret: string): string {
  return secret.length <= 8 ? "[redacted]" : `${secret.slice(0, 8)}…[redacted]`;
}

const p27: PassiveDetector = {
  id: "P-27",
  inspect(page) {
    if (!page.body) return [];
    return SECRET_PATTERNS.flatMap(([kind, pattern]) => {
      const match = pattern.exec(page.body!);
      if (!match) return [];
      return [
        {
          affectedUrl: page.url,
          affectedParameter: kind,
          detail: `The response contains what looks like a ${kind}.`,
          evidence: { extractedSnippet: redactSecret(match[0]) },
        },
      ];
    });
  },
};

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
/** Asset names (logo@2x.png) and documentation addresses are not personal data. */
const NOT_AN_ADDRESS = /\.(png|jpe?g|gif|svg|webp|avif|ico|js|css|map)$|@(example|test|localhost)\.|^(user|name|email|you)@/i;

const p28: PassiveDetector = {
  id: "P-28",
  inspect(page) {
    if (!page.body || !/^(text\/|application\/(json|xml))/.test(page.contentType)) return [];
    const addresses = new Set((page.body.match(EMAIL) ?? []).map((a) => a.toLowerCase()).filter((a) => !NOT_AN_ADDRESS.test(a)));
    return [...addresses].map((address) => ({
      affectedUrl: `${page.origin}/`,
      affectedParameter: address,
      detail: `The address ${address} appears in responses. First seen on ${page.url}.`,
      evidence: { extractedSnippet: address },
    }));
  },
};

/** Pages that are likely about one user rather than the public. */
const SENSITIVE_PATH = /\/(account|profile|settings|admin|dashboard|billing|checkout|orders?|my)(\/|$)/i;

function looksSensitive(page: PageView): boolean {
  return page.setCookies.length > 0 || SENSITIVE_PATH.test(new URL(page.url).pathname) || Boolean(page.html()?.("input[type=password]").length);
}

const p29: PassiveDetector = {
  id: "P-29",
  inspect(page) {
    if (!page.isHtmlDocument || !looksSensitive(page)) return [];
    const cacheControl = page.header("cache-control") ?? "";
    if (/no-store|private/i.test(cacheControl)) return [];
    return [
      {
        affectedUrl: page.url,
        detail: cacheControl
          ? `Cache-Control is "${cacheControl}", which lets shared caches keep the response.`
          : "No Cache-Control header is sent, so shared caches may keep the response.",
        evidence: { responseHeaders: { "cache-control": cacheControl } },
      },
    ];
  },
};

/** Values that let a browser save what is typed. */
const SAVES_INPUT = (value: string | undefined) => value === undefined || ["on", ""].includes(value.trim().toLowerCase());

const p31: PassiveDetector = {
  id: "P-31",
  inspect(page) {
    const $ = page.html();
    if (!$) return [];
    return $("input[type=password]")
      .toArray()
      .filter((el) => SAVES_INPUT($(el).attr("autocomplete")) && SAVES_INPUT($(el).closest("form").attr("autocomplete")))
      .map((el) => {
        const name = $(el).attr("name") ?? $(el).attr("id") ?? "password";
        return {
          affectedUrl: page.url,
          affectedParameter: name,
          detail: `The password field "${name}" lets the browser save what is typed.`,
          evidence: { extractedSnippet: $.html(el).slice(0, 200) },
        };
      });
  },
};

function safeUrl(raw: string, base: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

export const CONTENT_DETECTORS: PassiveDetector[] = [p25, p26, p27, p28, p29, p31];
