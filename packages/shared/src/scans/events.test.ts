import { describe, expect, test } from 'bun:test';
import {
  isScanEvent,
  SCAN_EVENT_TYPES,
  SCAN_WARNING_CODES,
  type ScanEvent,
} from './events.js';

const AT = '2026-09-11T09:15:00.000Z';
const SCAN_ID = 'scan_abc123';

/** Independent source of truth: the four names named by SRS §3.2.4. */
const SRS_EVENT_NAMES: string[] = ['scan.status', 'scan.progress', 'scan.finding', 'scan.warning'];

describe('event names', () => {
  test('the SRS names are used verbatim', () => {
    expect([...SCAN_EVENT_TYPES].sort() as string[]).toEqual([...SRS_EVENT_NAMES].sort());
  });

  test('scan.completed is not a scan event', () => {
    expect(isScanEvent({ type: 'scan.completed', scanJobId: SCAN_ID, at: AT })).toBe(false);
  });
});

describe('a well-formed event of every type is accepted', () => {
  const events: ScanEvent[] = [
    { type: 'scan.status', scanJobId: SCAN_ID, at: AT, status: 'PAUSED' },
    {
      type: 'scan.progress',
      scanJobId: SCAN_ID,
      at: AT,
      phase: 'DISCOVERY',
      pagesCrawled: 12,
      requestsMade: 40,
      findingsCount: 3,
      progressPercentage: 25,
    },
    {
      type: 'scan.finding',
      scanJobId: SCAN_ID,
      at: AT,
      fingerprint: 'fp-1',
      detectorId: 'P-01',
      name: 'Missing Content-Security-Policy',
      severity: 'MEDIUM',
      affectedUrl: 'https://example.test/',
    },
    {
      type: 'scan.warning',
      scanJobId: SCAN_ID,
      at: AT,
      code: 'RENDERING_UNAVAILABLE',
      message: 'JavaScript rendering was unavailable; static HTML was crawled.',
    },
  ];

  for (const event of events) {
    test(event.type, () => {
      expect(isScanEvent(event)).toBe(true);
    });
  }
});

describe('malformed input is refused', () => {
  const at = '2026-09-11T09:15:00.000Z';

  const bad: [string, unknown][] = [
    ['null', null],
    ['a string', 'scan.status'],
    ['an array', []],
    ['a missing type', { scanJobId: SCAN_ID, at }],
    ['an unknown type', { type: 'scan.started', scanJobId: SCAN_ID, at }],
    ['a missing scanJobId', { type: 'scan.status', at, status: 'RUNNING' }],
    ['a numeric scanJobId', { type: 'scan.status', scanJobId: 7, at, status: 'RUNNING' }],
    ['a missing timestamp', { type: 'scan.status', scanJobId: SCAN_ID, status: 'RUNNING' }],
    [
      'a non-UTC timestamp',
      { type: 'scan.status', scanJobId: SCAN_ID, at: '2026-09-11T09:15:00+02:00', status: 'RUNNING' },
    ],
    ['a nonsense timestamp', { type: 'scan.status', scanJobId: SCAN_ID, at: 'yesterday' }],
    ['an unknown status', { type: 'scan.status', scanJobId: SCAN_ID, at, status: 'STALLED' }],
    ['a status without a status field', { type: 'scan.status', scanJobId: SCAN_ID, at }],
    [
      'a progress event without counters',
      { type: 'scan.progress', scanJobId: SCAN_ID, at, phase: 'DISCOVERY' },
    ],
    [
      'a finding without a severity',
      {
        type: 'scan.finding',
        scanJobId: SCAN_ID,
        at,
        fingerprint: 'fp-1',
        detectorId: 'P-01',
        name: 'x',
        affectedUrl: 'https://example.test/',
      },
    ],
    [
      'a warning with an unknown code',
      { type: 'scan.warning', scanJobId: SCAN_ID, at, code: 'ALIENS', message: 'x' },
    ],
  ];

  for (const [label, value] of bad) {
    test(label, () => {
      expect(isScanEvent(value)).toBe(false);
    });
  }
});

describe('warning codes cover the recorded degradations', () => {
  // SRS §3.2.3 and F.4: DNS failure, rendering unavailable, advisory data
  // unavailable, target blocking detected, crawl limit reached.
  test('the five specified degradations have codes', () => {
    expect([...SCAN_WARNING_CODES].sort() as string[]).toEqual(
      [
        'ADVISORY_DATA_UNAVAILABLE',
        'CRAWL_LIMIT_REACHED',
        'DNS_RESOLUTION_FAILED',
        'RENDERING_UNAVAILABLE',
        'TARGET_BLOCKING_DETECTED',
      ].sort(),
    );
  });
});

describe('timestamp ordering support', () => {
  test('the at field is a canonical ISO 8601 UTC string', () => {
    const event = { type: 'scan.status', scanJobId: SCAN_ID, at: AT, status: 'RUNNING' };
    expect(isScanEvent(event)).toBe(true);
    // The client compares timestamps to discard late snapshots, so the string
    // must round-trip through Date without loss.
    expect(new Date((event as { at: string }).at).toISOString()).toBe(AT);
  });
});
