import { load } from "cheerio";

export type ExtractedForm = {
  action: string;
  method: string;
  inputs: Array<{ name: string; type: string }>;
};

export interface ExtractedPage {
  links: string[];
  forms: ExtractedForm[];
}

/**
 * Pulls same-origin links and every form out of an HTML document. Links are
 * resolved against the page URL; anything that does not parse, or leaves the
 * origin, is dropped.
 */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = load(html);
  const base = new URL($("base[href]").attr("href") ?? baseUrl, baseUrl);
  const origin = new URL(baseUrl).origin;

  const links = new Set<string>();
  $("a[href], area[href], iframe[src], frame[src]").each((_, el) => {
    const raw = $(el).attr("href") ?? $(el).attr("src");
    const resolved = resolveSameOrigin(raw, base, origin);
    if (resolved) links.add(resolved);
  });

  const forms: ExtractedForm[] = [];
  $("form").each((_, form) => {
    const action = resolveSameOrigin($(form).attr("action") || base.href, base, origin);
    if (!action) return;
    forms.push({
      action,
      method: ($(form).attr("method") || "GET").toUpperCase(),
      inputs: $(form)
        .find("input[name], select[name], textarea[name], button[name]")
        .map((_, input) => ({
          name: $(input).attr("name")!,
          type: ($(input).attr("type") || input.tagName).toLowerCase(),
        }))
        .get(),
    });
  });

  return { links: [...links], forms };
}

/** Reads `<loc>` entries from a sitemap or sitemap index. */
export function extractSitemapUrls(xml: string): string[] {
  const $ = load(xml, { xml: true });
  return $("loc")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

function resolveSameOrigin(raw: string | undefined, base: URL, origin: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (url.origin !== origin) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
