/**
 * F.3 scan profiles and per-scan configuration bounds.
 *
 * The SRS names the three profiles but never defines their contents. These
 * presets are a judgement call, derived from NFR-PERF-2 (a Standard scan of a
 * 200-page target within 15 minutes) and constrained by F.8 (10 requests per
 * second per target is system policy).
 *
 * Profiles vary depth and breadth, not request rate: a more thorough profile
 * cannot be a faster one.
 */
export const SCAN_PROFILES = ['PASSIVE', 'STANDARD', 'THOROUGH'] as const;

export type ScanProfile = (typeof SCAN_PROFILES)[number];

export interface ScanConfiguration {
  /** Requests per second per target. F.8 caps this at 10. */
  rateLimit: number;
  /** Parallel in-flight requests. */
  concurrency: number;
  /** Maximum link depth reached from the target origin. */
  maxDepth: number;
  /** Maximum pages crawled in one scan. */
  maxPages: number;
  /** Maximum requests issued in one scan. */
  maxRequests: number;
}

export const SCAN_PROFILE_PRESETS: Record<ScanProfile, ScanConfiguration> = {
  PASSIVE: { rateLimit: 5, concurrency: 5, maxDepth: 3, maxPages: 100, maxRequests: 1000 },
  STANDARD: { rateLimit: 10, concurrency: 5, maxDepth: 5, maxPages: 200, maxRequests: 2000 },
  THOROUGH: { rateLimit: 10, concurrency: 5, maxDepth: 10, maxPages: 1000, maxRequests: 10000 },
};

/**
 * Absolute bounds for a single scan.
 *
 * A user may be gentler than their preset but never more aggressive than
 * system policy: 10 requests per second is F.8's hard limit, and the remaining
 * ceilings are bounded by the widest preset so a hand-rolled configuration
 * cannot ask for an unbounded crawl.
 */
export const SCAN_CONFIGURATION_BOUNDS: Record<
  keyof ScanConfiguration,
  { min: number; max: number }
> = {
  rateLimit: { min: 1, max: 10 },
  concurrency: { min: 1, max: 10 },
  maxDepth: { min: 1, max: 10 },
  maxPages: { min: 1, max: 1000 },
  maxRequests: { min: 1, max: 10000 },
};

const FIELD_LABELS: Record<keyof ScanConfiguration, string> = {
  rateLimit: 'Request rate',
  concurrency: 'Concurrency',
  maxDepth: 'Crawl depth',
  maxPages: 'Page ceiling',
  maxRequests: 'Request ceiling',
};

export type ScanConfigurationProblemCode =
  | 'NOT_AN_INTEGER'
  | 'TOO_LOW'
  | 'TOO_HIGH'
  | 'REQUESTS_BELOW_PAGES';

export interface ScanConfigurationProblem {
  field: keyof ScanConfiguration;
  code: ScanConfigurationProblemCode;
  message: string;
}

export interface ResolvedScanConfiguration {
  configuration?: ScanConfiguration;
  /** Every problem found in one pass, so a caller can fix them in one edit. */
  problems: ScanConfigurationProblem[];
}

/**
 * Resolve a profile plus per-scan overrides into the configuration the scan
 * will actually run with.
 *
 * Omitted fields take the preset value. Every problem is collected rather than
 * thrown on the first, because a user fixing one error per round trip is a
 * worse experience than fixing all of them at once.
 */
export function resolveScanConfiguration(
  profile: ScanProfile,
  overrides: Partial<ScanConfiguration>,
): ResolvedScanConfiguration {
  const problems: ScanConfigurationProblem[] = [];
  const configuration = { ...SCAN_PROFILE_PRESETS[profile] };

  for (const key of Object.keys(SCAN_CONFIGURATION_BOUNDS) as (keyof ScanConfiguration)[]) {
    const override = overrides[key];
    if (override === undefined) continue;

    const { min, max } = SCAN_CONFIGURATION_BOUNDS[key];
    const label = FIELD_LABELS[key];

    if (!Number.isInteger(override)) {
      problems.push({
        field: key,
        code: 'NOT_AN_INTEGER',
        message: `${label} must be a whole number.`,
      });
      continue;
    }

    if (override < min) {
      problems.push({
        field: key,
        code: 'TOO_LOW',
        message: `${label} must be at least ${min}.`,
      });
      continue;
    }

    if (override > max) {
      problems.push({
        field: key,
        code: 'TOO_HIGH',
        message: `${label} must not exceed ${max}.`,
      });
      continue;
    }

    configuration[key] = override;
  }

  if (
    !problems.some((problem) =>
      problem.field === 'maxPages' || problem.field === 'maxRequests',
    ) &&
    configuration.maxRequests < configuration.maxPages
  ) {
    problems.push({
      field: 'maxRequests',
      code: 'REQUESTS_BELOW_PAGES',
      message:
        'The request ceiling must be at least the page ceiling, or the scan would stop for the wrong reason.',
    });
  }

  if (problems.length > 0) {
    return { problems };
  }

  return { configuration, problems };
}
