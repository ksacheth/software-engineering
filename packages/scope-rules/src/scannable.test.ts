import { describe, expect, test } from 'bun:test';
import { isScannable, verificationExpiryFrom, type ScannableTarget } from './scannable.js';

const NOW = new Date('2026-09-07T12:00:00Z');
const FUTURE = new Date('2026-11-01T00:00:00Z');
const PAST = new Date('2026-08-01T00:00:00Z');

function target(over: Partial<ScannableTarget> = {}): ScannableTarget {
  return {
    verificationStatus: 'VERIFIED',
    verificationExpiresAt: FUTURE,
    verifiedIpRanges: ['93.184.216.34/32'],
    authorisationAck: true,
    isArchived: false,
    ...over,
  };
}

describe('C.2 gate', () => {
  test('a fully verified target is scannable', () => {
    expect(isScannable(target(), NOW)).toEqual({ scannable: true });
  });

  test('archived is refused first', () => {
    expect(isScannable(target({ isArchived: true }), NOW).reason).toBe('ARCHIVED');
  });

  test('missing authorisation acknowledgement is refused', () => {
    expect(isScannable(target({ authorisationAck: false }), NOW).reason).toBe(
      'AUTHORISATION_NOT_ACKNOWLEDGED',
    );
  });

  test.each(['UNVERIFIED', 'PENDING', 'EXPIRED'])('status %s is refused', (status) => {
    expect(isScannable(target({ verificationStatus: status }), NOW).reason).toBe('NOT_VERIFIED');
  });

  test('FAILED reports its own reason', () => {
    expect(isScannable(target({ verificationStatus: 'FAILED' }), NOW).reason).toBe(
      'VERIFICATION_FAILED',
    );
  });

  test('lapsed expiry is refused even while status says VERIFIED', () => {
    expect(isScannable(target({ verificationExpiresAt: PAST }), NOW).reason).toBe(
      'VERIFICATION_EXPIRED',
    );
  });

  test('null expiry is refused', () => {
    expect(isScannable(target({ verificationExpiresAt: null }), NOW).reason).toBe(
      'VERIFICATION_EXPIRED',
    );
  });

  test('expiry exactly now is refused (boundary is inclusive)', () => {
    expect(isScannable(target({ verificationExpiresAt: NOW }), NOW).reason).toBe(
      'VERIFICATION_EXPIRED',
    );
  });

  test('empty verified IP set is refused: fails closed', () => {
    expect(isScannable(target({ verifiedIpRanges: [] }), NOW).reason).toBe('NO_VERIFIED_ADDRESSES');
  });
});

describe('verificationExpiryFrom', () => {
  test('is 90 days after verification', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(verificationExpiryFrom(from).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
});
