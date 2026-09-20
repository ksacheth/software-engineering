import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  POLL_INTERVAL_MS,
  isScanEvent,
  isTerminalScanStatus,
  mergeScanWarnings,
  type ScanWarning,
} from '@wvs/shared';
import {
  fetchScan,
  fetchScanFindings,
  type Scan,
  type ScanFindingSummary,
} from '@/services/scans';
import { useWebSocket, type WebSocketStatus } from '@/providers/websocket-provider';

/**
 * The live scan view's state.
 *
 * Two sources feed one view: a REST snapshot on mount and a stream of events
 * over the socket. One of them arrives late, so every event carries `at` and
 * the view keeps the newest timestamp it has applied; a snapshot older than
 * that is discarded, which is what stops the view going backwards.
 *
 * `scan.progress` is a snapshot, so a duplicate or out-of-order copy is
 * harmless. `scan.finding` is additive and accumulated by fingerprint, because
 * merging field-wise would let a second finding overwrite the first.
 */

/** A worker silent for this long is reported rather than left looking slow. */
const STALLED_AFTER_MS = 5 * 60_000;

interface LivePatch {
  at: string;
  fields: Partial<Scan>;
}

export interface LiveScanState {
  scan: Scan | undefined;
  isLoading: boolean;
  error: unknown;
  findings: ScanFindingSummary[];
  warnings: ScanWarning[];
  isPolling: boolean;
  isStalled: boolean;
  refresh: () => void;
}

function upsertFinding(
  findings: Map<string, ScanFindingSummary>,
  finding: ScanFindingSummary,
): boolean {
  if (findings.has(finding.fingerprint)) return false;
  findings.set(finding.fingerprint, finding);
  return true;
}

