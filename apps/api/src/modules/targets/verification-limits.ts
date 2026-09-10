import Redis from 'ioredis';
import { redisConnectionOptions } from '../../config/env';

/**
 * Rate limits on verification attempts (F.2).
 *
 * Each attempt makes the service issue outbound DNS or HTTP to a host the user
 * supplied, before that host has been verified. That is the one point where
 * WVS originates traffic on unverified input, so it is throttled hard or it
 * becomes an amplification vector aimed at third parties.
 *
 * State lives in Redis, not Postgres: this is disposable counter data, not an
 * audit record. The audit trail of attempts is written separately to audit_log.
 */

export const MAX_ATTEMPTS_PER_HOUR = 10;
export const MIN_SECONDS_BETWEEN_ATTEMPTS = 30;
export const MAX_CONCURRENT_PER_ORG = 3;

let client: Redis | null = null;

function redis(): Redis {
  client ??= new Redis({ ...redisConnectionOptions(), maxRetriesPerRequest: 2 });
  return client;
}

export type LimitRefusal =
  | { kind: 'TOO_SOON'; retryAfterSeconds: number }
  | { kind: 'HOURLY_QUOTA'; retryAfterSeconds: number }
  | { kind: 'ORG_CONCURRENCY' };

export type LimitResult =
  | { allowed: true; release: () => Promise<void> }
  | { allowed: false; refusal: LimitRefusal };

/**
 * Fails CLOSED when Redis is unreachable. An unavailable limiter must not mean
 * an unlimited one: the whole point of the limit is that this endpoint can be
 * pointed at arbitrary third parties.
 */
export async function acquireVerificationSlot(
  targetId: string,
  organizationId: string,
): Promise<LimitResult> {
  const r = redis();
  const cooldownKey = `verify:cooldown:${targetId}`;
  const hourlyKey = `verify:hourly:${targetId}`;
  const concurrencyKey = `verify:inflight:${organizationId}`;

  try {
    const cooldownTtl = await r.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      return { allowed: false, refusal: { kind: 'TOO_SOON', retryAfterSeconds: cooldownTtl } };
    }

    const attempts = await r.incr(hourlyKey);
    if (attempts === 1) {
      await r.expire(hourlyKey, 3600);
    }
    if (attempts > MAX_ATTEMPTS_PER_HOUR) {
      const ttl = await r.ttl(hourlyKey);
      return {
        allowed: false,
        refusal: { kind: 'HOURLY_QUOTA', retryAfterSeconds: ttl > 0 ? ttl : 3600 },
      };
    }

    const inflight = await r.incr(concurrencyKey);
    // Guard against a leaked counter if a process dies mid-verification.
    if (inflight === 1) await r.expire(concurrencyKey, 120);
    if (inflight > MAX_CONCURRENT_PER_ORG) {
      await r.decr(concurrencyKey);
      return { allowed: false, refusal: { kind: 'ORG_CONCURRENCY' } };
    }

    await r.set(cooldownKey, '1', 'EX', MIN_SECONDS_BETWEEN_ATTEMPTS);

    return {
      allowed: true,
      release: async () => {
        try {
          await r.decr(concurrencyKey);
        } catch {
          // The 120s expiry above is the backstop.
        }
      },
    };
  } catch (error) {
    console.error('[verification-limits] redis unavailable, failing closed', error);
    return { allowed: false, refusal: { kind: 'ORG_CONCURRENCY' } };
  }
}

export function describeLimitRefusal(refusal: LimitRefusal): string {
  switch (refusal.kind) {
    case 'TOO_SOON':
      return `Please wait ${refusal.retryAfterSeconds}s before retrying verification.`;
    case 'HOURLY_QUOTA':
      return `Verification attempt limit reached. Try again in ${Math.ceil(refusal.retryAfterSeconds / 60)} minutes.`;
    case 'ORG_CONCURRENCY':
      return 'Too many verifications in progress. Try again shortly.';
  }
}
