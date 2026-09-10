import { SCAN_PHASES, SCAN_STATUSES, type ScanPhase, type ScanStatus } from './lifecycle.js';

/**
 * F.3 live scan events.
 *
 * SRS §3.2.4 names exactly four events. Those names are used verbatim as the
 * `type` discriminator, because the dashboard already dispatches on `type` and
 * reads `scanJobId` from the top level.
 *
 * Every event carries `scanJobId` and an ISO 8601 UTC `at`. The timestamp is
 * load-bearing: the live view both fetches current state and subscribes on
 * mount, and one of those will arrive late. The client keeps a last-applied
 * timestamp and discards any snapshot older than what it holds, so the view
 * cannot go backwards.
 */

export const SCAN_EVENT_TYPES = [
  'scan.status',
  'scan.progress',
  'scan.finding',
  'scan.warning',
] as const;

export type ScanEventType = (typeof SCAN_EVENT_TYPES)[number];

export const SCAN_WARNING_CODES = [
  'DNS_RESOLUTION_FAILED',
  'RENDERING_UNAVAILABLE',
  'ADVISORY_DATA_UNAVAILABLE',
  'TARGET_BLOCKING_DETECTED',
  'CRAWL_LIMIT_REACHED',
] as const;

export type ScanWarningCode = (typeof SCAN_WARNING_CODES)[number];

/** Duplicated from the Prisma enum; the API asserts the two stay assignable. */
export const FINDING_SEVERITIES = [
  'INFO',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ScanEventBase {
  scanJobId: string;
  /** ISO 8601 UTC, e.g. 2026-09-11T09:15:00.000Z. */
  at: string;
}

export interface ScanStatusEvent extends ScanEventBase {
  type: 'scan.status';
  status: ScanStatus;
  /** Present when the publisher knows the phase; optional so a terminal
   * status can be published without inventing one. */
  phase?: ScanPhase;
  /** Present when the status is FAILED or ABORTED_SAFETY. */
  failureReason?: string | null;
}

/**
 * A snapshot, not a delta: duplicated or late progress messages are harmless.
 */
export interface ScanProgressEvent extends ScanEventBase {
  type: 'scan.progress';
  phase: ScanPhase;
  pagesCrawled: number;
  requestsMade: number;
  findingsCount: number;
  progressPercentage: number;
}

/**
 * Additive. Consumers accumulate findings by fingerprint; merging field-wise
 * would let a second finding overwrite the first.
 */
export interface ScanFindingEvent extends ScanEventBase {
  type: 'scan.finding';
  fingerprint: string;
  detectorId: string;
  name: string;
  severity: FindingSeverity;
  affectedUrl: string;
}

export interface ScanWarningEvent extends ScanEventBase {
  type: 'scan.warning';
  code: ScanWarningCode;
  message: string;
}

export type ScanEvent =
  | ScanStatusEvent
  | ScanProgressEvent
  | ScanFindingEvent
  | ScanWarningEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasScanEnvelope(value: Record<string, unknown>): boolean {
  if (typeof value.scanJobId !== 'string' || value.scanJobId.length === 0) {
    return false;
  }
  if (typeof value.at !== 'string') return false;
  const parsed = new Date(value.at);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value.at;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Runtime guard for anything arriving off the Redis channel.
 *
 * The channel is shared with the orchestrator, so a malformed or foreign
 * message must be dropped rather than fanned out to WebSocket clients as
 * though it were a scan event.
 */
export function isScanEvent(value: unknown): value is ScanEvent {
  if (!isRecord(value) || !hasScanEnvelope(value)) return false;

  switch (value.type) {
    case 'scan.status':
      return (
        isOneOf(value.status, SCAN_STATUSES) &&
        (value.phase === undefined || isOneOf(value.phase, SCAN_PHASES)) &&
        (value.failureReason === undefined ||
          value.failureReason === null ||
          typeof value.failureReason === 'string')
      );
    case 'scan.progress':
      return (
        isOneOf(value.phase, SCAN_PHASES) &&
        isNonNegativeNumber(value.pagesCrawled) &&
        isNonNegativeNumber(value.requestsMade) &&
        isNonNegativeNumber(value.findingsCount) &&
        isNonNegativeNumber(value.progressPercentage)
      );
    case 'scan.finding':
      return (
        typeof value.fingerprint === 'string' &&
        typeof value.detectorId === 'string' &&
        typeof value.name === 'string' &&
        isOneOf(value.severity, FINDING_SEVERITIES) &&
        typeof value.affectedUrl === 'string'
      );
    case 'scan.warning':
      return (
        isOneOf(value.code, SCAN_WARNING_CODES) &&
        typeof value.message === 'string'
      );
    default:
      return false;
  }
}
