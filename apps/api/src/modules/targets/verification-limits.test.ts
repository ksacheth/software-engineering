import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
// Importing the harness first is load-bearing: it points REDIS_DB at the
// scratch database before `config/env` is evaluated, and the limiter builds its
// client from that config the first time it is called.
import { redisClient } from "../../test-support/harness";
import {
  acquireVerificationSlot,
  describeLimitRefusal,
  MAX_ATTEMPTS_PER_HOUR,
  MAX_CONCURRENT_PER_ORG,
  MIN_SECONDS_BETWEEN_ATTEMPTS,
} from "./verification-limits";

/**
 * F.2 verification rate limits.
 *
 * Verification is the only endpoint that makes WVS originate DNS and HTTP
 * against a host nobody has verified yet, on nothing more than a user's say-so.
 * Unthrottled, it is an amplifier pointed at a third party, so these limits are
 * a safety control rather than a courtesy to the database.
 *
 * Run against real Redis, because the properties worth asserting are the ones a
 * fake would grant for free: that the window does not slide, that a refusal
 * does not leak a slot, and that an unhealthy Redis refuses rather than allows.
 */

const redis = redisClient();

let org: string;

beforeEach(() => {
  // Fresh identifiers per test, so counters from an earlier test cannot be
  // mistaken for the behaviour under test.
  org = `org-${randomUUID()}`;
});

afterAll(async () => {
  const keys = await redis.keys("verify:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

const newTarget = () => `target-${randomUUID()}`;

/** Simulate the cooldown elapsing, without making the test wait 30 seconds. */
async function elapseCooldown(targetId: string): Promise<void> {
  await redis.del(`verify:cooldown:${targetId}`);
}

describe("a verification attempt", () => {
  test("is allowed when nothing has been spent", async () => {
    const slot = await acquireVerificationSlot(newTarget(), org);

    expect(slot.allowed).toBe(true);
    if (slot.allowed) await slot.release();
  });

  test("holds a concurrency slot until it is released", async () => {
    const target = newTarget();
    const slot = await acquireVerificationSlot(target, org);
    expect(slot.allowed).toBe(true);

    expect(await redis.get(`verify:inflight:${org}`)).toBe("1");
    if (slot.allowed) await slot.release();
    expect(await redis.get(`verify:inflight:${org}`)).toBe("0");
  });

  test("leaves the in-flight counter with an expiry, so a dead process cannot wedge an org", async () => {
    const slot = await acquireVerificationSlot(newTarget(), org);
    if (slot.allowed) {
      // Deliberately not released: this is the crashed-process case.
      expect(await redis.ttl(`verify:inflight:${org}`)).toBeGreaterThan(0);
    }
  });
});

describe("the per-target cooldown", () => {
  test("refuses a second attempt straight away", async () => {
    const target = newTarget();

    const first = await acquireVerificationSlot(target, org);
    expect(first.allowed).toBe(true);
    if (first.allowed) await first.release();

    const second = await acquireVerificationSlot(target, org);
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.refusal.kind).toBe("TOO_SOON");
      if (second.refusal.kind === "TOO_SOON") {
        expect(second.refusal.retryAfterSeconds).toBeGreaterThan(0);
        expect(second.refusal.retryAfterSeconds).toBeLessThanOrEqual(
          MIN_SECONDS_BETWEEN_ATTEMPTS,
        );
      }
    }
  });

  test("applies per target, not per organisation", async () => {
    // One slow-to-propagate DNS record must not stop the user verifying
    // anything else they own.
    const first = await acquireVerificationSlot(newTarget(), org);
    if (first.allowed) await first.release();

    const other = await acquireVerificationSlot(newTarget(), org);
    expect(other.allowed).toBe(true);
    if (other.allowed) await other.release();
  });

  test("costs nothing from the hourly quota when it refuses", async () => {
    // A refusal that still consumed quota would let a user lock themselves out
    // for an hour by double-clicking.
    const target = newTarget();

    const first = await acquireVerificationSlot(target, org);
    if (first.allowed) await first.release();

    await acquireVerificationSlot(target, org);
    await acquireVerificationSlot(target, org);

    expect(await redis.get(`verify:hourly:${target}`)).toBe("1");
  });
});

describe("the hourly quota", () => {
  test(`refuses the attempt after ${MAX_ATTEMPTS_PER_HOUR}`, async () => {
    const target = newTarget();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_HOUR; attempt += 1) {
      const slot = await acquireVerificationSlot(target, org);
      expect(slot.allowed).toBe(true);
      if (slot.allowed) await slot.release();
      await elapseCooldown(target);
    }

    const refused = await acquireVerificationSlot(target, org);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.refusal.kind).toBe("HOURLY_QUOTA");
      if (refused.refusal.kind === "HOURLY_QUOTA") {
        expect(refused.refusal.retryAfterSeconds).toBeGreaterThan(0);
        expect(refused.refusal.retryAfterSeconds).toBeLessThanOrEqual(3600);
      }
    }
  });

  test("does not slide, so hammering the endpoint cannot extend the lockout", async () => {
    const target = newTarget();

    const first = await acquireVerificationSlot(target, org);
    if (first.allowed) await first.release();

    // Stand in for most of the hour having passed.
    await redis.expire(`verify:hourly:${target}`, 100);
    await elapseCooldown(target);

    const second = await acquireVerificationSlot(target, org);
    if (second.allowed) await second.release();

    // A sliding window would have pushed this back out to 3600 and the user
    // would never see the window reset.
    expect(await redis.ttl(`verify:hourly:${target}`)).toBeLessThanOrEqual(100);
  });

  test("still refuses once the in-flight slot is free", async () => {
    // The quota is about outbound traffic over time, so releasing concurrency
    // must not hand the quota back.
    const target = newTarget();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_HOUR; attempt += 1) {
      const slot = await acquireVerificationSlot(target, org);
      if (slot.allowed) await slot.release();
      await elapseCooldown(target);
    }

    expect(await redis.get(`verify:inflight:${org}`)).toBe("0");
    const refused = await acquireVerificationSlot(target, org);
    expect(refused.allowed).toBe(false);
  });
});

