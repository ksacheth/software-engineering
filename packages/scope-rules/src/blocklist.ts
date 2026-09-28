/**
 * Network blocklist matching (SRS F.8, ADR-0005).
 *
 * The network blocklist is maintained by administrators and applied on top of
 * the fixed address refusals in address.ts. F.2 asks it at registration and
 * verification, the API asks it again before a scan starts or resumes, and the
 * Scope Guard asks it before every outbound request. One implementation, so
 * those answers cannot disagree.
 *
 * Pure: the caller supplies the hostname, the already-resolved addresses and
 * the active entries.
 */

import { toAddressNumber, type AddressNumber } from './address.js';

/**
 * The pattern types administrators may use.
 *
 * The schema also has REGEX, which is deliberately not offered: a regular
 * expression evaluated on every outbound request is a denial-of-service
 * primitive in the safety kernel, and nobody can read one at a glance to see
 * what it blocks. An entry of any other type fails closed.
 */
export const BLOCKLIST_PATTERN_TYPES = ['CIDR', 'HOST_SUFFIX', 'IP_RANGE'] as const;
export type BlocklistPatternType = (typeof BLOCKLIST_PATTERN_TYPES)[number];

export interface BlocklistEntry {
  id: string;
  patternType: string;
  pattern: string;
}

export interface BlocklistSubject {
  /** The host being reached, when there is one. */
  hostname?: string;
  /**
   * Resolved addresses. Single-host CIDR strings from a verified IP set
   * (`/32`, `/128`) are accepted as the address they name.
   */
  addresses: readonly string[];
}

export type BlocklistVerdict =
  | { blocked: false }
  | {
      blocked: true;
      reason: 'MATCHED' | 'MALFORMED_ENTRY';
      entry: BlocklistEntry;
      /** The hostname or address that matched. */
      matched?: string;
    };

export type BlocklistPatternProblem =
  | 'UNSUPPORTED_TYPE'
  | 'MALFORMED_HOST'
  | 'MALFORMED_CIDR'
  | 'MALFORMED_RANGE';

export type ParseBlocklistPatternResult =
  | { ok: true; patternType: BlocklistPatternType; pattern: string }
  | { ok: false; problem: BlocklistPatternProblem };

type Matcher = (subject: { hostname?: string; addresses: AddressNumber[] }) => string | null;

function normaliseHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  const valid = labels.every((label) => /^[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9_])?$/.test(label));
  return valid ? host : null;
}

function isBlocklistPatternType(value: string): value is BlocklistPatternType {
  return (BLOCKLIST_PATTERN_TYPES as readonly string[]).includes(value);
}

function parseCidr(pattern: string): { base: AddressNumber; bits: number; text: string } | null {
  const slash = pattern.lastIndexOf('/');
  if (slash === -1) return null;
  const prefix = pattern.slice(slash + 1).trim();
  if (!/^\d{1,3}$/.test(prefix)) return null;

  const base = toAddressNumber(pattern.slice(0, slash));
  if (!base) return null;
  const width = base.family === 4 ? 32 : 128;
  const bits = Number(prefix);
  if (bits > width) return null;

  // Canonicalise to the network address, so 10.1.2.3/8 is stored as the
  // 10.0.0.0/8 it actually blocks rather than as something that looks narrower.
  const hostBits = BigInt(width - bits);
  const network = (base.value >> hostBits) << hostBits;
  return {
    base: { family: base.family, value: network },
    bits,
    text: `${formatAddress({ family: base.family, value: network })}/${bits}`,
  };
}

function parseRange(pattern: string): { start: AddressNumber; end: AddressNumber; text: string } | null {
  const parts = pattern.split('-');
  if (parts.length !== 2) return null;
  const start = toAddressNumber(parts[0] ?? '');
  const end = toAddressNumber(parts[1] ?? '');
  if (!start || !end || start.family !== end.family || start.value > end.value) return null;
  return { start, end, text: `${formatAddress(start)}-${formatAddress(end)}` };
}

function formatAddress(address: AddressNumber): string {
  if (address.family === 4) {
    const octets = [24n, 16n, 8n, 0n].map((shift) => Number((address.value >> shift) & 0xffn));
    return octets.join('.');
  }
  return canonicalIpv6(address.value);
}

