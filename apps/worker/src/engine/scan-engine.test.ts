// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { loadDefinitions } from "@wvs/detectors";
import { keepableRecord, runScanEngine, type EngineDb } from "./scan-engine.js";

const catalogue = await loadDefinitions();
const ORIGIN = "http://93.184.216.34";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A small, deliberately weak site served from memory behind a public literal IP. */
const SITE: Record<string, { type?: string; body?: string; headers?: Record<string, string> }> = {
  "/": {
    body: `<html><body>
      <a href="/search?q=hi">search</a>
      <form action="/transfer" method="post"><input name="amount" type="text"></form>
      <script src="/js/jquery-1.12.4.min.js"></script>
    </body></html>`,
  },
  "/search": { body: "<html><body>results</body></html>" },
  "/js/jquery-1.12.4.min.js": { type: "application/javascript", body: "/* jQuery 1.12.4 */" },
  "/.well-known/security.txt": { type: "text/plain", body: "" },
};

function serve(): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    requested.push(path);
    const page = SITE[path];
    if (!page) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
    // No security headers at all, so the header detectors fire.
    return new Response(page.body ?? "", { status: 200, headers: { "content-type": page.type ?? "text/html", ...page.headers } });
  }) as unknown as typeof fetch;
  return requested;
}

function fakeDb() {
  const ledger: any[] = [];
  const pages = new Map<string, any>();
  const db = {
    urlLedger: { create: async ({ data }: any) => void ledger.push(data) },
    crawledPage: {
      upsert: async ({ create }: any) => void pages.set(create.normalizedUrl, create),
      update: async () => {},
    },
  } as unknown as EngineDb;
  return { db, ledger, pages };
}

function input(profile: "PASSIVE" | "STANDARD") {
  return {
    scanJobId: "scan-engine-1",
    profile,
    scope: {
      origin: ORIGIN,
      includedPaths: [],
      excludedPaths: [],
      verifiedIpSet: ["93.184.216.34"],
      rateLimit: 1000,
      maxPages: 50,
      maxRequests: 200,
      maxDepth: 3,
    },
    adminBlocklist: [],
    isKillSwitchEngaged: async () => false,
    userAgent: "WebsiteVulnerabilityScanner/1.0",
  };
}

