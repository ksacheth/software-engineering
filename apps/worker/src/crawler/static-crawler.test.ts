// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import type { ScopeSnapshot } from "@wvs/scope-guard";
import { crawlStatic, type CrawlerDb, type CrawlOptions } from "./static-crawler.js";

const ORIGIN = "http://203.0.113.10";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny site served from memory; the guard sees a public literal IP and never touches DNS. */
const SITE: Record<string, { status?: number; type?: string; body?: string; location?: string }> = {
  "/robots.txt": {
    type: "text/plain",
    body: "User-agent: *\nDisallow: /private\nSitemap: http://203.0.113.10/sitemap.xml\n",
  },
  "/sitemap.xml": {
    type: "application/xml",
    body: "<urlset><url><loc>http://203.0.113.10/from-sitemap</loc></url></urlset>",
  },
  "/": {
    body: `<a href="/about#team">About</a>
      <a href="/about?utm_source=x">About again</a>
      <a href="/private/admin">Hidden</a>
      <a href="https://elsewhere.example/">Off-site</a>
      <a href="/old">Moved</a>
      <form action="/search" method="get"><input name="q" type="text"></form>`,
  },
  "/about": { body: `<a href="/">Home</a><a href="/members">Members</a>` },
  "/members": { status: 403, body: "Forbidden" },
  "/old": { status: 301, location: "/new" },
  "/new": { body: "Moved here" },
  "/from-sitemap": { body: "Listed in sitemap" },
  "/search": { body: "Results" },
};

function serveSite(): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string) => {
    const path = new URL(input).pathname;
    requested.push(path);
    const page = SITE[path];
    if (!page) return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
    const headers: Record<string, string> = { "content-type": page.type ?? "text/html" };
    if (page.location) headers.location = page.location;
    return new Response(page.body ?? "", { status: page.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return requested;
}

function fakeDb() {
  const pages = new Map<string, any>();
  const ledger: any[] = [];
  const db = {
    urlLedger: { create: async ({ data }: any) => ledger.push(data) },
    crawledPage: {
      upsert: async ({ create }: any) => pages.set(create.normalizedUrl, create),
    },
  } as unknown as CrawlerDb;
  return { db, pages, ledger };
}

function scope(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    origin: ORIGIN,
    includedPaths: [],
    excludedPaths: [],
    verifiedIpSet: ["203.0.113.10"],
    rateLimit: 1000,
    maxPages: 50,
    maxRequests: 100,
    maxDepth: 5,
    ...overrides,
  };
}

function options(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
  return {
    scanJobId: "scan-1",
    scope: scope(),
    adminBlocklist: [],
    isKillSwitchEngaged: async () => false,
    userAgent: "WebsiteVulnerabilityScanner/1.0",
    limiter: { tryRemove: () => true, msUntilAvailable: () => 0 },
    ...overrides,
  };
}

describe("crawlStatic", () => {
  test("crawls the fixture origin once per canonical URL", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawlStatic(db, options());

    expect([...pages.keys()].sort()).toEqual(
      [
        `${ORIGIN}/`,
        `${ORIGIN}/about`,
        `${ORIGIN}/from-sitemap`,
        `${ORIGIN}/members`,
        `${ORIGIN}/new`,
        `${ORIGIN}/old`,
      ].sort(),
    );
    expect(summary.pagesCrawled).toBe(6);
  });

  test("honours robots.txt and never leaves the origin", async () => {
    const requested = serveSite();
    const { db } = fakeDb();

    await crawlStatic(db, options());

    expect(requested).not.toContain("/private/admin");
    expect(requested.every((path) => path.startsWith("/"))).toBe(true);
  });

  test("records forms, query parameters and blocked pages", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawlStatic(db, options());

    expect(pages.get(`${ORIGIN}/`).forms).toEqual([
      { action: `${ORIGIN}/search`, method: "GET", inputs: [{ name: "q", type: "text" }] },
    ]);
    expect(pages.get(`${ORIGIN}/members`)).toMatchObject({
      statusCode: 403,
      isBlocked: true,
      reducedConfidence: true,
    });
    expect(summary.blockedPages).toBe(1);
  });

  test("stops at maxPages", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawlStatic(db, options({ scope: scope({ maxPages: 2 }) }));

    expect(pages.size).toBe(2);
    expect(summary.pagesCrawled).toBe(2);
  });

  test("stops and fetches nothing once the kill switch is engaged", async () => {
    const requested = serveSite();
    const { db, pages, ledger } = fakeDb();

    const summary = await crawlStatic(db, options({ isKillSwitchEngaged: async () => true }));

    expect(requested).toEqual([]);
    expect(pages.size).toBe(0);
    expect(summary.stoppedBy).toBe("KILL_SWITCH");
    expect(ledger[0]).toMatchObject({ decision: "BLOCKED_KILL_SWITCH" });
  });
});
