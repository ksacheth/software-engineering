import type {
  ScanConfiguration,
  ScanPhase,
  ScanProfile,
  ScanStatus,
  ScanWarning,
} from '@wvs/shared';

/**
 * F.3 scan service.
 *
 * Follows the targets service conventions: plain async functions, same-origin
 * credentials, TanStack Query at the call sites. Scan endpoints answer with
 * RFC 9457 problem details, so the error carries the machine-readable `code`
 * as well as the human-readable detail.
 */

export type { ScanConfiguration, ScanPhase, ScanProfile, ScanStatus, ScanWarning };

export interface ScanTargetRef {
  id: string;
  label: string;
  origin: string;
}

export interface Scan {
  id: string;
  organizationId: string;
  targetId: string;
  target: ScanTargetRef | null;
  /** Who requested the scan, so activity can be attributed. */
  startedBy: { id: string; name: string } | null;
  scheduleId: string | null;
  profile: ScanProfile;
  status: ScanStatus;
  phase: ScanPhase;
  configuration: ScanConfiguration;
  includedPaths: string[];
  excludedPaths: string[];
  detectorVersions: unknown;
  workerId: string | null;
  pagesCrawled: number;
  requestsMade: number;
  findingsCount: number;
  progressPercentage: number;
  isDegraded: boolean;
  blockingDetected: boolean;
  bindingLimit: string | null;
  failureReason: string | null;
  warnings: ScanWarning[];
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
}

export interface ProblemFieldError {
  pointer?: string;
  detail: string;
}

export class ScanApiError extends Error {
  status: number;
  code?: string;
  scanStatus?: string;
  errors?: ProblemFieldError[];

  constructor(
    status: number,
    message: string,
    options: { code?: string; scanStatus?: string; errors?: ProblemFieldError[] } = {},
  ) {
    super(message);
    this.name = 'ScanApiError';
    this.status = status;
    this.code = options.code;
    this.scanStatus = options.scanStatus;
    this.errors = options.errors;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as unknown as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ScanApiError(
      res.status,
      data?.detail || data?.error || `Request failed with status ${res.status}`,
      { code: data?.code, scanStatus: data?.scanStatus, errors: data?.errors },
    );
  }
  return data as T;
}

export interface StartScanInput {
  targetId: string;
  profile: ScanProfile;
  configuration?: Partial<ScanConfiguration>;
}

export async function startScan(input: StartScanInput): Promise<{ scan: Scan }> {
  const res = await fetch('/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
  });
  return handleResponse<{ scan: Scan }>(res);
}

export interface ScanListFilters {
  targetId?: string;
  status?: ScanStatus;
}

export async function fetchScans(
  filters: ScanListFilters,
  cursor?: string,
): Promise<{ scans: Scan[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (filters.targetId) params.set('targetId', filters.targetId);
  if (filters.status) params.set('status', filters.status);
  if (cursor) params.set('cursor', cursor);

  const query = params.toString();
  const res = await fetch(`/api/scans${query ? `?${query}` : ''}`, {
    credentials: 'same-origin',
  });
  return handleResponse<{ scans: Scan[]; nextCursor: string | null }>(res);
}

export async function fetchScan(id: string): Promise<{ scan: Scan }> {
  const res = await fetch(`/api/scans/${id}`, { credentials: 'same-origin' });
  return handleResponse<{ scan: Scan }>(res);
}

/**
 * The durable finding list for a scan.
 *
 * Read-only identity and severity, so a finding streamed live is still visible
 * after a reload. F.6 owns deduplication, diff status, triage and evidence.
 */
export interface ScanFindingSummary {
  id: string;
  fingerprint: string;
  detectorId: string;
  name: string;
  severity: string;
  affectedUrl: string;
  createdAt: string;
}

export async function fetchScanFindings(
  id: string,
): Promise<{ findings: ScanFindingSummary[] }> {
  const res = await fetch(`/api/scans/${id}/findings`, { credentials: 'same-origin' });
  return handleResponse<{ findings: ScanFindingSummary[] }>(res);
}

export async function pauseScan(id: string): Promise<{ scan: Scan }> {
  const res = await fetch(`/api/scans/${id}/pause`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  return handleResponse<{ scan: Scan }>(res);
}

export async function resumeScan(id: string): Promise<{ scan: Scan }> {
  const res = await fetch(`/api/scans/${id}/resume`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  return handleResponse<{ scan: Scan }>(res);
}

export async function cancelScan(id: string): Promise<{ scan: Scan }> {
  const res = await fetch(`/api/scans/${id}/cancel`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  return handleResponse<{ scan: Scan }>(res);
}
