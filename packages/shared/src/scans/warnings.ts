import { SCAN_WARNING_CODES, type ScanWarningCode } from './events.js';

/**
 * Warnings survive a page reload.
 *
 * Live `scan.warning` events are transient: a user who reloads mid-scan, or
 * opens a completed scan later, still needs to see that JavaScript rendering
 * was unavailable or that a ceiling bound the crawl. The scan row is the
 * durable copy, so the dashboard derives the same warning list from it.
 */

export interface ScanWarning {
  code: ScanWarningCode;
  message: string;
}

/** The row fields warnings are derived from, declared structurally. */
export interface ScanWarningSource {
  /** ScanJob.degradations, a JSON array written by the orchestrator. */
  degradations: unknown;
  /** ScanJob.blockingDetected. */
  blockingDetected: boolean;
  /** ScanJob.bindingLimit. */
  bindingLimit: string | null;
}

const CRAWL_CEILING_LIMITS: Record<string, string> = {
  DEPTH_REACHED: 'The configured crawl depth bound this scan.',
  PAGE_CEILING_REACHED: 'The configured page ceiling bound this scan.',
  REQUEST_CEILING_REACHED: 'The configured request ceiling bound this scan.',
  TIMEOUT: 'The scan stopped at its time limit.',
};

function isWarningCode(value: unknown): value is ScanWarningCode {
  return (
    typeof value === 'string' &&
    (SCAN_WARNING_CODES as readonly string[]).includes(value)
  );
}

function parseDegradations(value: unknown): ScanWarning[] {
  if (!Array.isArray(value)) return [];

  const warnings: ScanWarning[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { code?: unknown; message?: unknown };
    if (!isWarningCode(candidate.code)) continue;
    warnings.push({
      code: candidate.code,
      message:
        typeof candidate.message === 'string' && candidate.message.length > 0
          ? candidate.message
          : candidate.code,
    });
  }
  return warnings;
}

export function deriveScanWarnings(source: ScanWarningSource): ScanWarning[] {
  const byCode = new Map<ScanWarningCode, ScanWarning>();

  for (const warning of parseDegradations(source.degradations)) {
    addWarning(byCode, warning);
  }

  if (source.blockingDetected) {
    addWarning(byCode, {
      code: 'TARGET_BLOCKING_DETECTED',
      message:
        'The target appeared to block the scan, so results carry reduced confidence.',
    });
  }

  const limitMessage = source.bindingLimit
    ? CRAWL_CEILING_LIMITS[source.bindingLimit]
    : undefined;
  if (limitMessage) {
    addWarning(byCode, { code: 'CRAWL_LIMIT_REACHED', message: limitMessage });
  }

  return [...byCode.values()];
}

/** First writer wins, so a richer worker-recorded degradation is not replaced. */
function addWarning(
  byCode: Map<ScanWarningCode, ScanWarning>,
  warning: ScanWarning,
): void {
  if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
}

/**
 * Combine two warning lists, first one winning per code.
 *
 * The live view merges the warnings streamed over the socket with the ones the
 * scan row already records, and needs the same de-duplication rule the row
 * projection uses: one warning per code, never two.
 */
export function mergeScanWarnings(
  current: readonly ScanWarning[],
  incoming: readonly ScanWarning[],
): ScanWarning[] {
  const byCode = new Map<ScanWarningCode, ScanWarning>();
  for (const warning of current) addWarning(byCode, warning);
  for (const warning of incoming) addWarning(byCode, warning);
  return [...byCode.values()];
}