describe("the per-organisation concurrency cap", () => {
  /** Hold `count` slots at once, using a distinct target for each. */
  async function hold(count: number) {
    const held: Array<() => Promise<void>> = [];
    for (let i = 0; i < count; i += 1) {
      const slot = await acquireVerificationSlot(newTarget(), org);
      expect(slot.allowed).toBe(true);
      if (slot.allowed) held.push(slot.release);
    }
    return held;
  }

  test(`refuses the attempt beyond ${MAX_CONCURRENT_PER_ORG} in flight`, async () => {
    const held = await hold(MAX_CONCURRENT_PER_ORG);

    const refused = await acquireVerificationSlot(newTarget(), org);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.refusal.kind).toBe("ORG_CONCURRENCY");

    for (const release of held) await release();
  });

  test("gives the slot back when one finishes", async () => {
    const held = await hold(MAX_CONCURRENT_PER_ORG);
    await held[0]!();

    const slot = await acquireVerificationSlot(newTarget(), org);
    expect(slot.allowed).toBe(true);
    if (slot.allowed) await slot.release();

    for (const release of held.slice(1)) await release();
  });

  test("does not leak a slot when it refuses", async () => {
    // The counter is incremented to test the limit, so a refusal that forgot to
    // undo it would ratchet the org down to zero capacity one refusal at a time.
    const held = await hold(MAX_CONCURRENT_PER_ORG);

    for (let i = 0; i < 5; i += 1) {
      await acquireVerificationSlot(newTarget(), org);
    }

    expect(await redis.get(`verify:inflight:${org}`)).toBe(
      String(MAX_CONCURRENT_PER_ORG),
    );

    for (const release of held) await release();
  });

  test("is scoped to one organisation", async () => {
    const held = await hold(MAX_CONCURRENT_PER_ORG);

    const other = await acquireVerificationSlot(
      newTarget(),
      `org-${randomUUID()}`,
    );
    expect(other.allowed).toBe(true);
    if (other.allowed) await other.release();

    for (const release of held) await release();
  });
});

describe("when Redis is unhealthy", () => {
  test("the limiter fails closed", async () => {
    // An unavailable limiter must not mean an unlimited one. This endpoint can
    // be pointed at an arbitrary third party, so the safe answer to "I cannot
    // tell how much has been spent" is to refuse.
    const target = newTarget();
    // A key of the wrong type makes the counter's INCR fail the way a broken
    // or unreachable Redis does: the call rejects and the limiter cannot know
    // what has been spent.
    await redis.lpush(`verify:hourly:${target}`, "wrong type");

    // The limiter logs the Redis failure loudly, which is right in production
    // and noise in a passing suite. Captured rather than silenced, so the test
    // also asserts the operator is told.
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);

    let slot: Awaited<ReturnType<typeof acquireVerificationSlot>>;
    try {
      slot = await acquireVerificationSlot(target, org);
    } finally {
      console.error = realError;
    }

    expect(slot.allowed).toBe(false);
    if (!slot.allowed) expect(slot.refusal.kind).toBe("ORG_CONCURRENCY");
    expect(String(logged[0]?.[0])).toContain("failing closed");
  });
});

describe("refusal messages", () => {
  test("tell the user how long to wait", () => {
    expect(
      describeLimitRefusal({ kind: "TOO_SOON", retryAfterSeconds: 12 }),
    ).toContain("12");
    expect(
      describeLimitRefusal({ kind: "HOURLY_QUOTA", retryAfterSeconds: 600 }),
    ).toContain("10");
  });

  test("round the hourly wait up, so the message never says zero minutes", () => {
    expect(
      describeLimitRefusal({ kind: "HOURLY_QUOTA", retryAfterSeconds: 30 }),
    ).toContain("1 minute");
  });

  test("explain the concurrency cap without blaming the user", () => {
    expect(describeLimitRefusal({ kind: "ORG_CONCURRENCY" })).toContain(
      "in progress",
    );
  });
});
