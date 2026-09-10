import { describe, expect, test } from 'bun:test';
import {
  canCancel,
  canPause,
  canResume,
  canTransition,
  isTerminalScanStatus,
  occupiesQuota,
  SCAN_STATUSES,
  type ScanStatus,
} from './lifecycle.js';

/**
 * Independent source of truth: the transition graph quoted in issue #3
 * (docs/adr/0006 records the transport decision; the graph itself lives here
 * because both the API and the orchestrator enforce it).
 *
 *   QUEUED  -> RUNNING | CANCELLED | FAILED
 *   RUNNING -> PAUSED | COMPLETED | FAILED | CANCELLED | ABORTED_SAFETY
 *   PAUSED  -> RUNNING | CANCELLED | FAILED
 *   terminal -> (nothing)
 */
const LEGAL: [ScanStatus, ScanStatus][] = [
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'CANCELLED'],
  ['QUEUED', 'FAILED'],
  ['RUNNING', 'PAUSED'],
  ['RUNNING', 'COMPLETED'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'CANCELLED'],
  ['RUNNING', 'ABORTED_SAFETY'],
  ['PAUSED', 'RUNNING'],
  ['PAUSED', 'CANCELLED'],
  ['PAUSED', 'FAILED'],
];

const TERMINAL: ScanStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABORTED_SAFETY',
];

describe('legal transitions', () => {
  for (const [from, to] of LEGAL) {
    test(`${from} -> ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }
});

describe('every other pair is refused', () => {
  const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
  for (const from of SCAN_STATUSES) {
    for (const to of SCAN_STATUSES) {
      if (legal.has(`${from}->${to}`)) continue;
      test(`${from} -> ${to}`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  }
});

describe('terminal states are absorbing', () => {
  for (const status of TERMINAL) {
    test(`${status} is terminal and accepts no transition`, () => {
      expect(isTerminalScanStatus(status)).toBe(true);
      for (const to of SCAN_STATUSES) {
        expect(canTransition(status, to)).toBe(false);
      }
    });
  }

  for (const status of ['QUEUED', 'RUNNING', 'PAUSED'] as ScanStatus[]) {
    test(`${status} is not terminal`, () => {
      expect(isTerminalScanStatus(status)).toBe(false);
    });
  }
});

describe('quota-occupying statuses', () => {
  // Issue #3: QUEUED, RUNNING and PAUSED occupy a slot; PAUSED counts because a
  // paused scan holds its checkpoint and will resume.
  for (const status of ['QUEUED', 'RUNNING', 'PAUSED'] as ScanStatus[]) {
    test(`${status} occupies`, () => {
      expect(occupiesQuota(status)).toBe(true);
    });
  }
  for (const status of TERMINAL) {
    test(`${status} frees its slot`, () => {
      expect(occupiesQuota(status)).toBe(false);
    });
  }
});

describe('control predicates', () => {
  test('only RUNNING can be paused', () => {
    for (const status of SCAN_STATUSES) {
      expect(canPause(status)).toBe(status === 'RUNNING');
    }
  });

  test('only PAUSED can be resumed', () => {
    for (const status of SCAN_STATUSES) {
      expect(canResume(status)).toBe(status === 'PAUSED');
    }
  });

  test('cancel is available until the scan finishes', () => {
    for (const status of SCAN_STATUSES) {
      expect(canCancel(status)).toBe(!isTerminalScanStatus(status));
    }
  });
});
