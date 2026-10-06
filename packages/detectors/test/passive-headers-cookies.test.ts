import { describe, expect, test } from "bun:test";
import type { CrawlRecord } from "@wvs/shared";

import { loadDefinitions, PASSIVE_DETECTORS, runPassiveDetectors, type PassiveDetector } from "../src";

const catalogue = await loadDefinitions();

/** P-01..P-10, the detectors this file covers. */
const HEADERS_AND_COOKIES = PASSIVE_DETECTORS.filter((d) => /^P-(0\d|10)$/.test(d.id));
const run = (records: CrawlRecord[]) => runPassiveDetectors(catalogue, "STANDARD", records, { page: HEADERS_AND_COOKIES, site: [] });

/** Headers a well-configured HTTPS site sends; each test removes or weakens one. */
const SECURE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=()",
};

function page(headers: Record<string, string | undefined>, url = "https://app.example.com/account"): CrawlRecord {
  const merged = { ...SECURE_HEADERS, ...headers };
  return {
    url,
    statusCode: 200,
    responseHeaders: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>,
  };
}

function findingsFor(id: string, ...records: CrawlRecord[]) {
  return runPassiveDetectors(catalogue, "STANDARD", records).findings.filter((f) => f.detectorId === id);
}

describe("a well-configured site", () => {
  test("produces no header or cookie findings", () => {
    const cookie = "sid=abc; Secure; HttpOnly; SameSite=Lax; Path=/";
    expect(run([page({ "set-cookie": cookie })]).findings).toEqual([]);
  });
});

describe("header detectors", () => {
  test.each([
    ["P-01", { "content-security-policy": undefined }, "No Content-Security-Policy"],
    ["P-01", { "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'" }, "'unsafe-inline'"],
    ["P-01", { "content-security-policy": "img-src 'self'" }, "neither script-src nor default-src"],
    ["P-02", { "strict-transport-security": undefined }, "No Strict-Transport-Security"],
    ["P-02", { "strict-transport-security": "max-age=3600" }, "max-age is 3600"],
    ["P-03", { "x-content-type-options": undefined }, "nosniff is not sent"],
    ["P-04", { "content-security-policy": "default-src 'self'", "x-frame-options": undefined }, "Neither frame-ancestors"],
    ["P-04", { "content-security-policy": "default-src 'self'; frame-ancestors *" }, "allows any origin"],
    ["P-04", { "content-security-policy": "default-src 'self'", "x-frame-options": "ALLOW-FROM https://a.example" }, "browsers ignore"],
    ["P-05", { "referrer-policy": undefined }, "No Referrer-Policy"],
    ["P-05", { "referrer-policy": "no-referrer, unsafe-url" }, '"unsafe-url"'],
    ["P-06", { "permissions-policy": undefined }, "No Permissions-Policy"],
  ] as const)("%s flags %j", (id, headers, detail) => {
    const [finding] = findingsFor(id, page(headers));
    expect(finding?.description).toContain(detail);
  });

  test("findings carry the catalogue's metadata, not the detector's", () => {
    const [finding] = findingsFor("P-02", page({ "strict-transport-security": undefined }));
    expect(finding).toMatchObject({
      name: "Missing HTTP Strict-Transport-Security",
      cwe: "CWE-319",
      owaspCategory: "A02:2021",
      severity: "MEDIUM",
      remediation: expect.stringContaining("max-age"),
    });
  });

  test("report a site-wide header once, against the origin root", () => {
    const records = ["/", "/a", "/b"].map((path) =>
      page({ "x-content-type-options": undefined }, `https://app.example.com${path}`),
    );
    expect(findingsFor("P-03", ...records)).toEqual([
      expect.objectContaining({ affectedUrl: "https://app.example.com/", affectedParameter: "x-content-type-options" }),
    ]);
  });

  test("ignore non-HTML and unsuccessful responses", () => {
    const bare = { "content-security-policy": undefined, "x-content-type-options": undefined };
    expect(findingsFor("P-01", page({ ...bare, "content-type": "application/json" }))).toEqual([]);
    expect(findingsFor("P-01", { ...page(bare), statusCode: 404 })).toEqual([]);
  });

  test("P-02 does not ask a plaintext page for HSTS", () => {
    expect(findingsFor("P-02", page({ "strict-transport-security": undefined }, "http://app.example.com/"))).toEqual([]);
  });
});

describe("cookie detectors", () => {
  const withCookies = (...cookies: string[]) => page({ "set-cookie": cookies.join("\n") });

  test.each([
    ["P-07", "sid=1; HttpOnly; SameSite=Lax", "without Secure"],
    ["P-08", "sid=1; Secure; SameSite=Lax", "without HttpOnly"],
    ["P-09", "sid=1; Secure; HttpOnly", "no SameSite"],
    ["P-09", "sid=1; Secure; HttpOnly; SameSite=None", "SameSite=None"],
    ["P-10", "sid=1; Secure; HttpOnly; SameSite=Lax; Domain=.example.com", "parent domain example.com"],
  ] as const)("%s flags %s", (id, cookie, detail) => {
    const [finding] = findingsFor(id, withCookies(cookie));
    expect(finding).toMatchObject({ affectedParameter: "sid", affectedUrl: "https://app.example.com/" });
    expect(finding?.description).toContain(detail);
  });

  test("checks every cookie when several are set", () => {
    const findings = findingsFor("P-08", withCookies("a=1; Secure; HttpOnly; SameSite=Lax", "b=2; Secure; SameSite=Lax"));
    expect(findings.map((f) => f.affectedParameter)).toEqual(["b"]);
  });

  test("P-10 accepts a cookie scoped to the host itself", () => {
    expect(findingsFor("P-10", withCookies("sid=1; Domain=app.example.com"))).toEqual([]);
  });

  test("ignores a Set-Cookie that only deletes the cookie", () => {
    expect(run([withCookies("sid=; Max-Age=0")]).findings).toEqual([]);
  });
});

describe("runPassiveDetectors", () => {
  test("records a detector that throws and keeps running the others", () => {
    const broken: PassiveDetector = {
      id: "P-01",
      inspect: () => {
        throw new Error("parser exploded");
      },
    };
    const result = runPassiveDetectors(catalogue, "STANDARD", [page({ "x-content-type-options": undefined })], {
      page: [broken, ...PASSIVE_DETECTORS.filter((d) => d.id === "P-03")],
      site: [],
    });

    expect(result.failures).toEqual([
      { detectorId: "P-01", affectedUrl: "https://app.example.com/account", message: "parser exploded" },
    ]);
    expect(result.findings.map((f) => f.detectorId)).toEqual(["P-03"]);
  });

  test("every registered detector has a catalogue definition", () => {
    for (const detector of PASSIVE_DETECTORS) expect(catalogue.has(detector.id)).toBe(true);
  });
});
