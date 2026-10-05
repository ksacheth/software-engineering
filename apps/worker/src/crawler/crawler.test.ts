// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import type { ScopeSnapshot } from "@wvs/scope-guard";
import { crawl, type CrawlerDb, type CrawlOptions } from "./crawler.js";
import type { PageRenderer } from "./renderer.js";

const ORIGIN = "http://203.0.113.10";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A tiny site served from memory; the guard sees a public literal IP and never touches DNS. */
const SITE: Record<string, { status?: number; type?: string; body?: string; location?: string; cookies?: string[] }> = {
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
  "/new": {
    body: "Moved here",
    cookies: ["sid=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure", "theme=dark; Path=/"],
  },
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
    const headers = new Headers({ "content-type": page.type ?? "text/html" });
    if (page.location) headers.set("location", page.location);
    page.cookies?.forEach((cookie) => headers.append("set-cookie", cookie));
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
      update: async ({ where, data }: any) => {
        const key = where.scanJobId_normalizedUrl_method.normalizedUrl;
        pages.set(key, { ...pages.get(key), ...data });
      },
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

describe("crawl", () => {
  test("crawls the fixture origin once per canonical URL", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawl(db, options());

    expect([...pages.keys()].sort()).toEqual(
      [
        `${ORIGIN}/`,
        `${ORIGIN}/.well-known/security.txt`,
        `${ORIGIN}/about`,
        `${ORIGIN}/from-sitemap`,
        `${ORIGIN}/members`,
        `${ORIGIN}/new`,
        `${ORIGIN}/old`,
      ].sort(),
    );
    expect(summary.pagesCrawled).toBe(7);
  });

  test("honours robots.txt and never leaves the origin", async () => {
    const requested = serveSite();
    const { db } = fakeDb();

    await crawl(db, options());

    expect(requested).not.toContain("/private/admin");
    expect(requested.every((path) => path.startsWith("/"))).toBe(true);
  });

  test("records forms, query parameters and blocked pages", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawl(db, options());

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

  test("keeps each Set-Cookie header whole", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    await crawl(db, options());

    expect(pages.get(`${ORIGIN}/new`).responseHeaders["set-cookie"].split("\n")).toEqual([
      "sid=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure",
      "theme=dark; Path=/",
    ]);
  });

  test("stops at maxPages", async () => {
    serveSite();
    const { db, pages } = fakeDb();

    const summary = await crawl(db, options({ scope: scope({ maxPages: 2 }) }));

    expect(pages.size).toBe(2);
    expect(summary.pagesCrawled).toBe(2);
  });

  test("stops and fetches nothing once the kill switch is engaged", async () => {
    const requested = serveSite();
    const { db, pages, ledger } = fakeDb();

    const summary = await crawl(db, options({ isKillSwitchEngaged: async () => true }));

    expect(requested).toEqual([]);
    expect(pages.size).toBe(0);
    expect(summary.stoppedBy).toBe("KILL_SWITCH");
    expect(ledger[0]).toMatchObject({ decision: "BLOCKED_KILL_SWITCH" });
  });

  test("crawls what rendering revealed, through the same guard and budget", async () => {
    const requested = serveSite();
    const { db, pages, ledger } = fakeDb();
    const rendered: string[] = [];
    const renderer: PageRenderer = {
      render: async (url, fetch) => {
        rendered.push(url);
        if (url !== `${ORIGIN}/`) return { links: [], forms: [], requestedUrls: [] };
        await fetch(`${ORIGIN}/bundle.js`, "GET", {});
        return {
          links: [`${ORIGIN}/javascript-page`],
          forms: [{ action: `${ORIGIN}/subscribe`, method: "POST", inputs: [] }],
          requestedUrls: [`${ORIGIN}/api/items`],
        };
      },
      close: async () => {},
    };

    const summary = await crawl(db, options({ renderer }));

    expect(pages.has(`${ORIGIN}/javascript-page`)).toBe(true);
    expect(pages.has(`${ORIGIN}/api/items`)).toBe(true);
    expect(pages.get(`${ORIGIN}/`).forms).toEqual([
      { action: `${ORIGIN}/subscribe`, method: "POST", inputs: [] },
    ]);
    expect(requested).toContain("/bundle.js");
    expect(ledger.some((row) => row.url === `${ORIGIN}/bundle.js`)).toBe(true);
    expect(rendered.filter((url) => url === `${ORIGIN}/`)).toHaveLength(1);
    expect(summary.requestsMade).toBe(requested.length);
  });
});