export function useLiveScan(
  scanJobId: string | undefined,
  socketStatus: WebSocketStatus,
): LiveScanState {
  const { subscribe } = useWebSocket();
  const queryClient = useQueryClient();

  const [patch, setPatch] = useState<LivePatch | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [streamedWarnings, setStreamedWarnings] = useState<ScanWarning[]>([]);
  const [findings, setFindings] = useState<ScanFindingSummary[]>([]);
  const findingsRef = useRef(new Map<string, ScanFindingSummary>());

  /**
   * Discard the previous scan's live state when the id changes.
   *
   * `/scans/:id` is one route, so React Router reuses this component when only
   * the parameter changes. Without this the previous scan's findings union
   * into the new scan's list, and its patch wins the `updatedAt` comparison
   * below, so a finished scan's status can render on a queued one.
   *
   * Rendered rather than deferred to an effect: an effect would let one paint
   * of the new id show the old scan's data.
   */
  const renderedScanJobId = useRef(scanJobId);
  if (renderedScanJobId.current !== scanJobId) {
    renderedScanJobId.current = scanJobId;
    findingsRef.current = new Map();
    setPatch(null);
    setLastEventAt(null);
    setStreamedWarnings([]);
    setFindings([]);
  }

  /**
   * Apply a patch: newest wins per field, and fields always accumulate.
   *
   * Events carry disjoint field sets. `scan.progress` carries counters,
   * `scan.status` carries a status, and neither carries the other. Replacing
   * the patch on a newer event would therefore drop whatever the previous
   * event contributed, and since the surviving patch still out-dates the REST
   * snapshot, the view falls back to the snapshot's older counters and
   * visibly moves backwards.
   *
   * So every event merges. A newer event wins the fields it carries and the
   * timestamp; an older one that arrives late fills only the gaps, because
   * what is already applied is by definition fresher.
   */
  const applyPatch = useCallback((at: string, fields: Partial<Scan>) => {
    setPatch((current) => {
      if (!current) return { at, fields };
      if (at < current.at) {
        return { at: current.at, fields: { ...fields, ...current.fields } };
      }
      return { at, fields: { ...current.fields, ...fields } };
    });
    setLastEventAt((current) => (current === null || at > current ? at : current));
  }, []);

  const scanQuery = useQuery({
    queryKey: ['scan', scanJobId],
    queryFn: () => fetchScan(scanJobId!),
    enabled: Boolean(scanJobId),
    // Polling fallback: while the socket is down and the scan is unfinished,
    // a slower view is better than a frozen one.
    refetchInterval: (query) => {
      const status = query.state.data?.scan.status;
      if (!status || isTerminalScanStatus(status)) return false;
      return socketStatus === 'connected' ? false : POLL_INTERVAL_MS;
    },
  });

  const findingsQuery = useQuery({
    queryKey: ['scan-findings', scanJobId],
    queryFn: () => fetchScanFindings(scanJobId!),
    enabled: Boolean(scanJobId),
  });

  // Seed from the durable projection so a reload does not lose what was seen
  // live. Streamed findings that arrived first are kept.
  useEffect(() => {
    let changed = false;
    for (const finding of findingsQuery.data?.findings ?? []) {
      changed = upsertFinding(findingsRef.current, finding) || changed;
    }
    if (changed) setFindings([...findingsRef.current.values()]);
  }, [findingsQuery.data]);

  useEffect(() => {
    if (!scanJobId) return;

    const unsubscribe = subscribe((message) => {
      if (!isScanEvent(message) || message.scanJobId !== scanJobId) return;

      switch (message.type) {
        case 'scan.progress': {
          applyPatch(message.at, {
            phase: message.phase,
            pagesCrawled: message.pagesCrawled,
            requestsMade: message.requestsMade,
            findingsCount: message.findingsCount,
            progressPercentage: message.progressPercentage,
          });
          return;
        }
        case 'scan.status': {
          applyPatch(message.at, {
            status: message.status,
            ...(message.phase ? { phase: message.phase } : {}),
            ...(message.failureReason !== undefined
              ? { failureReason: message.failureReason }
              : {}),
          });
          if (isTerminalScanStatus(message.status)) {
            void queryClient.invalidateQueries({ queryKey: ['scan', scanJobId] });
            void queryClient.invalidateQueries({ queryKey: ['scan-findings', scanJobId] });
            void queryClient.invalidateQueries({ queryKey: ['scans'] });
          }
          return;
        }
        case 'scan.finding': {
          const added = upsertFinding(findingsRef.current, {
            id: message.fingerprint,
            fingerprint: message.fingerprint,
            detectorId: message.detectorId,
            name: message.name,
            severity: message.severity,
            affectedUrl: message.affectedUrl,
            createdAt: message.at,
          });
          if (added) setFindings([...findingsRef.current.values()]);
          return;
        }
        case 'scan.warning': {
          // Additive and keyed by code, like the finding list: a second warning
          // must not overwrite the first.
          setStreamedWarnings((current) =>
            mergeScanWarnings(current, [{ code: message.code, message: message.message }]),
          );
          return;
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [scanJobId, subscribe, queryClient, applyPatch]);

  const refresh = useCallback(() => {
    setPatch(null);
    void scanQuery.refetch();
  }, [scanQuery]);

  const snapshot = scanQuery.data?.scan;

  // A snapshot older than the newest applied event is stale; applying it would
  // make the view go backwards.
  const usePatch =
    patch !== null &&
    snapshot !== undefined &&
    new Date(patch.at).getTime() >= new Date(snapshot.updatedAt).getTime();

  /**
   * Warnings merge whatever the patch is doing.
   *
   * A warning is an event that happened, not a field that can be superseded, so
   * it has no place in the freshness comparison above. Merging it only in the
   * patch branch meant a `scan.warning` arriving on its own was dropped, since
   * a warning sets no patch: the degradation the user most needs to see is the
   * one least likely to be accompanied by anything else.
   */
  const scan: Scan | undefined = snapshot
    ? {
        ...snapshot,
        ...(usePatch ? patch.fields : {}),
        warnings: mergeScanWarnings(snapshot.warnings, streamedWarnings),
      }
    : undefined;

  const isPolling =
    Boolean(scan) && !isTerminalScanStatus(scan!.status) && socketStatus !== 'connected';

  // A stalled worker is visible rather than looking like a slow scan. Any live
  // event counts as progress, so a scan streaming updates is never reported as
  // stalled however old its row happens to be.
  const lastSignalAt = Math.max(
    new Date(snapshot?.updatedAt ?? 0).getTime(),
    new Date(lastEventAt ?? 0).getTime(),
  );
  const isStalled =
    Boolean(scan) &&
    (scan!.status === 'QUEUED' || scan!.status === 'RUNNING') &&
    Date.now() - lastSignalAt > STALLED_AFTER_MS;

  return {
    scan,
    isLoading: scanQuery.isLoading,
    error: scanQuery.error,
    findings,
    warnings: scan?.warnings ?? [],
    isPolling,
    isStalled,
    refresh,
  };
}