describe("runScanEngine", () => {
  test("crawls the target and reports passive findings without persisting them", async () => {
    serve();
    const { db, pages } = fakeDb();

    const result = await runScanEngine(db, input("PASSIVE"), catalogue);
    const detectors = new Set(result.findings.map((f) => f.detectorId));

    expect(result.pagesCrawled).toBeGreaterThan(0);
    expect(pages.size).toBeGreaterThan(0);
    expect(detectors.has("P-01")).toBe(true); // missing CSP
    expect(detectors.has("P-18")).toBe(true); // jQuery fingerprint
    expect(result.findings.every((f) => f.detectorId && f.name && f.severity)).toBe(true);
  });

  test("a PASSIVE scan runs no active detector; STANDARD does", async () => {
    serve();
    const passive = await runScanEngine(fakeDb().db, input("PASSIVE"), catalogue);
    expect(passive.findings.some((f) => f.detectorId.startsWith("A-"))).toBe(false);

    serve();
    const standard = await runScanEngine(fakeDb().db, input("STANDARD"), catalogue);
    expect(standard.findings.some((f) => f.detectorId.startsWith("A-"))).toBe(true);
  });

  test("stops without crawling when the kill switch is engaged", async () => {
    serve();
    const { db, ledger } = fakeDb();

    const result = await runScanEngine(db, { ...input("STANDARD"), isKillSwitchEngaged: async () => true }, catalogue);

    expect(result.pagesCrawled).toBe(0);
    expect(result.findings).toEqual([]);
    expect(ledger.every((row) => row.decision === "BLOCKED_KILL_SWITCH")).toBe(true);
  });

  test("reports an aborted run when the kill switch is engaged", async () => {
    serve();
    const result = await runScanEngine(fakeDb().db, { ...input("STANDARD"), isKillSwitchEngaged: async () => true }, catalogue);

    expect(result.aborted).toBe("KILL_SWITCH");
    expect(result.findings).toEqual([]);
  });

  test("a scan that was paused or cancelled stops, reports it, and sends no probes", async () => {
    serve();
    const { db, ledger } = fakeDb();

    const result = await runScanEngine(db, { ...input("STANDARD"), shouldStop: async () => true }, catalogue);

    expect(result.aborted).toBe("STOPPED");
    expect(result.findings).toEqual([]);
    expect(ledger.filter((row) => row.decision === "ALLOWED")).toEqual([]);
  });

  test("a stop that arrives during the active phase ends the run without finishing the probes", async () => {
    const requested = serve();
    const { db } = fakeDb();
    const probesSent = () => requested.filter((path) => path !== "/" && !(path in SITE)).length;
    const full = await runScanEngine(fakeDb().db, input("STANDARD"), catalogue);
    const fullProbes = probesSent();
    requested.length = 0;

    const stopped = await runScanEngine(db, { ...input("STANDARD"), shouldStop: async () => probesSent() >= 2 }, catalogue);

    expect(full.aborted).toBeNull();
    expect(stopped.aborted).toBe("STOPPED");
    expect(probesSent()).toBeLessThan(fullProbes);
  });

  test("crawl, TLS and probes share one request ceiling", async () => {
    serve();
    const { db, ledger } = fakeDb();
    const base = input("STANDARD");

    const result = await runScanEngine(db, { ...base, scope: { ...base.scope, maxRequests: 6 } }, catalogue);

    expect(result.requestsMade).toBeLessThanOrEqual(6);
    expect(ledger.filter((row) => row.decision === "ALLOWED").length).toBeLessThanOrEqual(6);
    expect(result.probesRefused).toBeGreaterThan(0);
  });

  test("resumed spend counts against the ceiling", async () => {
    serve();
    const { db, ledger } = fakeDb();
    const base = input("STANDARD");

    const result = await runScanEngine(
      db,
      { ...base, scope: { ...base.scope, maxRequests: 10 }, resumeFrom: { requestsMade: 9, pagesCrawled: 0, seenUrls: [] } },
      catalogue,
    );

    expect(result.requestsMade).toBeLessThanOrEqual(10);
    expect(ledger.filter((row) => row.decision === "ALLOWED").length).toBeLessThanOrEqual(1);
  });

  test("probes wait for the rate limiter instead of being refused", async () => {
    serve();
    const { db, ledger } = fakeDb();
    const base = input("STANDARD");

    const result = await runScanEngine(db, { ...base, scope: { ...base.scope, rateLimit: 25 } }, catalogue);

    expect(ledger.filter((row) => row.decision === "ALLOWED").length).toBeGreaterThan(25);
    expect(ledger.some((row) => row.decision === "BLOCKED_RATE_LIMIT")).toBe(false);
    expect(result.probesRefused).toBe(0);
  });

  test("a probe that errors loses that probe, not the scan", async () => {
    serve();
    const served = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (new URL(input).search.includes("wvsprobe")) throw new Error("socket hang up");
      return served(input, init);
    }) as unknown as typeof fetch;

    const result = await runScanEngine(fakeDb().db, input("STANDARD"), catalogue);

    expect(result.aborted).toBeNull();
    expect(result.findings.some((f) => f.detectorId === "P-01")).toBe(true);
  });

  test("a missing browser degrades to a static crawl with a warning", async () => {
    serve();
    const result = await runScanEngine(
      fakeDb().db,
      { ...input("PASSIVE"), launchRenderer: async () => Promise.reject(new Error("Executable doesn't exist")) },
      catalogue,
    );

    expect(result.aborted).toBeNull();
    expect(result.pagesCrawled).toBeGreaterThan(0);
    expect(result.warnings.map((w) => w.code)).toContain("RENDERING_UNAVAILABLE");
  });

  test("closes the renderer it launched, even when the crawl is cut short", async () => {
    serve();
    let closed = 0;
    const renderer = { render: async () => ({ links: [], forms: [], requestedUrls: [], loaded: true }), close: async () => void (closed += 1) };

    await runScanEngine(
      fakeDb().db,
      { ...input("PASSIVE"), isKillSwitchEngaged: async () => true, launchRenderer: async () => renderer },
      catalogue,
    );

    expect(closed).toBe(1);
  });

  test("A-14 reaches the plaintext twin of an https scope, and only its root", async () => {
    serve();
    const { db, ledger } = fakeDb();
    const base = input("STANDARD");
    const tlsConnectors = { certificate: async () => null, hello: async () => ({ kind: "incomplete" as const }) };

    const result = await runScanEngine(
      db,
      { ...base, scope: { ...base.scope, origin: "https://93.184.216.34" }, tlsConnectors },
      catalogue,
    );

    const plaintext = ledger.filter((row) => String(row.url).startsWith("http://"));
    expect(plaintext.length).toBeGreaterThan(0);
    expect(plaintext.every((row) => row.url === "http://93.184.216.34/" && row.decision === "ALLOWED")).toBe(true);
    expect(result.findings.some((f) => f.detectorId === "A-14")).toBe(true);
  });
});

describe("keepableRecord", () => {
  const record = (contentType: string, responseBody: string) => ({ url: "http://a.example/", contentType, responseBody });

  test("drops the body of binary content", () => {
    expect(keepableRecord(record("image/png", "binary")).responseBody).toBeNull();
    expect(keepableRecord(record("application/pdf", "binary")).responseBody).toBeNull();
  });

  test("keeps text, capped at what the detectors read", () => {
    expect(keepableRecord(record("text/html", "<p>hi</p>")).responseBody).toBe("<p>hi</p>");
    expect(keepableRecord(record("text/plain", "x".repeat(600 * 1024))).responseBody).toHaveLength(512 * 1024);
  });
});
