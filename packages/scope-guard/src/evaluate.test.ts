import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluate";
import type { BlocklistEntry } from "@wvs/scope-rules";
import type { EvaluateInput, ScopeSnapshot } from "./types";
function entry(patternType: string, pattern: string): BlocklistEntry {
  return { id: `${patternType}-${pattern}`, patternType, pattern };
}
const scope: ScopeSnapshot = {
  origin: "https://app.example.test",
  includedPaths: [],
  excludedPaths: ["/admin"],
  verifiedIpSet: ["93.184.216.34/32", "2606:2800:220:1::1/128"],
  rateLimit: 10,
  maxPages: 200,
  maxRequests: 1000,
  maxDepth: 3,
};
function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    url: "https://app.example.test/login",
    method: "GET",
    hostname: "app.example.test",
    pathname: "/login",
    resolvedIps: ["93.184.216.34"],
    scope,
    adminBlocklist: [],
    killSwitchEngaged: false,
    pagesCrawled: 0,
    requestsMade: 0,
    depth: 0,
    ...over,
  };
}
describe("evaluate", () => {
  test("allows an in-scope GET to a verified public IP", () => {
    expect(evaluate(input())).toEqual({
      allowed: true,
      ips: ["93.184.216.34"],
    });
  });
  test("aborts when the kill switch is engaged", () => {
    expect(evaluate(input({ killSwitchEngaged: true }))).toMatchObject({
      allowed: false,
      code: "KILL_SWITCH",
    });
  });
  test("refuses methods other than GET, HEAD and OPTIONS", () => {
    expect(evaluate(input({ method: "POST" }))).toMatchObject({
      allowed: false,
      code: "UNSAFE_METHOD",
    });
  });
  test("refuses an excluded path", () => {
    expect(
      evaluate(input({ url: "https://app.example.test/admin", pathname: "/admin" })),
    ).toMatchObject({ allowed: false, code: "OUT_OF_SCOPE" });
  });
  test("refuses when the crawl ceiling is reached", () => {
    expect(evaluate(input({ requestsMade: 1000 }))).toMatchObject({
      allowed: false,
      code: "CEILING",
    });
  });
  test("refuses an empty verified IP set", () => {
    expect(
      evaluate(input({ scope: { ...scope, verifiedIpSet: [] } })),
    ).toMatchObject({ allowed: false, code: "EMPTY_VERIFIED_IPS" });
  });
  test("refuses a private resolved address", () => {
    expect(evaluate(input({ resolvedIps: ["127.0.0.1"] }))).toMatchObject({
      allowed: false,
      code: "PRIVATE_OR_METADATA",
    });
  });
  test("refuses when a verified entry is malformed", () => {
    expect(
      evaluate(input({ scope: { ...scope, verifiedIpSet: ["garbage"] } })),
    ).toMatchObject({ allowed: false, code: "REBINDING" });
  });

  test("still accepts bare IPs in the verified set", () => {
    expect(
      evaluate(input({ scope: { ...scope, verifiedIpSet: ["93.184.216.34"] } })),
    ).toMatchObject({ allowed: true });
  });

  test("refuses when fresh IPs are not in the verified set", () => {
    expect(evaluate(input({ resolvedIps: ["8.8.8.8"] }))).toMatchObject({
      allowed: false,
      code: "REBINDING",
    });
  });
  test("refuses an administrator blocklist hit", () => {
    expect(
      evaluate(input({ adminBlocklist: [entry("CIDR", "93.184.216.34/32")] })),
    ).toMatchObject({ allowed: false, code: "BLOCKLIST" });
  });

  test("refuses CIDR, IP_RANGE and HOST_SUFFIX blocklist entries", () => {
    for (const e of [
      entry("CIDR", "93.184.216.0/24"),
      entry("IP_RANGE", "93.184.216.30-93.184.216.40"),
      entry("HOST_SUFFIX", "example.test"),
    ]) {
      expect(evaluate(input({ adminBlocklist: [e] }))).toMatchObject({
        allowed: false,
        code: "BLOCKLIST",
      });
    }
  });

  test("allows a request that matches no blocklist entry", () => {
    const list = [entry("CIDR", "198.51.100.0/24"), entry("HOST_SUFFIX", "other.test")];
    expect(evaluate(input({ adminBlocklist: list }))).toMatchObject({ allowed: true });
  });

  test("fails closed on a REGEX or malformed blocklist entry", () => {
    for (const e of [entry("REGEX", ".*"), entry("CIDR", "not-a-cidr")]) {
      expect(evaluate(input({ adminBlocklist: [e] }))).toMatchObject({
        allowed: false,
        code: "BLOCKLIST",
      });
    }
  });

  test("accepts /32 verified entries against the bare resolved address", () => {
    expect(evaluate(input())).toMatchObject({ allowed: true });
  });

  test("allows a public IPv6 address that is in the verified set", () => {
    expect(
      evaluate(input({ resolvedIps: ["2606:2800:220:1::1"] })),
    ).toEqual({ allowed: true, ips: ["2606:2800:220:1::1"] });
  });

  test("refuses forbidden IPv6 forms", () => {
    for (const ip of ["fe90::1", "::ffff:7f00:1", "64:ff9b::a00:1", "100.64.0.1"]) {
      expect(evaluate(input({ resolvedIps: [ip] }))).toMatchObject({
        allowed: false,
        code: "PRIVATE_OR_METADATA",
      });
    }
  });

  test("path scope: percent-encoded and repeated-slash paths hit the exclusion", () => {
    for (const path of ["/%61dmin", "//admin", "/admin/", "/Admin", "/x/%2e%2e/admin"]) {
      expect(
        evaluate(input({ url: `https://app.example.test${path}`, pathname: path })),
      ).toMatchObject({ allowed: false, code: "OUT_OF_SCOPE" });
    }
  });

  test("path scope: a malformed escape is out of scope", () => {
    expect(
      evaluate(input({ url: "https://app.example.test/%E0%A4%A", pathname: "/%E0%A4%A" })),
    ).toMatchObject({ allowed: false, code: "OUT_OF_SCOPE" });
  });

  test("path scope: includes match on segment boundaries", () => {
    const included = { ...scope, includedPaths: ["/app"] };
    const at = (path: string) =>
      evaluate(
        input({ url: `https://app.example.test${path}`, pathname: path, scope: included }),
      );
    expect(at("/app")).toMatchObject({ allowed: true });
    expect(at("/app/page")).toMatchObject({ allowed: true });
    expect(at("/apple")).toMatchObject({ allowed: false, code: "OUT_OF_SCOPE" });
  });

  describe("allowPlaintextTwin", () => {
    const twin = (over: Partial<EvaluateInput> = {}) =>
      input({
        url: "http://app.example.test/",
        pathname: "/",
        allowPlaintextTwin: true,
        ...over,
      });

    test("is refused unless requested", () => {
      expect(evaluate(twin({ allowPlaintextTwin: false }))).toMatchObject({
        allowed: false,
        code: "OUT_OF_SCOPE",
      });
    });

    test("admits the http root of the same host for an https scope", () => {
      expect(evaluate(twin())).toMatchObject({ allowed: true });
    });

    test("stays narrow: path, port, host, method and scheme are checked", () => {
      const refused = [
        twin({ url: "http://app.example.test/login", pathname: "/login" }),
        twin({ url: "http://app.example.test:8080/" }),
        twin({ url: "http://other.example.test/", hostname: "other.example.test" }),
        twin({ method: "HEAD" }),
        twin({ scope: { ...scope, origin: "http://app.example.test" }, url: "ftp://app.example.test/" }),
      ];
      for (const i of refused) {
        expect(evaluate(i)).toMatchObject({ allowed: false, code: "OUT_OF_SCOPE" });
      }
    });

    test("still applies the other checks", () => {
      expect(evaluate(twin({ resolvedIps: ["127.0.0.1"] }))).toMatchObject({
        allowed: false,
        code: "PRIVATE_OR_METADATA",
      });
    });
  });
});
