import { inOrigin, pathAllowed, type ScopeSnapshot, type TokenBucket } from "@wvs/scope-guard";
import { SET_COOKIE_SEPARATOR } from "@wvs/shared";

import {
  dispatch,
  type DispatchRequest,
  type DispatchResult,
  type LedgerClient,
} from "../scope-guard/dispatch.js";
import { canonicalUrl } from "./canonical-url.js";
import { isBlockedStatus } from "./confidence.js";
import { extractPage, extractSitemapUrls, type ExtractedPage } from "./extract.js";
import { persistCrawledPage, type CrawledPageClient } from "./persist.js";
import type { PageRenderer } from "./renderer.js";
import { NO_ROBOTS, parseRobots, robotsAllows, type RobotsRules } from "./robots.js";

export type CrawlerDb = LedgerClient & CrawledPageClient;

export interface CrawlOptions {
  scanJobId: string;
  scope: ScopeSnapshot;
  adminBlocklist: string[];
  /** Read before every request (ADR-0008); a failed read must return true. */
  isKillSwitchEngaged: () => Promise<boolean>;
  userAgent: string;
  limiter: Pick<TokenBucket, "tryRemove" | "msUntilAvailable">;
  /** Renders HTML pages with JavaScript (DC-5); omitted, the crawl is static only. */
  renderer?: PageRenderer;
}

export interface CrawlSummary {
  pagesCrawled: number;
  requestsMade: number;
  blockedPages: number;
  /** Set when the guard ended the crawl (kill switch or a ceiling), not the frontier running dry. */
  stoppedBy: "KILL_SWITCH" | "CEILING" | null;
}

/** Sitemaps fetched per scan, so a sitemap index cannot spend the request budget. */
const MAX_SITEMAPS = 5;

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * F.4 crawl: breadth-first over same-origin links from the scope's entry points
 * and sitemaps, honouring robots.txt. When the static frontier runs dry, each
 * HTML page is rendered once and whatever the scripts revealed is crawled in
 * turn. Every request, the browser's included, goes through the scope-guard
 * dispatch, and every fetched page lands in crawled_page.
 */
export async function crawl(db: CrawlerDb, options: CrawlOptions): Promise<CrawlSummary> {
  return new Crawl(db, options).run();
}

type QueuedUrl = { url: string; depth: number };

class Crawl {
  private queue: QueuedUrl[] = [];
  private toRender: QueuedUrl[] = [];
  private seen = new Set<string>();
  private robots: RobotsRules = NO_ROBOTS;
  private summary: CrawlSummary = { pagesCrawled: 0, requestsMade: 0, blockedPages: 0, stoppedBy: null };

  constructor(
    private db: CrawlerDb,
    private options: CrawlOptions,
  ) {}

  async run(): Promise<CrawlSummary> {
    this.robots = await this.readRobots();
    for (const path of entryPaths(this.options.scope)) this.enqueue(this.url(path), 0);
    // RFC 9116 contact file, which P-30 judges; never linked, so asked for by name.
    this.enqueue(this.url("/.well-known/security.txt"), 0);
    await this.readSitemaps();

    do {
      while (this.queue.length > 0 && this.withinBudget()) {
        const next = this.queue.shift()!;
        await this.visit(next.url, next.depth);
      }
      await this.renderPending();
    } while (this.queue.length > 0 && this.withinBudget());

    return this.summary;
  }

  /** Renders every HTML page not yet rendered, queueing what the scripts revealed. */
  private async renderPending(): Promise<void> {
    const renderer = this.options.renderer;
    if (!renderer) return;

    while (this.toRender.length > 0 && this.withinBudget()) {
      const { url, depth } = this.toRender.shift()!;
      const rendered = await renderer.render(url, (target, method, headers) =>
        this.request(target, depth, method, headers),
      );
      [...rendered.links, ...rendered.requestedUrls].forEach((link) => this.enqueue(link, depth + 1));
      await this.db.crawledPage.update({
        where: { scanJobId_normalizedUrl_method: { scanJobId: this.options.scanJobId, normalizedUrl: canonicalUrl(url), method: "GET" } },
        data: { forms: rendered.forms, linksFound: rendered.links },
      });
    }
  }

  private async readRobots(): Promise<RobotsRules> {
    const res = await this.request(this.url("/robots.txt"), 0);
    if (!res?.ok || res.status !== 200) return NO_ROBOTS;
    return parseRobots(res.body, this.options.userAgent);
  }

  private async readSitemaps(): Promise<void> {
    const pending = [...this.robots.sitemaps, this.url("/sitemap.xml")];
    const fetched = new Set<string>();

    while (pending.length > 0 && fetched.size < MAX_SITEMAPS && this.withinBudget()) {
      const sitemap = pending.shift()!;
      if (fetched.has(sitemap) || !this.inScope(sitemap)) continue;
      fetched.add(sitemap);
      pending.push(...(await this.readSitemap(sitemap)));
    }
  }

