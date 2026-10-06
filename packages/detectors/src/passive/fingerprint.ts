import type { PageView, PassiveDetector } from "../types";

export interface Technology {
  name: string;
  version: string | null;
  /** npm package name, when the technology is one OSV can look up. */
  npm: string | null;
  source: string;
}

/** Client libraries recognised from script URLs, by the token in their file name, with their npm names. */
const LIBRARIES: Array<{ name: string; npm: string; token: string }> = [
  { name: "jQuery", npm: "jquery", token: "jquery" },
  { name: "jQuery UI", npm: "jquery-ui", token: "jquery-ui" },
  { name: "Bootstrap", npm: "bootstrap", token: "bootstrap" },
  { name: "AngularJS", npm: "angular", token: "angular" },
  { name: "React", npm: "react", token: "react" },
  { name: "React DOM", npm: "react-dom", token: "react-dom" },
  { name: "Vue.js", npm: "vue", token: "vue" },
  { name: "Lodash", npm: "lodash", token: "lodash" },
  { name: "Underscore.js", npm: "underscore", token: "underscore" },
  { name: "Moment.js", npm: "moment", token: "moment" },
  { name: "Handlebars", npm: "handlebars", token: "handlebars" },
  { name: "DOMPurify", npm: "dompurify", token: "purify" },
];

const VERSION = String.raw`(\d+\.\d+(?:\.\d+)?)`;

/** The version that follows the library's name: jquery-1.2.3, bootstrap@1.2.3, lodash.js/1.2.3. */
function versionAfter(token: string, path: string): string | null {
  const escaped = token.replace(/[-.]/g, "\\$&");
  return new RegExp(String.raw`${escaped}[\w.-]*?[-.@/]v?${VERSION}(?=[./-]|$)`).exec(path)?.[1] ?? null;
}

/** Words a build appends to a library's file name: jquery.slim.min.js, react.production.min.js. */
const BUILD_WORDS = "min|slim|bundle|production|development|prod|dev|runtime|full|umd|esm|global|browser|with-locales";

/**
 * True when the file is the library itself. The token must be the whole stem,
 * optionally followed by a version and build words, so jquery.validate.min.js
 * or bootstrap-datepicker-1.9.0.js are not mistaken for the core library.
 */
function isLibraryFile(file: string, token: string): boolean {
  const escaped = token.replace(/[-.]/g, "\\$&");
  return new RegExp(String.raw`^${escaped}(?:[.-](?:${BUILD_WORDS}))*(?:[.-]v?\d+(?:\.\d+){0,3})?(?:[.-](?:${BUILD_WORDS}))*\.js$`).test(file);
}

const MAX_SRC_LENGTH = 500;

/** Every technology a response reveals: script libraries, the generator meta tag, banner headers. */
export function fingerprint(page: PageView): Technology[] {
  return [...scriptLibraries(page), ...generator(page), ...banners(page)];
}

function scriptLibraries(page: PageView): Technology[] {
  const $ = page.html();
  if (!$) return [];
  const found: Technology[] = [];
  for (const el of $("script[src]").toArray()) {
    const src = ($(el).attr("src") ?? "").trim().slice(0, MAX_SRC_LENGTH);
    const path = src.toLowerCase().split(/[?#]/)[0]!;
    const file = path.split("/").at(-1)!;
    const library = LIBRARIES.find((l) => isLibraryFile(file, l.token));
    if (!library) continue;
    found.push({ name: library.name, version: versionAfter(library.token, path), npm: library.npm, source: `script ${src}` });
  }
  return found;
}

function generator(page: PageView): Technology[] {
  const content = page.html()?.('meta[name="generator" i]').first().attr("content")?.trim().slice(0, MAX_SRC_LENGTH);
  if (!content) return [];
  const version = new RegExp(VERSION).exec(content)?.[1] ?? null;
  return [{ name: content.replace(new RegExp(`\\s*${VERSION}.*$`), "").trim(), version, npm: null, source: "meta generator" }];
}

function banners(page: PageView): Technology[] {
  return ["server", "x-powered-by"].flatMap((header) => {
    const value = page.header(header);
    if (!value) return [];
    const [product = value, version = null] = value.split(/[\s(]/)[0]!.split("/");
    return [{ name: product, version, npm: null, source: `${header} header` }];
  });
}

const p18: PassiveDetector = {
  id: "P-18",
  inspect: (page) =>
    fingerprint(page).map((tech) => ({
      affectedUrl: `${page.origin}/`,
      affectedParameter: tech.version ? `${tech.name} ${tech.version}` : tech.name,
      detail: `${tech.name}${tech.version ? ` ${tech.version}` : ""} identified from the ${tech.source}.`,
      evidence: {
        extractedSnippet: tech.source,
        component: tech.npm && tech.version ? `${tech.npm}@${tech.version}` : null,
      },
    })),
};

export const FINGERPRINT_DETECTORS: PassiveDetector[] = [p18];
