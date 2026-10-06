import { describe, expect, test } from "bun:test";
import type { CrawlRecord } from "@wvs/shared";

import { fingerprint, loadDefinitions, runPassiveDetectors, toPageView } from "../src";

const catalogue = await loadDefinitions();

function page(overrides: Partial<CrawlRecord> = {}): CrawlRecord {
  return {
    url: "https://shop.example.com/products",
    statusCode: 200,
    responseHeaders: { "content-type": "text/html" },
    responseBody: "<html><body>ok</body></html>",
    ...overrides,
  };
}

const findingsFor = (id: string, record: CrawlRecord) =>
  runPassiveDetectors(catalogue, "PASSIVE", [record]).findings.filter((f) => f.detectorId === id);

describe("P-17 version disclosure", () => {
  test("flags banner headers that carry a version", () => {
    const record = page({ responseHeaders: { server: "Apache/2.4.49 (Unix)", "x-powered-by": "PHP/7.4.3" } });
    expect(findingsFor("P-17", record).map((f) => f.affectedParameter)).toEqual(["server", "x-powered-by"]);
  });

  test("ignores a product name without a version", () => {
    expect(findingsFor("P-17", page({ responseHeaders: { server: "nginx" } }))).toEqual([]);
  });
});

describe("P-18 technology fingerprinting", () => {
  test("identifies versioned script libraries with their npm names", () => {
    const body = `
      <script src="/static/js/jquery-3.4.1.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@4.3.1/dist/js/bootstrap.bundle.min.js"></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.15/lodash.min.js"></script>
      <script src="https://unpkg.com/react-dom@16.8.0/umd/react-dom.production.min.js"></script>
      <script src="/app.js"></script>`;
    expect(fingerprint(toPageView(page({ responseBody: body }))).map((t) => [t.name, t.version, t.npm])).toEqual([
      ["jQuery", "3.4.1", "jquery"],
      ["Bootstrap", "4.3.1", "bootstrap"],
      ["Lodash", "4.17.15", "lodash"],
      ["React DOM", "16.8.0", "react-dom"],
    ]);
  });

  test("reads the generator meta tag and banner headers", () => {
    const record = page({
      responseHeaders: { "content-type": "text/html", server: "nginx/1.18.0" },
      responseBody: '<meta name="generator" content="WordPress 6.2.1">',
    });
    expect(fingerprint(toPageView(record)).map((t) => [t.name, t.version])).toEqual([
      ["WordPress", "6.2.1"],
      ["nginx", "1.18.0"],
    ]);
  });

  test("reports INFO findings that carry an OSV component when one is known", () => {
    const [finding] = findingsFor("P-18", page({ responseBody: '<script src="/js/jquery-1.12.4.js"></script>' }));
    expect(finding).toMatchObject({
      severity: "INFO",
      affectedUrl: "https://shop.example.com/",
      affectedParameter: "jQuery 1.12.4",
      evidence: { component: "jquery@1.12.4" },
    });
  });

  test("leaves the component empty when the version is unknown", () => {
    const [finding] = findingsFor("P-18", page({ responseBody: '<script src="/js/jquery.min.js"></script>' }));
    expect(finding?.evidence?.component).toBeNull();
  });
});

describe("P-20 verbose errors", () => {
  test.each([
    ["Java", "java.lang.NullPointerException\n\tat com.shop.Cart.add(Cart.java:42)"],
    [".NET", "<h1>Server Error in '/' Application.</h1>"],
    ["Python", "Traceback (most recent call last):\n  File \"app.py\", line 3"],
    ["PHP", "<b>Fatal error</b>:  Uncaught Error in /var/www/index.php on line <b>12</b>"],
    ["Node.js", "TypeError: x is undefined\n    at handler (/srv/app/routes.js:10:5)"],
    ["SQL", "You have an error in your SQL syntax; check the manual"],
  ])("flags a %s error page", (platform, body) => {
    const [finding] = findingsFor("P-20", page({ statusCode: 500, responseBody: `<pre>${body}</pre>` }));
    expect(finding?.description).toContain(platform);
    expect(finding?.affectedUrl).toBe("https://shop.example.com/products");
  });

  test("ignores an ordinary page and one with no body", () => {
    expect(findingsFor("P-20", page())).toEqual([]);
    expect(findingsFor("P-20", page({ responseBody: null }))).toEqual([]);
  });
});
