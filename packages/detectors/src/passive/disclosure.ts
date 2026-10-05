import type { Observation, PassiveDetector } from "../types";

/** Headers that name the server or framework; only a version number makes them a finding. */
const BANNER_HEADERS = ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator"];
const HAS_VERSION = /\d+\.\d+/;

const p17: PassiveDetector = {
  id: "P-17",
  inspect(page) {
    const observations: Observation[] = [];
    for (const name of BANNER_HEADERS) {
      const value = page.header(name);
      if (!value || !HAS_VERSION.test(value)) continue;
      observations.push({
        affectedUrl: `${page.origin}/`,
        affectedParameter: name,
        detail: `The ${name} header reads "${value}".`,
        evidence: { responseHeaders: { [name]: value }, extractedSnippet: `${name}: ${value}` },
      });
    }
    return observations;
  },
};

/** Signatures of error pages and stack traces from common platforms. */
const ERROR_SIGNATURES: Array<[platform: string, pattern: RegExp]> = [
  ["Java", /\n\s*at [\w$.]+\([\w$]+\.java:\d+\)/],
  [".NET", /Server Error in '[^']*' Application|System\.\w+Exception:|   at \w[\w.]+\(.*\) in .+:line \d+/],
  ["Python", /Traceback \(most recent call last\):/],
  ["Django", /You're seeing this error because you have <code>DEBUG = True<\/code>/],
  ["PHP", /<b>(?:Fatal error|Warning|Parse error)<\/b>:.+ on line <b>\d+<\/b>|(?:Fatal error|Parse error): .+ in \/\S+ on line \d+/],
  ["Laravel", /Whoops, looks like something went wrong|Illuminate\\[\w\\]+Exception/],
  ["Node.js", /\n\s*at .+ \((?:\/|node:internal)[^)]+:\d+:\d+\)/],
  ["Ruby on Rails", /\.rb:\d+:in `|ActionController::RoutingError/],
  ["SQL", /You have an error in your SQL syntax|ORA-\d{5}:|PG::\w+Error|SQLSTATE\[\w+\]|Unclosed quotation mark after the character string/],
];

const SNIPPET_LENGTH = 200;

const p20: PassiveDetector = {
  id: "P-20",
  inspect(page) {
    if (!page.body) return [];
    for (const [platform, pattern] of ERROR_SIGNATURES) {
      const match = pattern.exec(page.body);
      if (!match) continue;
      const start = Math.max(0, match.index - 40);
      return [
        {
          affectedUrl: page.url,
          detail: `The response contains a ${platform} error or stack trace (HTTP ${page.statusCode}).`,
          evidence: { extractedSnippet: page.body.slice(start, start + SNIPPET_LENGTH).trim() },
        },
      ];
    }
    return [];
  },
};

export const DISCLOSURE_DETECTORS: PassiveDetector[] = [p17, p20];
