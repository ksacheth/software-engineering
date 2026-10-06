import { describe, expect, test } from "bun:test";
import { inOrigin, ipsMatchVerified, pathAllowed } from "./scope";
import type { ScopeSnapshot } from "./types";

const scope: ScopeSnapshot = {
  origin: "https://app.example.test",
  includedPaths: [],
  excludedPaths: [],
  verifiedIpSet: [],
  rateLimit: 10,
  maxPages: 10,
  maxRequests: 10,
  maxDepth: 3,
};

describe("ipsMatchVerified", () => {
  test("matches /32 and /128 entries against bare addresses", () => {
    expect(ipsMatchVerified(["203.0.113.10"], ["203.0.113.10/32"])).toBe(true);
    expect(ipsMatchVerified(["2606:2800::1"], ["2606:2800:0:0:0:0:0:1/128"])).toBe(true);
  });

  test("fails closed on empty sets, empty resolution and wide prefixes", () => {
    expect(ipsMatchVerified(["203.0.113.10"], [])).toBe(false);
    expect(ipsMatchVerified([], ["203.0.113.10/32"])).toBe(false);
    expect(ipsMatchVerified(["203.0.113.10"], ["203.0.113.0/24"])).toBe(false);
  });

  test("requires every resolved address to be verified", () => {
    expect(ipsMatchVerified(["203.0.113.10", "203.0.113.11"], ["203.0.113.10/32"])).toBe(false);
  });
});

describe("pathAllowed", () => {
  const withPaths = (includedPaths: string[], excludedPaths: string[]): ScopeSnapshot => ({
    ...scope,
    includedPaths,
    excludedPaths,
  });

  test("/ as an include prefix matches everything", () => {
    expect(pathAllowed("/anything/at/all", withPaths(["/"], []))).toBe(true);
  });

  test("segment boundaries: /apple is not under /app", () => {
    const s = withPaths(["/app"], []);
    expect(pathAllowed("/app", s)).toBe(true);
    expect(pathAllowed("/app/", s)).toBe(true);
    expect(pathAllowed("/apple", s)).toBe(false);
    expect(pathAllowed("/application-backup", s)).toBe(false);
  });

  test("trailing-slash prefixes behave like their bare form", () => {
    expect(pathAllowed("/app/x", withPaths(["/app/"], []))).toBe(true);
    expect(pathAllowed("/apple", withPaths(["/app/"], []))).toBe(false);
  });

  test("/%61dmin is excluded by /admin", () => {
    expect(pathAllowed("/%61dmin", withPaths([], ["/admin"]))).toBe(false);
  });

  test("exclusions over-match: anything starting with the excluded path is out", () => {
    const s = withPaths([], ["/admin"]);
    for (const path of ["/admin.php", "/admin;jsessionid=1", "/administrators", "/Admin", "/admin%20"]) {
      expect(pathAllowed(path, s)).toBe(false);
    }
    expect(pathAllowed("/blog/admin", s)).toBe(true);
  });

  test("double encoding and backslashes cannot reach an excluded path", () => {
    const s = withPaths([], ["/admin"]);
    expect(pathAllowed("/%2561dmin", s)).toBe(false);
    expect(pathAllowed("/%5cadmin", s)).toBe(false);
    expect(pathAllowed("/x\\..\\admin", s)).toBe(false);
  });

  test("a malformed escape stays in scope when no rule excludes it", () => {
    expect(pathAllowed("/100%", withPaths([], []))).toBe(true);
    expect(pathAllowed("/caf%E9", withPaths([], []))).toBe(true);
    expect(pathAllowed("/%zz", withPaths(["/app"], []))).toBe(false);
  });
});

describe("inOrigin", () => {
  test("same origin only by default", () => {
    expect(inOrigin(new URL("https://app.example.test/x"), scope.origin)).toBe(true);
    expect(inOrigin(new URL("http://app.example.test/"), scope.origin)).toBe(false);
  });

  test("plaintext twin needs the option, an https scope and GET", () => {
    const url = new URL("http://app.example.test/");
    expect(inOrigin(url, scope.origin, { allowPlaintextTwin: true })).toBe(true);
    expect(inOrigin(url, scope.origin, { allowPlaintextTwin: true, method: "post" })).toBe(false);
    expect(inOrigin(url, "http://app.example.test", { allowPlaintextTwin: true })).toBe(true);
    expect(
      inOrigin(new URL("http://app.example.test:81/"), scope.origin, { allowPlaintextTwin: true }),
    ).toBe(false);
  });

  test("plaintext twin refuses a query string", () => {
    expect(inOrigin(new URL("http://app.example.test/?x=1"), scope.origin, { allowPlaintextTwin: true })).toBe(false);
  });
});
