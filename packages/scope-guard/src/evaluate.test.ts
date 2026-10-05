import { describe, expect, test } from "bun:test";
import { evaluate } from "./evaluate";
import type { EvaluateInput, ScopeSnapshot } from "./types";
const scope: ScopeSnapshot = {
  origin: "https://app.example.test",
  includedPaths: [],
  excludedPaths: ["/admin"],
  verifiedIpSet: ["203.0.113.10"],
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
    resolvedIps: ["203.0.113.10"],
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
      ips: ["203.0.113.10"],
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
  test("refuses when fresh IPs are not in the verified set", () => {
    expect(evaluate(input({ resolvedIps: ["198.51.100.1"] }))).toMatchObject({
      allowed: false,
      code: "REBINDING",
    });
  });
  test("refuses an administrator blocklist hit", () => {
    expect(
      evaluate(input({ adminBlocklist: ["203.0.113.10"] })),
    ).toMatchObject({ allowed: false, code: "BLOCKLIST" });
  });
});