/** RFC 5952 text, matching how address.ts renders IPv6. */
function canonicalIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((value >> shift) & 0xffffn));
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/**
 * Validates and canonicalises a pattern before it is stored.
 *
 * The same parser backs matching, so a pattern this accepts is exactly a
 * pattern the Scope Guard can evaluate.
 */
export function parseBlocklistPattern(patternType: string, pattern: string): ParseBlocklistPatternResult {
  if (!isBlocklistPatternType(patternType)) return { ok: false, problem: 'UNSUPPORTED_TYPE' };
  const value = pattern?.trim() ?? '';

  switch (patternType) {
    case 'HOST_SUFFIX': {
      const host = normaliseHostname(value.replace(/^\*?\./, ''));
      return host ? { ok: true, patternType, pattern: host } : { ok: false, problem: 'MALFORMED_HOST' };
    }
    case 'CIDR': {
      const cidr = parseCidr(value);
      return cidr ? { ok: true, patternType, pattern: cidr.text } : { ok: false, problem: 'MALFORMED_CIDR' };
    }
    case 'IP_RANGE': {
      const range = parseRange(value);
      return range ? { ok: true, patternType, pattern: range.text } : { ok: false, problem: 'MALFORMED_RANGE' };
    }
  }
}

function hostSuffixMatcher(suffix: string): Matcher {
  return ({ hostname }) =>
    hostname && (hostname === suffix || hostname.endsWith(`.${suffix}`)) ? hostname : null;
}

/** Match the first address for which `contains` holds. */
function addressMatcher(contains: (address: AddressNumber) => boolean): Matcher {
  return ({ addresses }) => {
    const hit = addresses.find(contains);
    return hit ? formatAddress(hit) : null;
  };
}

function cidrMatcher(pattern: string): Matcher {
  const { base, bits } = parseCidr(pattern)!;
  const hostBits = BigInt((base.family === 4 ? 32 : 128) - bits);
  return addressMatcher(
    (a) => a.family === base.family && (a.value >> hostBits) << hostBits === base.value,
  );
}

function rangeMatcher(pattern: string): Matcher {
  const { start, end } = parseRange(pattern)!;
  return addressMatcher(
    (a) => a.family === start.family && a.value >= start.value && a.value <= end.value,
  );
}

const MATCHERS: Record<BlocklistPatternType, (pattern: string) => Matcher> = {
  HOST_SUFFIX: hostSuffixMatcher,
  CIDR: cidrMatcher,
  IP_RANGE: rangeMatcher,
};

/** A matcher for the entry, or null when it cannot be evaluated. */
function compile(entry: BlocklistEntry): Matcher | null {
  const parsed = parseBlocklistPattern(entry.patternType, entry.pattern);
  return parsed.ok ? MATCHERS[parsed.patternType](parsed.pattern) : null;
}

function stripSingleHostPrefix(value: string): string {
  return value.trim().replace(/\/(32|128)$/, '');
}

/**
 * Checks a host and its resolved addresses against the active entries.
 *
 * Fails closed on an entry it cannot evaluate. An unreadable entry is a
 * data-integrity problem, and treating it as a pass would let the one entry an
 * administrator most needed silently do nothing. The API refuses such entries
 * at write time, so in practice this only fires on rows written around it.
 *
 * An address that cannot be parsed is ignored here rather than refused: the
 * blocklist answers "is this listed", and refusing malformed addresses is
 * classifyAddress's job, which every caller runs first.
 */
export function matchBlocklist(
  subject: BlocklistSubject,
  entries: readonly BlocklistEntry[],
): BlocklistVerdict {
  const hostname = subject.hostname ? (normaliseHostname(subject.hostname) ?? undefined) : undefined;
  const addresses = subject.addresses
    .map((a) => toAddressNumber(stripSingleHostPrefix(a)))
    .filter((a): a is AddressNumber => a !== null);

  for (const entry of entries) {
    const matcher = compile(entry);
    if (!matcher) return { blocked: true, reason: 'MALFORMED_ENTRY', entry };
    const matched = matcher({ hostname, addresses });
    if (matched) return { blocked: true, reason: 'MATCHED', entry, matched };
  }
  return { blocked: false };
}
