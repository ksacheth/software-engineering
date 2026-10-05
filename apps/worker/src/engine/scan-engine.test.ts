// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { loadDefinitions } from "@wvs/detectors";
import { runScanEngine, type EngineDb } from "./scan-engine.js";

const catalogue = await loadDefinitions();
const ORIGIN = "http://203.0.113.10";
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

function serve() {
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const page = SITE[path];
    if (!page) return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
    // No security headers at all, so the header detectors fire.
    return new Response(page.body ?? "", { status: 200, headers: { "content-type": page.type ?? "text/html", ...page.headers } });
  }) as unknown as typeof fetch;
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
      verifiedIpSet: ["203.0.113.10"],
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
});
