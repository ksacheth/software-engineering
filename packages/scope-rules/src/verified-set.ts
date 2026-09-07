/**
 * DNS rebinding protection (SRS F.8, BLOCKED_DNS_REBINDING).
 *
 * Target.verifiedIpRanges holds the literal addresses observed at verification
 * time, as /32 and /128 CIDR strings. See docs/adr/0004.
 */

import { classifyAddress } from './address.js';

export type VerifiedSetRefusalReason =
  | 'EMPTY_VERIFIED_SET'
  | 'ADDRESS_NOT_IN_VERIFIED_SET'
  | 'MALFORMED_ADDRESS'
  | 'MALFORMED_ENTRY';

export interface VerifiedSetVerdict {
  allowed: boolean;
  reason?: VerifiedSetRefusalReason;
  /** The offending entry or address, for the refusal message. */
  detail?: string;
}

function canonicalise(ip: string): string | null {
  const verdict = classifyAddress(ip);
  // We want the normalised form even for refused addresses: this function
  // answers "is it the same address", not "is it allowed".
  if (verdict.normalised) return verdict.normalised;
  if (verdict.reason === 'MALFORMED') return null;
  return null;
}

/**
 * Parses one verifiedIpRanges entry. Accepts a bare address or a single-host
 * CIDR (/32 for IPv4, /128 for IPv6). Wider prefixes are rejected: widening to
 * a netblock would authorise every other tenant on a shared host.
 */
function parseEntry(entry: string): string | null {
  const value = entry?.trim();
  if (!value) return null;

  const slash = value.lastIndexOf('/');
  if (slash === -1) return canonicalise(value);

  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return null;

  const canonical = canonicalise(address);
  if (!canonical) return null;

  const bits = Number(prefix);
  const isIpv4 = canonical.includes('.');
  if (isIpv4 && bits !== 32) return null;
  if (!isIpv4 && bits !== 128) return null;

  return canonical;
}

/**
 * Checks a freshly resolved address against the set recorded at verification.
 *
 * Fails closed on an empty set: a target with no recorded addresses is not
 * scannable. If empty meant "skip", any code path that registered a target
 * without populating the field would silently disable this control.
 */
export function isWithinVerifiedSet(
  ip: string,
  verifiedIpRanges: readonly string[],
): VerifiedSetVerdict {
  if (verifiedIpRanges.length === 0) {
    return { allowed: false, reason: 'EMPTY_VERIFIED_SET' };
  }

  const candidate = canonicalise(ip);
  if (!candidate) {
    return { allowed: false, reason: 'MALFORMED_ADDRESS', detail: ip };
  }

  for (const entry of verifiedIpRanges) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      // A malformed stored entry is a data-integrity problem, not a pass.
      return { allowed: false, reason: 'MALFORMED_ENTRY', detail: entry };
    }
    if (parsed === candidate) return { allowed: true };
  }

  return { allowed: false, reason: 'ADDRESS_NOT_IN_VERIFIED_SET', detail: candidate };
}

/**
 * Formats resolved addresses for storage in Target.verifiedIpRanges.
 * Returns single-host CIDR strings, deduplicated, with unparseable input
 * dropped rather than stored.
 */
export function toVerifiedIpRanges(ips: readonly string[]): string[] {
  const out = new Set<string>();
  for (const ip of ips) {
    const canonical = canonicalise(ip);
    if (!canonical) continue;
    out.add(canonical.includes('.') ? `${canonical}/32` : `${canonical}/128`);
  }
  return [...out];
}
