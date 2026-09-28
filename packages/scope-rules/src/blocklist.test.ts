import { describe, expect, test } from 'bun:test';
import { matchBlocklist, parseBlocklistPattern, type BlocklistEntry } from './blocklist';

function entry(patternType: string, pattern: string, id = `${patternType}:${pattern}`): BlocklistEntry {
  return { id, patternType, pattern };
}

describe('matchBlocklist: HOST_SUFFIX', () => {
  const entries = [entry('HOST_SUFFIX', 'gov.example')];

  test('blocks the host itself', () => {
    const verdict = matchBlocklist({ hostname: 'gov.example', addresses: [] }, entries);
    expect(verdict).toMatchObject({ blocked: true, entry: { id: 'HOST_SUFFIX:gov.example' } });
  });

  test('blocks any subdomain of it', () => {
    expect(matchBlocklist({ hostname: 'tax.portal.gov.example', addresses: [] }, entries).blocked).toBe(
      true,
    );
  });

  test('does not block a name that merely ends with the same letters', () => {
    expect(matchBlocklist({ hostname: 'notgov.example', addresses: [] }, entries).blocked).toBe(false);
  });

  test('matches regardless of case and a trailing root dot', () => {
    expect(matchBlocklist({ hostname: 'WWW.Gov.Example.', addresses: [] }, entries).blocked).toBe(true);
  });
});

describe('matchBlocklist: CIDR', () => {
  const entries = [entry('CIDR', '203.0.113.0/24'), entry('CIDR', '2001:db8:abcd::/48')];

  test('blocks an address inside the network', () => {
    const verdict = matchBlocklist({ addresses: ['203.0.113.77'] }, entries);
    expect(verdict).toMatchObject({ blocked: true, reason: 'MATCHED', matched: '203.0.113.77' });
  });

  test('does not block the address just outside it', () => {
    expect(matchBlocklist({ addresses: ['203.0.114.0'] }, entries).blocked).toBe(false);
  });

  test('blocks an IPv4-mapped IPv6 address as the IPv4 address it reaches', () => {
    expect(matchBlocklist({ addresses: ['::ffff:203.0.113.9'] }, entries).blocked).toBe(true);
  });

  test('blocks inside an IPv6 network', () => {
    expect(matchBlocklist({ addresses: ['2001:db8:abcd:12::1'] }, entries).blocked).toBe(true);
  });

  test('blocks if any one of several resolved addresses is listed', () => {
    expect(matchBlocklist({ addresses: ['93.184.216.34', '203.0.113.5'] }, entries).blocked).toBe(true);
  });

  test('reads single-host CIDR strings from a verified IP set', () => {
    expect(matchBlocklist({ addresses: ['203.0.113.5/32'] }, entries).blocked).toBe(true);
  });
});

describe('matchBlocklist: IP_RANGE', () => {
  const entries = [entry('IP_RANGE', '198.51.100.10-198.51.100.20')];

  test('blocks both ends of the range, inclusive', () => {
    expect(matchBlocklist({ addresses: ['198.51.100.10'] }, entries).blocked).toBe(true);
    expect(matchBlocklist({ addresses: ['198.51.100.20'] }, entries).blocked).toBe(true);
  });

  test('does not block just past the end', () => {
    expect(matchBlocklist({ addresses: ['198.51.100.21'] }, entries).blocked).toBe(false);
  });
});

describe('matchBlocklist: entries it cannot evaluate', () => {
  test('a REGEX entry blocks everything rather than silently doing nothing', () => {
    const verdict = matchBlocklist(
      { hostname: 'example.com', addresses: ['93.184.216.34'] },
      [entry('REGEX', '.*\\.example\\.com')],
    );
    expect(verdict).toMatchObject({ blocked: true, reason: 'MALFORMED_ENTRY' });
  });

  test('a malformed CIDR entry blocks everything', () => {
    const verdict = matchBlocklist({ addresses: ['93.184.216.34'] }, [entry('CIDR', '10.0.0.0/99')]);
    expect(verdict).toMatchObject({ blocked: true, reason: 'MALFORMED_ENTRY' });
  });

  test('an empty blocklist blocks nothing', () => {
    expect(matchBlocklist({ hostname: 'example.com', addresses: ['93.184.216.34'] }, []).blocked).toBe(false);
  });
});

describe('parseBlocklistPattern', () => {
  test('stores a CIDR as the network it actually covers', () => {
    expect(parseBlocklistPattern('CIDR', '10.1.2.3/8')).toEqual({
      ok: true,
      patternType: 'CIDR',
      pattern: '10.0.0.0/8',
    });
  });

  test('stores IPv6 in RFC 5952 form', () => {
    expect(parseBlocklistPattern('CIDR', '2001:0DB8:0000:0000::/32')).toMatchObject({
      ok: true,
      pattern: '2001:db8::/32',
    });
  });

  test('accepts a leading wildcard on a host suffix and drops it', () => {
    expect(parseBlocklistPattern('HOST_SUFFIX', '*.Gov.Example')).toMatchObject({
      ok: true,
      pattern: 'gov.example',
    });
  });

  test('refuses REGEX', () => {
    expect(parseBlocklistPattern('REGEX', '.*')).toEqual({ ok: false, problem: 'UNSUPPORTED_TYPE' });
  });

  test('refuses a range that runs backwards', () => {
    expect(parseBlocklistPattern('IP_RANGE', '10.0.0.9-10.0.0.1')).toEqual({
      ok: false,
      problem: 'MALFORMED_RANGE',
    });
  });

  test('refuses a range that mixes address families', () => {
    expect(parseBlocklistPattern('IP_RANGE', '10.0.0.1-2001:db8::1')).toEqual({
      ok: false,
      problem: 'MALFORMED_RANGE',
    });
  });

  test('refuses a host suffix that is not a hostname', () => {
    expect(parseBlocklistPattern('HOST_SUFFIX', 'exa mple.com')).toEqual({
      ok: false,
      problem: 'MALFORMED_HOST',
    });
  });
});
