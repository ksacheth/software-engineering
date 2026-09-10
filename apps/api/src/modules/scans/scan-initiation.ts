import Redis from "ioredis";
import { redisConnectionOptions } from "../../config/env";

/**
 * NFR-SEC-4: scan initiation is rate-limited.
 *
 * Scanning is the one operation that spends real resources and originates
 * traffic against a third party, so a script that starts scans in a loop is
 * throttled here as well as by the concurrency quota (which it could otherwise
 * grind against).
 *
 * Fails CLOSED: if Redis is unreachable the scan cannot be queued anyway
 * (BullMQ needs the same Redis), so refusing is both safe and honest.
 */

export const MAX_STARTS_PER_MINUTE = 10;
const WINDOW_SECONDS = 60;

let client: Redis | null = null;

function redis(): Redis {
  client ??= new Redis({ ...redisConnectionOptions(), maxRetriesPerRequest: 2 });
  return client;
}

export type InitiationLimit =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export async function acquireScanInitiation(
  organizationId: string,
): Promise<InitiationLimit> {
  const key = `scan:initiate:${organizationId}`;

  try {
    const starts = await redis().incr(key);
    if (starts === 1) {
      await redis().expire(key, WINDOW_SECONDS);
    }
    if (starts > MAX_STARTS_PER_MINUTE) {
      const ttl = await redis().ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    }
    return { allowed: true };
  } catch (error) {
    console.error("[scan-initiation] redis unavailable, failing closed", error);
    return { allowed: false, retryAfterSeconds: WINDOW_SECONDS };
  }
}
