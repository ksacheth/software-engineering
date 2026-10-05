import { describe, expect, test } from "bun:test";
import { isBlockedAddress, isBlockedHostname } from "./blocked-networks";

describe("isBlockedAddress", () => {
  test("blocks loopback and RFC1918", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.1.2.3")).toBe(true);
    expect(isBlockedAddress("192.168.0.9")).toBe(true);
    expect(isBlockedAddress("172.16.5.1")).toBe(true);
  });

  test("blocks cloud metadata", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  test("allows a public unicast address", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });

  test("blocks IPv6 loopback and link-local", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  test("blocks GCP metadata hostname", () => {
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });
});