import { describe, expect, test } from 'bun:test';
import {
  resolveScanConfiguration,
  SCAN_PROFILE_PRESETS,
  type ScanConfiguration,
} from './profiles.js';

/** Independent source of truth: the profile table in issue #3. */
const PRESET_TABLE: [keyof typeof SCAN_PROFILE_PRESETS, ScanConfiguration][] = [
  [
    'PASSIVE',
    { rateLimit: 5, concurrency: 5, maxDepth: 3, maxPages: 100, maxRequests: 1000 },
  ],
  [
    'STANDARD',
    { rateLimit: 10, concurrency: 5, maxDepth: 5, maxPages: 200, maxRequests: 2000 },
  ],
  [
    'THOROUGH',
    { rateLimit: 10, concurrency: 5, maxDepth: 10, maxPages: 1000, maxRequests: 10000 },
  ],
];

describe('profile presets', () => {
  for (const [profile, expected] of PRESET_TABLE) {
    test(`${profile} matches the specified preset`, () => {
      expect(SCAN_PROFILE_PRESETS[profile]).toEqual(expected);
    });
  }
});

describe('resolution without overrides', () => {
  for (const [profile, expected] of PRESET_TABLE) {
    test(`${profile} resolves to its preset`, () => {
      const resolved = resolveScanConfiguration(profile, {});
      expect(resolved.problems).toEqual([]);
      expect(resolved.configuration).toEqual(expected);
    });
  }
});

describe('overrides replace named fields only', () => {
  test('a gentler rate keeps every other preset value', () => {
    const resolved = resolveScanConfiguration('STANDARD', { rateLimit: 2 });
    expect(resolved.problems).toEqual([]);
    expect(resolved.configuration).toEqual({
      rateLimit: 2,
      concurrency: 5,
      maxDepth: 5,
      maxPages: 200,
      maxRequests: 2000,
    });
  });

  test('a gentler ceiling on a Thorough scan lowers only that ceiling', () => {
    const resolved = resolveScanConfiguration('THOROUGH', {
      maxPages: 50,
      maxRequests: 500,
    });
    expect(resolved.problems).toEqual([]);
    expect(resolved.configuration).toEqual({
      rateLimit: 10,
      concurrency: 5,
      maxDepth: 10,
      maxPages: 50,
      maxRequests: 500,
    });
  });
});

describe('bounds', () => {
  const refused: [string, Partial<ScanConfiguration>][] = [
    ['rate below one', { rateLimit: 0 }],
    ['rate above the 10 req/s policy cap', { rateLimit: 11 }],
    ['fractional rate', { rateLimit: 2.5 }],
    ['zero concurrency', { concurrency: 0 }],
    ['concurrency above the ceiling', { concurrency: 11 }],
    ['zero depth', { maxDepth: 0 }],
    ['depth beyond the widest preset', { maxDepth: 11 }],
    ['zero pages', { maxPages: 0 }],
    ['pages beyond the widest preset', { maxPages: 1001 }],
    ['zero requests', { maxRequests: 0 }],
    ['requests beyond the widest preset', { maxRequests: 10001 }],
  ];

  for (const [label, override] of refused) {
    test(`${label} is refused`, () => {
      const resolved = resolveScanConfiguration('STANDARD', override);
      expect(resolved.problems.length).toBeGreaterThan(0);
      expect(resolved.configuration).toBeUndefined();
    });
  }
});

describe('request ceiling below page ceiling', () => {
  test('is refused because the request ceiling would bind every scan', () => {
    const resolved = resolveScanConfiguration('STANDARD', {
      maxPages: 200,
      maxRequests: 100,
    });
    expect(resolved.problems.map((problem) => problem.code)).toContain(
      'REQUESTS_BELOW_PAGES',
    );
    expect(resolved.configuration).toBeUndefined();
  });

  test('equal ceilings are allowed', () => {
    const resolved = resolveScanConfiguration('STANDARD', {
      maxPages: 200,
      maxRequests: 200,
    });
    expect(resolved.problems).toEqual([]);
    expect(resolved.configuration?.maxRequests).toBe(200);
  });
});

describe('every problem is reported at once', () => {
  test('three bad fields produce three problems, not one', () => {
    const resolved = resolveScanConfiguration('PASSIVE', {
      rateLimit: 99,
      maxDepth: 0,
      maxRequests: -1,
    });
    expect(resolved.configuration).toBeUndefined();
    expect(resolved.problems).toHaveLength(3);
    expect(resolved.problems.map((problem) => problem.field).sort()).toEqual([
      'maxDepth',
      'maxRequests',
      'rateLimit',
    ]);
  });

  test('each problem names its field and explains itself', () => {
    const resolved = resolveScanConfiguration('PASSIVE', { rateLimit: 99 });
    const [problem] = resolved.problems;
    expect(problem!.field).toBe('rateLimit');
    expect(problem!.code).toBe('TOO_HIGH');
    expect(problem!.message).toContain('10');
  });
});
