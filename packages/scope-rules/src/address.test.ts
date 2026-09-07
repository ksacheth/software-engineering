import { describe, expect, test } from 'bun:test';
import { classifyAddress, classifyResolvedAddresses, isForbiddenAddress } from './address.js';

const refused: [string, string][] = [
  ['127.0.0.1', 'LOOPBACK'],
  ['127.1.2.3', 'LOOPBACK'],
  ['10.0.0.1', 'PRIVATE'],
  ['172.16.0.1', 'PRIVATE'],
  ['172.31.255.254', 'PRIVATE'],
  ['192.168.1.1', 'PRIVATE'],
  ['100.64.0.1', 'PRIVATE'],
  ['169.254.1.1', 'LINK_LOCAL'],
  ['169.254.169.254', 'CLOUD_METADATA'],
  ['0.0.0.0', 'UNSPECIFIED'],
  ['224.0.0.1', 'MULTICAST'],
  ['255.255.255.255', 'RESERVED'],
  ['::1', 'LOOPBACK'],
  ['::', 'UNSPECIFIED'],
  ['fe80::1', 'LINK_LOCAL'],
  ['fc00::1', 'UNIQUE_LOCAL'],
  ['fd12:3456::1', 'UNIQUE_LOCAL'],
  ['ff02::1', 'MULTICAST'],
  ['fd00:ec2::254', 'CLOUD_METADATA'],
  ['64:ff9b::7f00:1', 'RESERVED'],
];

describe('classifyAddress refuses', () => {
  for (const [ip, reason] of refused) {
    test(`${ip} -> ${reason}`, () => {
      const v = classifyAddress(ip);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe(reason as never);
    });
  }
});

describe('IPv4-mapped IPv6 bypasses', () => {
  test('::ffff:127.0.0.1 is LOOPBACK, not allowed', () => {
    const v = classifyAddress('::ffff:127.0.0.1');
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('LOOPBACK');
  });

  test('::ffff:169.254.169.254 is CLOUD_METADATA', () => {
    expect(classifyAddress('::ffff:169.254.169.254').reason).toBe('CLOUD_METADATA');
  });

  test('::ffff:10.0.0.1 is PRIVATE', () => {
    expect(classifyAddress('::ffff:10.0.0.1').reason).toBe('PRIVATE');
  });

  test('hex-form mapped address ::ffff:7f00:1 is LOOPBACK', () => {
    expect(classifyAddress('::ffff:7f00:1').reason).toBe('LOOPBACK');
  });
});

describe('malformed input fails closed', () => {
  for (const bad of ['', '  ', 'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '0177.0.0.1', 'g::1', '::1::2']) {
    test(JSON.stringify(bad), () => {
      expect(classifyAddress(bad).allowed).toBe(false);
    });
  }
});

describe('allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    test(ip, () => {
      expect(classifyAddress(ip).allowed).toBe(true);
      expect(isForbiddenAddress(ip)).toBe(false);
    });
  }
});

describe('IPv6 output is RFC 5952 canonical', () => {
  const forms: [string, string][] = [
    ['2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111'],
    ['2606:4700:0000:0000:0000:0000:0000:1111', '2606:4700::1111'],
    ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
    ['2606:4700:4700::1111', '2606:4700:4700::1111'],
  ];
  for (const [input, expected] of forms) {
    test(`${input} -> ${expected}`, () => {
      expect(classifyAddress(input).normalised).toBe(expected);
    });
  }
});

describe('zone index is stripped', () => {
  test('fe80::1%eth0 is LINK_LOCAL', () => {
    expect(classifyAddress('fe80::1%eth0').reason).toBe('LINK_LOCAL');
  });
});

describe('classifyResolvedAddresses', () => {
  test('refuses when ANY address is forbidden', () => {
    const v = classifyResolvedAddresses(['93.184.216.34', '127.0.0.1']);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('LOOPBACK');
  });

  test('refuses an empty result set', () => {
    expect(classifyResolvedAddresses([]).allowed).toBe(false);
  });

  test('allows an all-public set', () => {
    expect(classifyResolvedAddresses(['8.8.8.8', '1.1.1.1']).allowed).toBe(true);
  });
});
