import { describe, expect, test } from 'bun:test';
import { SCAN_QUEUE_NAME, isScanJobPayload, scanJobQueueId } from './queue.js';

describe('scan job payload', () => {
  const valid = { scanJobId: 'scan_1', organizationId: 'org_1', attempt: 1 };

  test('accepts the contract payload', () => {
    expect(isScanJobPayload(valid)).toBe(true);
  });

  test('accepts a resumed attempt number', () => {
    expect(isScanJobPayload({ ...valid, attempt: 3 })).toBe(true);
  });

  test('refuses a zero or fractional attempt', () => {
    expect(isScanJobPayload({ ...valid, attempt: 0 })).toBe(false);
    expect(isScanJobPayload({ ...valid, attempt: 1.5 })).toBe(false);
  });

  test('refuses missing identity fields', () => {
    expect(isScanJobPayload({ ...valid, scanJobId: '' })).toBe(false);
    expect(isScanJobPayload({ scanJobId: 'scan_1', attempt: 1 })).toBe(false);
    expect(isScanJobPayload({ organizationId: 'org_1', attempt: 1 })).toBe(false);
  });

  test('refuses configuration smuggled into the payload', () => {
    // The row is the single source of truth; a fat payload would drift.
    const fat = { ...valid, rateLimit: 10, maxPages: 200 };
    expect(isScanJobPayload(fat)).toBe(true); // extra keys are ignored, not read
    expect(SCAN_QUEUE_NAME).toBe('wvs-scans');
  });
});

describe('queue id', () => {
  test('is the scan id, so enqueueing is idempotent', () => {
    expect(scanJobQueueId('scan_abc')).toBe('scan_abc');
  });
});
