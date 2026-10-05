import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

import type { DispatchRequest } from "../scope-guard/dispatch.js";
import type { ExtractedForm } from "./extract.js";
import type { GuardedFetch, PageRenderer, RenderedPage } from "./renderer.js";

/** Resource types that cannot reveal links, so they are never fetched. */
const SKIPPED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);
/** Resource types whose URLs are endpoints worth crawling. */
const API_RESOURCES = new Set(["xhr", "fetch"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** dispatch() hands back a decoded body, so these would describe bytes Chromium never gets. */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);
/** Set by dispatch itself. */
const DROPPED_REQUEST_HEADERS = new Set(["user-agent"]);

const RENDER_TIMEOUT_MS = 30_000;
/** Time given to scripts after load to add links or fire requests. */
const SETTLE_MS = 1_000;

export async function launchPlaywrightRenderer(userAgent: string): Promise<PageRenderer> {
  return new PlaywrightRenderer(await chromium.launch({ headless: true }), userAgent);
}

class PlaywrightRenderer implements PageRenderer {
  constructor(
    private browser: Browser,
    private userAgent: string,
  ) {}

  async render(url: string, fetch: GuardedFetch): Promise<RenderedPage> {
    const context = await this.browser.newContext({
      userAgent: this.userAgent,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const requested = new Set<string>();

    try {
      await guardContext(context, fetch, requested);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS }).catch(() => null);
      await page.waitForTimeout(SETTLE_MS);
      return await readPage(page, new URL(url).origin, requested);
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Every request the context makes is answered from dispatch, or refused. */
async function guardContext(context: BrowserContext, fetch: GuardedFetch, requested: Set<string>): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  await context.route("**/*", (route) => answer(route, fetch, requested));
}

async function answer(route: Route, fetch: GuardedFetch, requested: Set<string>): Promise<void> {
  const request = route.request();
  const method = request.method().toUpperCase();
  if (SKIPPED_RESOURCES.has(request.resourceType()) || !SAFE_METHODS.has(method)) {
    return route.abort("blockedbyclient");
  }

  const res = await fetch(request.url(), method as DispatchRequest["method"], forwardableHeaders(request.headers()));
  if (!res?.ok) return route.abort("blockedbyclient");

  if (API_RESOURCES.has(request.resourceType())) requested.add(request.url());
  return route.fulfill({ status: res.status, headers: fulfillHeaders(res.headers), body: res.body });
}

async function readPage(page: Page, origin: string, requested: Set<string>): Promise<RenderedPage> {
  const links = await page.$$eval("a[href], area[href]", (els) => els.map((el) => (el as HTMLAnchorElement).href));
  const forms = await page.$$eval("form", (els) =>
    els.map((form) => ({
      action: (form as HTMLFormElement).action,
      method: ((form as HTMLFormElement).getAttribute("method") || "GET").toUpperCase(),
      inputs: Array.from(form.querySelectorAll("input[name], select[name], textarea[name], button[name]")).map((input) => ({
        name: input.getAttribute("name")!,
        type: (input.getAttribute("type") || input.tagName).toLowerCase(),
      })),
    })),
  );

  const sameOrigin = (raw: string) => withoutHash(raw, origin);
  return {
    links: unique(links.map(sameOrigin)),
    forms: forms.filter((form: ExtractedForm) => sameOrigin(form.action) !== null),
    requestedUrls: unique([...requested].map(sameOrigin)),
  };
}

function withoutHash(raw: string, origin: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== origin) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function unique(urls: Array<string | null>): string[] {
  return [...new Set(urls.filter((url): url is string => url !== null))];
}

function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !DROPPED_REQUEST_HEADERS.has(key.toLowerCase())));
}

function fulfillHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key)) record[key] = value;
  });
  return record;
}
