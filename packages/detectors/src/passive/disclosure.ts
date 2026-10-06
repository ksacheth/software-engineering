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

/**
 * Signatures of error pages and stack traces from common platforms. Every
 * repetition is bounded and no `\s` crosses a line, so none backtracks
 * quadratically on a hostile body. `standalone` signatures only ever appear
 * in a rendered error (a PHP warning in HTML, a database error string), so
 * they count at any status; bare traces are also quoted by tutorials, so they
 * count only on an error page.
 */
const ERROR_SIGNATURES: Array<[platform: string, pattern: RegExp, standalone: boolean]> = [
  ["Java", /\n[ \t]*at [\w$.]{1,200}\([\w$]{1,100}\.java:\d{1,6}\)/, false],
  [".NET", /Server Error in '[^'\n]{0,100}' Application/, true],
  [".NET", /System\.\w{1,100}Exception:|   at \w[\w.]{1,200}\(.{0,200}\) in .{1,200}:line \d+/, false],
  ["Python", /Traceback \(most recent call last\):/, false],
  ["Django", /You're seeing this error because you have <code>DEBUG = True<\/code>/, true],
  ["PHP", /<b>(?:Fatal error|Warning|Parse error|Notice|Deprecated)<\/b>:.{1,300} on line <b>\d+<\/b>|(?:Fatal error|Parse error): .{1,300} in \/\S{1,200} on line \d+/, true],
  ["Laravel", /Whoops, looks like something went wrong|Illuminate\\[\w\\]{1,200}Exception/, true],
  ["Node.js", /\n[ \t]*at .{1,200} \((?:\/|node:internal)[^)\n]{1,300}:\d+:\d+\)/, false],
  ["Ruby on Rails", /ActionController::RoutingError/, true],
  ["Ruby on Rails", /\.rb:\d+:in `/, false],
  ["SQL", /You have an error in your SQL syntax|ORA-\d{5}:|PG::\w{1,100}Error|SQLSTATE\[\w+\]|Unclosed quotation mark after the character string/, true],
];

/**
 * Pages a platform itself renders when it fails. A trace quoted in a tutorial
 * has no such marker and a 2xx status, so it is not disclosure.
 */
const ERROR_PAGE_MARKER =
  /Server Error in '[^'\n]{0,100}' Application|You're seeing this error because you have <code>DEBUG = True|Whoops, looks like something went wrong|<b>(?:Fatal error|Parse error)<\/b>:/;

const SNIPPET_LENGTH = 200;

/** Only the line the signature hit; the rest of a trace would carry more paths and code. */
function snippetAt(body: string, match: RegExpExecArray): string {
  const hit = match.index + (body[match.index] === "\n" ? 1 : 0);
  const lineStart = body.lastIndexOf("\n", hit - 1) + 1;
  const lineEnd = body.indexOf("\n", hit);
  const start = Math.max(lineStart, hit - 40);
  return body.slice(start, Math.min(lineEnd === -1 ? body.length : lineEnd, start + SNIPPET_LENGTH)).trim();
}

const p20: PassiveDetector = {
  id: "P-20",
  inspect(page) {
    if (!page.body) return [];
    const onErrorPage = page.statusCode >= 500 || ERROR_PAGE_MARKER.test(page.body);
    for (const [platform, pattern, standalone] of ERROR_SIGNATURES) {
      if (!standalone && !onErrorPage) continue;
      const match = pattern.exec(page.body);
      if (!match) continue;
      return [
        {
          affectedUrl: page.url,
          detail: `The response contains a ${platform} error or stack trace (HTTP ${page.statusCode}).`,
          evidence: { extractedSnippet: snippetAt(page.body, match) },
        },
      ];
    }
    return [];
  },
};

export const DISCLOSURE_DETECTORS: PassiveDetector[] = [p17, p20];
