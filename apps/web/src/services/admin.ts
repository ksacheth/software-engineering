import type { OrganizationQuota } from "@wvs/shared";

/**
 * F.8 administration API (ADR-0009).
 *
 * Follows the scans service conventions: plain async functions, same-origin
 * cookies, and RFC 9457 problem details surfaced as an error carrying the
 * machine-readable `code`, so the page can tell "enable 2FA first" apart from
 * an ordinary refusal.
 */

export type Role = "ADMIN" | "ANALYST" | "DEVELOPER" | "VIEWER";
export const ROLES: Role[] = ["ADMIN", "ANALYST", "DEVELOPER", "VIEWER"];

export interface ProblemFieldError {
  pointer?: string;
  detail: string;
}

export class AdminApiError extends Error {
  status: number;
  code?: string;
  errors?: ProblemFieldError[];

  constructor(
    status: number,
    message: string,
    options: { code?: string; errors?: ProblemFieldError[] } = {},
  ) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = options.code;
    this.errors = options.errors;
  }
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as unknown as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new AdminApiError(
      res.status,
      data?.detail || data?.title || data?.error || `Request failed with status ${res.status}`,
      { code: data?.code, errors: data?.errors },
    );
  }
  return data as T;
}

const post = <T>(path: string, body: unknown) =>
  send<T>(path, { method: "POST", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  send<T>(path, { method: "PATCH", body: JSON.stringify(body) });

// ----------------------------------------------------------- kill switch ---

export interface KillSwitch {
  engaged: boolean;
  changedAt: string | null;
  reason: string | null;
  changedBy: { id: string; email: string; name: string } | null;
}

export const fetchKillSwitch = () =>
  send<{ killSwitch: KillSwitch }>("/kill-switch");

export const engageKillSwitch = (reason: string) =>
  post<{ killSwitch: KillSwitch; abortedScans: number }>(
    "/kill-switch/engage",
    { reason },
  );

export const releaseKillSwitch = (reason: string) =>
  post<{ killSwitch: KillSwitch }>("/kill-switch/release", { reason });

// ---------------------------------------------------------------- health ---

type Probe<T> = T | { ok: false; error: string };

export interface Health {
  database: Probe<{ ok: true }>;
  redis: Probe<{ ok: true }>;
  queue: Probe<{ waiting: number; active: number; delayed: number; failed: number }>;
  scans: Probe<Record<string, number>>;
  killSwitch: Probe<{ engaged: boolean }>;
  email: Probe<{ pending: number; deadLettered: number; oldestPendingAt: string | null }>;
}

export const fetchHealth = () => send<Health>("/health");

// ----------------------------------------------------------------- users ---

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: Role;
  twoFactorEnabled: boolean;
  suspendedAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  organization: { id: string; name: string } | null;
  lastSignInAt: string | null;
}

export function fetchUsers(q = "", cursor?: string) {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return send<{ users: AdminUser[]; nextCursor: string | null }>(
    `/users${query ? `?${query}` : ""}`,
  );
}

export const changeUserRole = (userId: string, role: Role) =>
  patch<{ user: AdminUser }>(`/users/${userId}/role`, { role });

export const suspendUser = (userId: string, reason: string) =>
  post<{ user: AdminUser }>(`/users/${userId}/suspend`, { reason });

export const unsuspendUser = (userId: string, reason: string) =>
  post<{ user: AdminUser }>(`/users/${userId}/unsuspend`, { reason });

// --------------------------------------------------------- organisations ---

export interface AdminOrganization extends OrganizationQuota {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  memberCount: number;
  activeScans: number;
}

export const fetchOrganizations = () =>
  send<{ organizations: AdminOrganization[] }>("/organizations");

export const updateQuota = (
  organizationId: string,
  quota: Partial<OrganizationQuota>,
) =>
  patch<{ organization: OrganizationQuota }>(
    `/organizations/${organizationId}/quota`,
    quota,
  );

// ------------------------------------------------------------- blocklist ---

export type BlocklistPatternType = "CIDR" | "HOST_SUFFIX" | "IP_RANGE";

export interface BlocklistEntry {
  id: string;
  pattern: string;
  patternType: BlocklistPatternType;
  reason: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string; name: string } | null;
}

export const fetchBlocklist = () =>
  send<{ entries: BlocklistEntry[] }>("/blocklist");

export const createBlocklistEntry = (input: {
  patternType: BlocklistPatternType;
  pattern: string;
  reason: string;
}) => post<{ entry: BlocklistEntry }>("/blocklist", input);

export const updateBlocklistEntry = (
  id: string,
  changes: { isActive?: boolean; reason?: string },
) => patch<{ entry: BlocklistEntry }>(`/blocklist/${id}`, changes);

export const deleteBlocklistEntry = (id: string) =>
  send<void>(`/blocklist/${id}`, { method: "DELETE" });

// ----------------------------------------------------------------- audit ---

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  organizationId: string | null;
  userId: string | null;
  ipAddress: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  user: { id: string; email: string; name: string } | null;
  organization: { id: string; name: string } | null;
}

export interface AuditFilters {
  action?: string;
  organizationId?: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
}

export function fetchAudit(filters: AuditFilters, cursor?: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return send<{ entries: AuditEntry[]; nextCursor: string | null }>(
    `/audit${query ? `?${query}` : ""}`,
  );
}
