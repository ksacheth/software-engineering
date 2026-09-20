/**
 * Timing obligations F.3 states numerically. Both halves of the contract and
 * the dashboard read them from here so the numbers cannot drift apart.
 */

/** SRS F.3: progress streams at least every 2 seconds. */
export const PROGRESS_INTERVAL_MS = 2000;

/** SRS F.3: cancellation halts all outbound requests within 5 seconds. */
export const CANCEL_DEADLINE_MS = 5000;

/** Polling fallback while the socket is down and the scan is unfinished. */
export const POLL_INTERVAL_MS = 3000;

/**
 * Server ping interval. Keeps an intermediary from mistaking an idle scan for
 * a dead connection, and lets the dashboard treat a missing ping as a dead
 * socket.
 */
export const WS_PING_INTERVAL_MS = 30000;
