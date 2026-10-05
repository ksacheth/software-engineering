import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { resolveHostIps } from "./resolve";
import { TokenBucket } from "./rate-limit";

afterEach(() => {
  setSystemTime();
});

describe("TokenBucket", () => {
  test("allows a burst at the rate, then refuses", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const bucket = new TokenBucket(2);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  test("reports how long until the next token without consuming it", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const bucket = new TokenBucket(10);
    for (let i = 0; i < 10; i++) bucket.tryRemove();

    expect(bucket.msUntilAvailable()).toBe(100);

    setSystemTime(new Date("2026-01-01T00:00:00.100Z"));
    expect(bucket.msUntilAvailable()).toBe(0);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });
});

describe("resolveHostIps", () => {
  test("returns literal IPs unchanged", async () => {
    expect(await resolveHostIps("203.0.113.10")).toEqual(["203.0.113.10"]);
  });

  test("returns no addresses for a name that cannot resolve", async () => {
    expect(await resolveHostIps("nothing-here.invalid")).toEqual([]);
  });
});
