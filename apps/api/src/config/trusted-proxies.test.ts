import { describe, expect, test } from "bun:test";
import { trustedProxyCidrs } from "./trusted-proxies";

describe("trustedProxyCidrs", () => {
  test("expands the default loopback setting", () => {
    expect(trustedProxyCidrs("loopback")).toEqual(["127.0.0.1/8", "::1/128"]);
  });

  test("expands named subnets and keeps literal addresses", () => {
    expect(trustedProxyCidrs("loopback, uniquelocal, 203.0.113.7")).toEqual([
      "127.0.0.1/8",
      "::1/128",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
      "203.0.113.7",
    ]);
  });

  test("false trusts nobody and true trusts everyone, as in Express", () => {
    expect(trustedProxyCidrs(false)).toEqual([]);
    expect(trustedProxyCidrs(true)).toEqual(["0.0.0.0/0", "::/0"]);
  });

  test("a hop count falls back to loopback", () => {
    expect(trustedProxyCidrs(1)).toEqual(["127.0.0.1/8", "::1/128"]);
  });
});
