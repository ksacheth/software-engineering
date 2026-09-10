/**
 * Socket keepalive.
 *
 * A browser cannot observe WebSocket protocol-level pings, so the gateway
 * sends a JSON ping as well: the dashboard treats a missing application ping
 * as a dead socket, which is what lets a quiet scan be told apart from a dead
 * connection. Protocol-level pings still go out for intermediaries.
 *
 * This is deliberately not a `ScanEvent`: the SRS names exactly four event
 * types, and a keepalive is transport, not scan state.
 */
export const SCAN_SOCKET_PING_TYPE = 'ping';

export interface ScanSocketPing {
  type: typeof SCAN_SOCKET_PING_TYPE;
  /** ISO 8601 UTC. */
  at: string;
}

export function isScanSocketPing(value: unknown): value is ScanSocketPing {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === SCAN_SOCKET_PING_TYPE &&
    typeof candidate.at === 'string' &&
    !Number.isNaN(new Date(candidate.at).getTime())
  );
}
