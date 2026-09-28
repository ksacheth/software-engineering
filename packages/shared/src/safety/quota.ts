import { SCAN_CONFIGURATION_BOUNDS } from "../scans/profiles.js";

/**
 * F.8 organisation quotas: the limits an administrator may set.
 *
 * `scanRateLimit` is capped at the same ceiling as a single scan's request
 * rate. F.8's 10 requests per second is a safety limit, not an operational
 * default, so no quota may raise it. `maxConcurrentScans` may be zero, which
 * suspends the organisation's scanning without touching scans already running.
 */
export const ORGANIZATION_QUOTA_BOUNDS = {
  maxConcurrentScans: { min: 0, max: 20 },
  scanRateLimit: { ...SCAN_CONFIGURATION_BOUNDS.rateLimit },
} as const;

export interface OrganizationQuota {
  maxConcurrentScans: number;
  scanRateLimit: number;
}
