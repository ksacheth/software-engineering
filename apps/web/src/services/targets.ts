export type VerificationMethod = 'DNS_TXT' | 'WELL_KNOWN';

export type TargetVerificationStatus =
  | 'UNVERIFIED'
  | 'PENDING'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'FAILED';

export type NotScannableReason =
  | 'ARCHIVED'
  | 'NOT_VERIFIED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_EXPIRED'
  | 'NO_VERIFIED_ADDRESSES'
  | 'AUTHORISATION_NOT_ACKNOWLEDGED';

export interface ScannableVerdict {
  scannable: boolean;
  reason?: NotScannableReason;
}

export interface Target {
  id: string;
  organizationId: string;
  origin: string;
  label: string;
  verificationToken?: string;
  verificationMethod: VerificationMethod;
  verificationStatus: TargetVerificationStatus;
  verifiedAt: string | null;
  verificationExpiresAt: string | null;
  authorisationAck: boolean;
  authorisationAckAt: string | null;
  authorisationAckById: string | null;
  verifiedIpRanges: string[];
  includedPaths: string[];
  excludedPaths: string[];
  maxDepth: number;
  maxPages: number;
  maxRequests: number;
  rateLimit: number;
  isArchived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
}

export type TargetWithScannable = Target & {
  scannable: ScannableVerdict;
};

export type VerificationInstructions =
  | {
      method: 'DNS_TXT';
      recordName: string;
      recordType: 'TXT';
      recordValue: string;
    }
  | {
      method: 'WELL_KNOWN';
      url: string;
      content: string;
    };

export type LimitRefusal =
  | { kind: 'TOO_SOON'; retryAfterSeconds: number }
  | { kind: 'HOURLY_QUOTA'; retryAfterSeconds: number }
  | { kind: 'ORG_CONCURRENCY' };

export type OriginProblem =
  | 'MALFORMED'
  | 'UNSUPPORTED_SCHEME'
  | 'HAS_PATH'
  | 'HAS_CREDENTIALS'
  | 'IS_IP_LITERAL';

export type ResolutionFailure = 'NXDOMAIN' | 'NO_ADDRESSES' | 'DNS_ERROR';

export type OriginRefusal =
  | { kind: 'ORIGIN'; problem: OriginProblem; detail?: string }
  | { kind: 'RESOLUTION'; failure: ResolutionFailure; detail?: string }
  | { kind: 'ADDRESS'; reason: string; detail?: string };

export type ChallengeFailure =
  | 'NO_RECORD'
  | 'TOKEN_MISMATCH'
  | 'LOOKUP_FAILED'
  | 'HTTP_ERROR'
  | 'TIMEOUT';

export class TargetApiError extends Error {
  status: number;
  rule?: any;
  targetId?: string;

  constructor(status: number, message: string, rule?: any, targetId?: string) {
    super(message);
    this.name = 'TargetApiError';
    this.status = status;
    this.rule = rule;
    this.targetId = targetId;
  }
}

export interface RegisterTargetInput {
  origin: string;
  label: string;
  verificationMethod: VerificationMethod;
  authorisationAck: boolean;
  includedPaths?: string[];
  excludedPaths?: string[];
}

export interface UpdateScopeInput {
  includedPaths: string[];
  excludedPaths: string[];
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error || `Request failed with status ${res.status}`;
    throw new TargetApiError(res.status, message, data?.rule, data?.targetId);
  }
  return data as T;
}

export async function fetchTargets(includeArchived = false): Promise<{ targets: TargetWithScannable[] }> {
  const res = await fetch(`/api/targets?includeArchived=${includeArchived}`, {
    credentials: 'same-origin',
  });
  return handleResponse<{ targets: TargetWithScannable[] }>(res);
}

export async function registerTarget(
  input: RegisterTargetInput,
): Promise<{ target: Target; instructions: VerificationInstructions }> {
  const res = await fetch('/api/targets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
  });
  return handleResponse<{ target: Target; instructions: VerificationInstructions }>(res);
}

export async function getTarget(
  id: string,
): Promise<{ target: Target; instructions: VerificationInstructions; scannable: ScannableVerdict }> {
  const res = await fetch(`/api/targets/${id}`, {
    credentials: 'same-origin',
  });
  return handleResponse<{ target: Target; instructions: VerificationInstructions; scannable: ScannableVerdict }>(res);
}

export async function verifyTarget(
  id: string,
): Promise<{ target: Target; scannable: ScannableVerdict }> {
  const res = await fetch(`/api/targets/${id}/verify`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  return handleResponse<{ target: Target; scannable: ScannableVerdict }>(res);
}

export async function updateTargetScope(
  id: string,
  scope: UpdateScopeInput,
): Promise<{ target: Target }> {
  const res = await fetch(`/api/targets/${id}/scope`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope),
    credentials: 'same-origin',
  });
  return handleResponse<{ target: Target }>(res);
}

export async function archiveTarget(id: string): Promise<{ target: Target }> {
  const res = await fetch(`/api/targets/${id}/archive`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  return handleResponse<{ target: Target }>(res);
}

export async function deleteTarget(id: string): Promise<void> {
  const res = await fetch(`/api/targets/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  return handleResponse<void>(res);
}
