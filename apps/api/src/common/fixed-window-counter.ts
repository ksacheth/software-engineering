import type Redis from "ioredis";

/**
 * A fixed-window counter that cannot outlive its window.
 *
 * `INCR` followed by `EXPIRE` is two round trips, and a process that dies
 * between them leaves a key with no TTL. Every later `INCR` then pushes the
 * count further past the ceiling and the caller is refused permanently, with
 * no recovery short of an operator deleting the key by hand.
 *
 * Done as one script so the key cannot exist without an expiry. The TTL is set
 * only when the key has none, which keeps the window fixed: refreshing it on
 * every hit would turn this into a sliding window, and a caller hammering the
 * endpoint would hold its own lockout open.
 */
const INCREMENT_IN_WINDOW = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export interface WindowCount {
  count: number;
  /** Seconds until the window resets. Always positive. */
  ttlSeconds: number;
}

export async function incrementInWindow(
  redis: Redis,
  key: string,
  windowSeconds: number,
): Promise<WindowCount> {
  const [count, ttl] = (await redis.eval(
    INCREMENT_IN_WINDOW,
    1,
    key,
    String(windowSeconds),
  )) as [number, number];

  return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
}
