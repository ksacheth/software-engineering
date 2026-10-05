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

const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const GENERATOR = /<meta\b[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']+)["']/i;

/** Every technology a response reveals: script libraries, the generator meta tag, banner headers. */
export function fingerprint(page: PageView): Technology[] {
  return [...scriptLibraries(page), ...generator(page), ...banners(page)];
}

function scriptLibraries(page: PageView): Technology[] {
  if (!page.body) return [];
  const found: Technology[] = [];
  for (const [, src] of page.body.matchAll(SCRIPT_SRC)) {
    const path = src!.toLowerCase().split(/[?#]/)[0]!;
    const file = path.split("/").at(-1)!;
    // The longest matching token is the most specific: react-dom over react.
    const library = LIBRARIES.filter((l) => file.includes(l.token)).sort((a, b) => b.token.length - a.token.length)[0];
    if (!library) continue;
    found.push({ name: library.name, version: versionAfter(library.token, path), npm: library.npm, source: `script ${src}` });
  }
  return found;
}

function generator(page: PageView): Technology[] {
  const content = page.body ? GENERATOR.exec(page.body)?.[1] : undefined;
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
