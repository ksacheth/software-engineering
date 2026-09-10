/**
 * F.3 scan lifecycle rules.
 *
 * The SRS names the seven states but not the legal transitions. They live here,
 * in the package both halves of F.3 depend on, so the API and the orchestrator
 * cannot disagree about what a state change means. ADR-0006 records why the two
 * halves share a package at all.
 *
 * Terminal states are absorbing. That is what stops a late cancellation from
 * overwriting a finished scan, and it is why `canTransition` is the only route
 * a status change may take.
 */

export const SCAN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABORTED_SAFETY',
] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_PHASES = [
  'DISCOVERY',
  'DETECTION',
  'REPORTING',
  'COMPLETED',
] as const;

export type ScanPhase = (typeof SCAN_PHASES)[number];

export const TERMINAL_SCAN_STATUSES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABORTED_SAFETY',
] as const satisfies readonly ScanStatus[];

/**
 * Statuses that hold an organisation concurrency slot.
 *
 * PAUSED counts: a paused scan keeps its checkpoint and will resume, so
 * releasing the slot would let a user park unlimited scans and defeat the
 * quota.
 */
export const QUOTA_OCCUPYING_SCAN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
] as const satisfies readonly ScanStatus[];

const TERMINAL = new Set<ScanStatus>(TERMINAL_SCAN_STATUSES);
const QUOTA_OCCUPYING = new Set<ScanStatus>(QUOTA_OCCUPYING_SCAN_STATUSES);

/**
 * The transition graph:
 *
 *   QUEUED  -> RUNNING | CANCELLED | FAILED
 *   RUNNING -> PAUSED | COMPLETED | FAILED | CANCELLED | ABORTED_SAFETY
 *   PAUSED  -> RUNNING | CANCELLED | FAILED
 *   terminal -> (nothing)
 */
const TRANSITIONS: Record<ScanStatus, readonly ScanStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABORTED_SAFETY'],
  PAUSED: ['RUNNING', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  ABORTED_SAFETY: [],
};

export function isTerminalScanStatus(status: ScanStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Narrowing guard for anything arriving from outside typed code: a query
 * parameter, a stored row, a message on the wire. `SCAN_STATUSES.includes` needs
 * a cast at every call site, and a cast is exactly what lets an unknown status
 * through.
 */
export function isScanStatus(value: unknown): value is ScanStatus {
  return (
    typeof value === 'string' &&
    (SCAN_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransition(from: ScanStatus, to: ScanStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function occupiesQuota(status: ScanStatus): boolean {
  return QUOTA_OCCUPYING.has(status);
}

/**
 * Control predicates, named separately from the graph so a refusal can say
 * which command was impossible rather than quoting a transition.
 */
export function canPause(status: ScanStatus): boolean {
  return status === 'RUNNING';
}

export function canResume(status: ScanStatus): boolean {
  return status === 'PAUSED';
}

export function canCancel(status: ScanStatus): boolean {
  return !TERMINAL.has(status);
}
