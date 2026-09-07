import { describe, expect, test } from 'bun:test';
import { isWithinVerifiedSet, toVerifiedIpRanges } from './verified-set.js';

describe('fails closed', () => {
  test('empty set refuses everything', () => {
    const v = isWithinVerifiedSet('8.8.8.8', []);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('EMPTY_VERIFIED_SET');
  });

  test('malformed stored entry refuses rather than skipping', () => {
    const v = isWithinVerifiedSet('8.8.8.8', ['not-an-ip/32']);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('MALFORMED_ENTRY');
  });

  test('wider prefixes are rejected, not honoured', () => {
    const v = isWithinVerifiedSet('8.8.8.8', ['8.8.0.0/16']);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('MALFORMED_ENTRY');
  });
});

describe('matching', () => {
  test('exact IPv4 match', () => {
    expect(isWithinVerifiedSet('8.8.8.8', ['8.8.8.8/32']).allowed).toBe(true);
  });

  test('rebound address is refused', () => {
    const v = isWithinVerifiedSet('127.0.0.1', ['93.184.216.34/32']);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('ADDRESS_NOT_IN_VERIFIED_SET');
  });

  test('IPv6 match is form-insensitive', () => {
    expect(isWithinVerifiedSet('2606:4700:4700:0:0:0:0:1111', ['2606:4700:4700::1111/128']).allowed).toBe(true);
  });

  test('bare address entries are accepted', () => {
    expect(isWithinVerifiedSet('8.8.8.8', ['8.8.8.8']).allowed).toBe(true);
  });
});

describe('toVerifiedIpRanges', () => {
  test('formats and deduplicates', () => {
    expect(toVerifiedIpRanges(['8.8.8.8', '8.8.8.8', '2606:4700::1111'])).toEqual([
      '8.8.8.8/32',
      '2606:4700::1111/128',
    ]);
  });

  test('drops unparseable input rather than storing it', () => {
    expect(toVerifiedIpRanges(['8.8.8.8', 'garbage'])).toEqual(['8.8.8.8/32']);
  });
});
