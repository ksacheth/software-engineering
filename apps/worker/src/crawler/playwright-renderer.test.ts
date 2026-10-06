// @ts-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

import { LAUNCH_OPTIONS, launchPlaywrightRenderer } from "./playwright-renderer.js";
import type { GuardedFetch, PageRenderer } from "./renderer.js";

const ORIGIN = "http://93.184.216.34";
/** Launching is the only reliable check: executablePath() names full Chrome even when only the headless shell is installed. */
const hasChromium = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);

const SPA = `<!doctype html><html><body>
  <img src="/logo.png">
  <script src="https://cdn.elsewhere.example/lib.js"></script>
  <script src="/app.js"></script>
</body></html>`;

const APP_JS = `
  document.body.insertAdjacentHTML("beforeend",
    '<a href="/javascript-page#top">Rendered</a>' +
    '<form action="/subscribe" method="post"><input name="email" type="email"></form>');
  fetch("/api/items").catch(() => {});
  fetch("/api/save", { method: "POST" }).catch(() => {});
`;

/** Stands in for the crawler's guarded request: serves the SPA and refuses anything off-origin. */
function guardedSite() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch: GuardedFetch = async (url, method) => {
    calls.push({ url, method });
    if (!url.startsWith(ORIGIN)) return null;
    const path = new URL(url).pathname;
    const body = path === "/" ? SPA : path === "/app.js" ? APP_JS : "[]";
    const type = path === "/" ? "text/html" : path === "/app.js" ? "text/javascript" : "application/json";
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": type, "content-encoding": "gzip" }),
      body,
      truncated: false,
      ips: ["93.184.216.34"],
    };
  };
  return { fetch, calls };
}

describe.skipIf(!hasChromium)("PlaywrightRenderer", () => {
  let renderer: PageRenderer;

  beforeAll(async () => {
    renderer = await launchPlaywrightRenderer("WebsiteVulnerabilityScanner/1.0");
  });

  afterAll(async () => {
    await renderer.close();
  });

  test("finds a client-rendered link, form and XHR endpoint", async () => {
    const { fetch } = guardedSite();

    const rendered = await renderer.render(`${ORIGIN}/`, fetch);

    expect(rendered.loaded).toBe(true);
    expect(rendered.links).toContain(`${ORIGIN}/javascript-page`);
    expect(rendered.forms).toEqual([
      { action: `${ORIGIN}/subscribe`, method: "POST", inputs: [{ name: "email", type: "email" }] },
    ]);
    expect(rendered.requestedUrls).toEqual([`${ORIGIN}/api/items`]);
  });

  test("sends every browser request through the guard and nothing unsafe or decorative", async () => {
    const { fetch, calls } = guardedSite();

    await renderer.render(`${ORIGIN}/`, fetch);

    const urls = calls.map((call) => call.url);
    expect(urls).toContain(`${ORIGIN}/`);
    expect(urls).toContain("https://cdn.elsewhere.example/lib.js");
    expect(urls).not.toContain(`${ORIGIN}/logo.png`);
    expect(urls).not.toContain(`${ORIGIN}/api/save`);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  }, 30_000);
});

test("launch options send unintercepted traffic to a dead-end proxy and disable UDP and prefetch paths", () => {
  expect(LAUNCH_OPTIONS.proxy?.server).toBe("http://127.0.0.1:1");
  expect(LAUNCH_OPTIONS.args).toEqual(
    expect.arrayContaining([
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--dns-prefetch-disable",
      "--disable-background-networking",
    ]),
  );
});

describe.skipIf(!hasChromium)("PlaywrightRenderer fail-closed", () => {
  test("reports loaded: false when the document request is refused", async () => {
    const renderer = await launchPlaywrightRenderer("WebsiteVulnerabilityScanner/1.0");
    try {
      const rendered = await renderer.render(`${ORIGIN}/`, async () => null);
      expect(rendered.loaded).toBe(false);
      expect(rendered.links).toEqual([]);
    } finally {
      await renderer.close();
    }
  }, 60_000);

  test("a request that skips route interception never reaches the network", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const browser = await chromium.launch(LAUNCH_OPTIONS);
    try {
      const page = await browser.newPage();
      await expect(page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 })).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);
});
