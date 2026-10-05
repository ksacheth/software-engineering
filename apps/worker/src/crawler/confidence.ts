/** Statuses that mean the target refused us rather than served the page. */
const BLOCKING_STATUSES = new Set([401, 403, 429]);

export function isBlockedStatus(status: number): boolean {
  return BLOCKING_STATUSES.has(status);
}
