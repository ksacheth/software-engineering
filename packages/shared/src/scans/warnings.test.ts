import { describe, expect, test } from 'bun:test';
import { deriveScanWarnings, mergeScanWarnings } from './warnings.js';

const NO_SIGNALS = {
  degradations: [],
  blockingDetected: false,
  bindingLimit: null,
};

describe('a clean scan has no warnings', () => {
  test('no degradations, no blocking, no binding limit', () => {
    expect(deriveScanWarnings(NO_SIGNALS)).toEqual([]);
  });

  test('a run that exhausted its frontier is not a warning', () => {
    expect(
      deriveScanWarnings({ ...NO_SIGNALS, bindingLimit: 'QUEUE_EXHAUSTED' }),
    ).toEqual([]);
  });

  test('a cancelled run is not a crawl ceiling warning', () => {
    expect(
      deriveScanWarnings({ ...NO_SIGNALS, bindingLimit: 'CANCELLED' }),
    ).toEqual([]);
  });
});

describe('recorded degradations are reported', () => {
  test('a rendering degradation survives with its message', () => {
    const warnings = deriveScanWarnings({
      ...NO_SIGNALS,
      degradations: [
        {
          code: 'RENDERING_UNAVAILABLE',
          message: 'JavaScript rendering was unavailable; static HTML was crawled.',
        },
      ],
    });
    expect(warnings).toEqual([
      {
        code: 'RENDERING_UNAVAILABLE',
        message: 'JavaScript rendering was unavailable; static HTML was crawled.',
      },
    ]);
  });

  test('junk in the JSON column is ignored, not thrown', () => {
    const warnings = deriveScanWarnings({
      ...NO_SIGNALS,
      degradations: [
        null,
        'RENDERING_UNAVAILABLE',
        { code: 'ALIENS', message: 'x' },
        { code: 'ADVISORY_DATA_UNAVAILABLE', message: 'Advisory data unavailable.' },
      ],
    });
    expect(warnings).toEqual([
      { code: 'ADVISORY_DATA_UNAVAILABLE', message: 'Advisory data unavailable.' },
    ]);
  });

  test('a degradation without a message falls back to its code', () => {
    const warnings = deriveScanWarnings({
      ...NO_SIGNALS,
      degradations: [{ code: 'DNS_RESOLUTION_FAILED' }],
    });
    expect(warnings[0]!.message).toBe('DNS_RESOLUTION_FAILED');
  });

  test('a non-array JSON value yields nothing', () => {
    expect(deriveScanWarnings({ ...NO_SIGNALS, degradations: {} })).toEqual([]);
  });
});

describe('derived signals', () => {
  test('blocking is reported in confidence terms', () => {
    const warnings = deriveScanWarnings({ ...NO_SIGNALS, blockingDetected: true });
    expect(warnings.map((warning) => warning.code)).toEqual([
      'TARGET_BLOCKING_DETECTED',
    ]);
    expect(warnings[0]!.message).toContain('reduced confidence');
  });

  for (const limit of ['DEPTH_REACHED', 'PAGE_CEILING_REACHED', 'REQUEST_CEILING_REACHED']) {
    test(`${limit} is reported as a crawl limit`, () => {
      const warnings = deriveScanWarnings({ ...NO_SIGNALS, bindingLimit: limit });
      expect(warnings.map((warning) => warning.code)).toEqual([
        'CRAWL_LIMIT_REACHED',
      ]);
      expect(warnings[0]!.message).toContain('bound this scan');
    });
  }

  test('TIMEOUT is reported as a crawl limit', () => {
    const warnings = deriveScanWarnings({ ...NO_SIGNALS, bindingLimit: 'TIMEOUT' });
    expect(warnings.map((warning) => warning.code)).toEqual(['CRAWL_LIMIT_REACHED']);
    expect(warnings[0]!.message).toContain('time limit');
  });
});

describe('no duplicate codes', () => {
  test('a recorded degradation wins over the derived one', () => {
    const warnings = deriveScanWarnings({
      degradations: [
        { code: 'TARGET_BLOCKING_DETECTED', message: 'Worker saw 429s for 60s.' },
      ],
      blockingDetected: true,
      bindingLimit: 'DEPTH_REACHED',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toEqual({
      code: 'TARGET_BLOCKING_DETECTED',
      message: 'Worker saw 429s for 60s.',
    });
    expect(warnings[1]!.code).toBe('CRAWL_LIMIT_REACHED');
  });
});

describe('merging a row projection with live warnings', () => {
  const rowWarnings = [
    { code: 'CRAWL_LIMIT_REACHED', message: 'The configured page ceiling bound this scan.' },
  ] as const;

  test('a new live warning is added', () => {
    const merged = mergeScanWarnings(rowWarnings, [
      { code: 'RENDERING_UNAVAILABLE', message: 'Rendering unavailable.' },
    ]);
    expect(merged.map((warning) => warning.code)).toEqual([
      'CRAWL_LIMIT_REACHED',
      'RENDERING_UNAVAILABLE',
    ]);
  });

  test('a code already recorded is not duplicated', () => {
    const merged = mergeScanWarnings(rowWarnings, [
      { code: 'CRAWL_LIMIT_REACHED', message: 'Live message.' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toContain('page ceiling');
  });

  test('merging is idempotent, so a repeated event changes nothing', () => {
    const once = mergeScanWarnings(rowWarnings, [
      { code: 'RENDERING_UNAVAILABLE', message: 'Rendering unavailable.' },
    ]);
    const twice = mergeScanWarnings(once, [
      { code: 'RENDERING_UNAVAILABLE', message: 'Rendering unavailable.' },
    ]);
    expect(twice).toEqual(once);
  });

  test('an empty side is a no-op', () => {
    expect(mergeScanWarnings([], rowWarnings)).toEqual([...rowWarnings]);
    expect(mergeScanWarnings(rowWarnings, [])).toEqual([...rowWarnings]);
  });
});