  /** Enqueues the pages a sitemap lists and returns any nested sitemaps. */
  private async readSitemap(sitemap: string): Promise<string[]> {
    const res = await this.request(sitemap, 0);
    if (!res?.ok || res.status !== 200) return [];
    const locs = extractSitemapUrls(res.body);
    locs.filter((loc) => !loc.endsWith(".xml")).forEach((loc) => this.enqueue(loc, 1));
    return locs.filter((loc) => loc.endsWith(".xml"));
  }

  private async visit(url: string, depth: number): Promise<void> {
    const res = await this.request(url, depth);
    if (!res?.ok) return;

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      this.enqueueResolved(location, url, depth);
    }

    const contentType = res.headers.get("content-type");
    const page = contentType && HTML_TYPES.test(contentType) ? extractPage(res.body, url) : null;
    page?.links.forEach((link) => this.enqueue(link, depth + 1));
    if (page && res.status === 200) this.toRender.push({ url, depth });

    await this.persist(url, depth, res, page);
  }

  private async persist(
    url: string,
    depth: number,
    res: Extract<DispatchResult, { ok: true }>,
    page: ExtractedPage | null,
  ): Promise<void> {
    const blocked = isBlockedStatus(res.status);
    this.summary.pagesCrawled += 1;
    if (blocked) this.summary.blockedPages += 1;

    await persistCrawledPage(this.db, {
      scanJobId: this.options.scanJobId,
      url,
      normalizedUrl: canonicalUrl(url),
      method: "GET",
      statusCode: res.status,
      contentType: res.headers.get("content-type"),
      depth,
      requestHeaders: { "user-agent": this.options.userAgent },
      responseHeaders: headerRecord(res.headers),
      forms: page?.forms ?? [],
      parameters: queryParameters(url),
      linksFound: page?.links ?? [],
      isBlocked: blocked,
      reducedConfidence: blocked,
    });
  }

  /** One paced request through the guard; null when it never reached the target. */
  private async request(
    url: string,
    depth: number,
    method: DispatchRequest["method"] = "GET",
    headers?: Record<string, string>,
  ): Promise<DispatchResult | null> {
    await sleep(this.options.limiter.msUntilAvailable());
    const killSwitchEngaged = await this.options.isKillSwitchEngaged();

    try {
      const result = await dispatch(this.db, {
        url,
        method,
        headers,
        scanJobId: this.options.scanJobId,
        scope: this.options.scope,
        adminBlocklist: this.options.adminBlocklist,
        killSwitchEngaged,
        pagesCrawled: this.summary.pagesCrawled,
        requestsMade: this.summary.requestsMade,
        depth,
        userAgent: this.options.userAgent,
        rateLimiter: this.options.limiter,
      });
      if (result.ok) this.summary.requestsMade += 1;
      else if (result.decision.code === "KILL_SWITCH" || result.decision.code === "CEILING") {
        this.summary.stoppedBy = result.decision.code;
      }
      return result;
    } catch {
      // Timeouts and network errors are already ledgered as ERROR by dispatch.
      this.summary.requestsMade += 1;
      return null;
    }
  }

  private withinBudget(): boolean {
    const { maxPages, maxRequests } = this.options.scope;
    return (
      this.summary.stoppedBy === null &&
      this.summary.pagesCrawled < maxPages &&
      this.summary.requestsMade < maxRequests
    );
  }

  private enqueueResolved(raw: string, from: string, depth: number): void {
    try {
      this.enqueue(new URL(raw, from).toString(), depth);
    } catch {
      // An unparseable Location header is not a page.
    }
  }

  private enqueue(url: string, depth: number): void {
    if (depth > this.options.scope.maxDepth || !this.inScope(url)) return;
    const key = canonicalUrl(url);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.queue.push({ url, depth });
  }

  private inScope(raw: string): boolean {
    const url = new URL(raw);
    return (
      inOrigin(url, this.options.scope.origin) &&
      pathAllowed(url.pathname, this.options.scope) &&
      robotsAllows(url.pathname, this.robots)
    );
  }

  private url(path: string): string {
    return new URL(path, this.options.scope.origin).toString();
  }
}

/** The scope's include paths, or the site root when it has none. */
function entryPaths(scope: ScopeSnapshot): string[] {
  return scope.includedPaths.length > 0 ? scope.includedPaths : ["/"];
}

function queryParameters(url: string): Array<{ name: string; location: "query" }> {
  return [...new Set(new URL(url).searchParams.keys())].map((name) => ({ name, location: "query" }));
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) record["set-cookie"] = cookies.join(SET_COOKIE_SEPARATOR);
  return record;
}
