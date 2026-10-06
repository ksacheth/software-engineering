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

  test("blocks the rest of fe80::/10, ::, ff00::/8, NAT64 and ULA", () => {
    for (const ip of ["fe90::1", "febf::1", "::", "ff02::1", "64:ff9b::a00:1", "fd12::1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("blocks hex and dotted IPv4-mapped forms of private addresses", () => {
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true);
  });

  test("blocks 6to4 addresses that embed a private IPv4 address", () => {
    expect(isBlockedAddress("2002:7f00:1::1")).toBe(true);
    expect(isBlockedAddress("2002:0808:0808::1")).toBe(false);
  });

  test("allows public IPv6 and public IPv4-mapped addresses", () => {
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
    expect(isBlockedAddress("::ffff:808:808")).toBe(false);
  });

  test("blocks carrier-grade NAT, IETF protocol and benchmarking ranges", () => {
    for (const ip of ["100.64.0.1", "100.100.100.200", "192.0.0.8", "198.18.0.1", "198.19.255.255"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress("100.128.0.1")).toBe(false);
  });

  test("fails closed on unparseable input", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  test("blocks GCP metadata hostname", () => {
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });
});