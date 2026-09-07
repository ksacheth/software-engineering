/**
 * Address classification for SRS F.2 (target refusal) and F.8 (Scope Guard).
 *
 * Pure functions over an ALREADY-RESOLVED address. This package never performs
 * DNS resolution or network I/O: resolution is the caller's job, so the caller
 * controls the TOCTOU window between resolving and connecting.
 */

export type AddressRefusalReason =
  | 'LOOPBACK'
  | 'PRIVATE'
  | 'LINK_LOCAL'
  | 'CLOUD_METADATA'
  | 'UNSPECIFIED'
  | 'MULTICAST'
  | 'RESERVED'
  | 'UNIQUE_LOCAL'
  | 'MALFORMED';

export interface AddressVerdict {
  allowed: boolean;
  /** Present only when allowed is false. Names the rule that triggered. */
  reason?: AddressRefusalReason;
  /** The address after normalisation, e.g. ::ffff:127.0.0.1 -> 127.0.0.1 */
  normalised?: string;
}

const ALLOWED: AddressVerdict = { allowed: true };

function refuse(reason: AddressRefusalReason, normalised?: string): AddressVerdict {
  return { allowed: false, reason, normalised };
}

/** The link-local address every major cloud serves instance credentials from. */
export const CLOUD_METADATA_IPV4 = '169.254.169.254';
/** GCP/Azure also expose metadata over IPv6 link-local. */
export const CLOUD_METADATA_IPV6 = 'fd00:ec2::254';

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject leading zeros: "0177.0.0.1" is octal in some resolvers.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function classifyIpv4(octets: number[]): AddressVerdict {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const text = `${a}.${b}.${c}.${d}`;

  if (a === 0) return refuse('UNSPECIFIED', text); // 0.0.0.0/8
  if (a === 127) return refuse('LOOPBACK', text); // 127.0.0.0/8
  if (a === 10) return refuse('PRIVATE', text); // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return refuse('PRIVATE', text); // 172.16.0.0/12
  if (a === 192 && b === 168) return refuse('PRIVATE', text); // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return refuse('PRIVATE', text); // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) {
    if (c === 169 && d === 254) return refuse('CLOUD_METADATA', text);
    return refuse('LINK_LOCAL', text); // 169.254.0.0/16
  }
  if (a === 192 && b === 0 && c === 0) return refuse('RESERVED', text); // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return refuse('RESERVED', text); // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return refuse('RESERVED', text); // benchmarking
  if (a === 198 && b === 51 && c === 100) return refuse('RESERVED', text); // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return refuse('RESERVED', text); // TEST-NET-3
  if (a >= 224 && a <= 239) return refuse('MULTICAST', text); // 224.0.0.0/4
  if (a >= 240) return refuse('RESERVED', text); // 240.0.0.0/4 and 255.255.255.255

  return { allowed: true, normalised: text };
}

/**
 * Expands an IPv6 address to its eight 16-bit groups. Handles :: compression
 * and the ::ffff:a.b.c.d IPv4-mapped form, which is the single most common
 * bypass of naive denylists.
 */
function parseIpv6(value: string): { groups: number[]; mappedIpv4?: number[] } | null {
  let text = value.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Strip a zone index: fe80::1%eth0
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  let mappedIpv4: number[] | undefined;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    mappedIpv4 = octets;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      out.push(Number.parseInt(chunk, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? '');
  if (!head) return null;

  if (halves.length === 1) {
    return head.length === 8 ? { groups: head, mappedIpv4 } : null;
  }

  const back = toGroups(halves[1] ?? '');
  if (!back) return null;
  const fill = 8 - head.length - back.length;
  if (fill < 0) return null;
  return { groups: [...head, ...Array<number>(fill).fill(0), ...back], mappedIpv4 };
}

function groupsToText(groups: number[]): string {
  return groups.map((g) => g.toString(16)).join(':');
}

function classifyIpv6(groups: number[], mappedIpv4?: number[]): AddressVerdict {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;

  const text = groupsToText(groups);

  // :: and ::1 are checked BEFORE the IPv4-compatible branch, or ::1 would be
  // read as the IPv4 address 0.0.0.1 and refused for the wrong reason.
  if (groups.every((g) => g === 0)) return refuse('UNSPECIFIED', text); // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return refuse('LOOPBACK', text); // ::1
  }

  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible form:
  // classify as the IPv4 address actually reached. ::ffff:127.0.0.1 must be
  // refused as LOOPBACK, which is the most common denylist bypass.
  const isV4Mapped =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isV4Compatible = groups.slice(0, 6).every((g) => g === 0);
  if (mappedIpv4 && (isV4Mapped || isV4Compatible)) {
    return classifyIpv4(mappedIpv4);
  }
  if (isV4Mapped || isV4Compatible) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return classifyIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }

  // Cloud metadata over IPv6 (GCP, Azure) sits inside fc00::/7, so it must be
  // matched before the unique-local rule or it reports the wrong reason.
  if (g0 === 0xfd00 && g1 === 0x0ec2 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 0x254) {
    return refuse('CLOUD_METADATA', text);
  }

  // NAT64 well-known prefix 64:ff9b::/96 can reach any IPv4; treat as reserved.
  if (g0 === 0x64 && g1 === 0xff9b) return refuse('RESERVED', text);
  if ((g0 & 0xfe00) === 0xfc00) return refuse('UNIQUE_LOCAL', text); // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return refuse('LINK_LOCAL', text); // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return refuse('MULTICAST', text); // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return refuse('RESERVED', text); // documentation
  if (g0 === 0x0100 && g1 === 0) return refuse('RESERVED', text); // discard-only

  return { allowed: true, normalised: text };
}

/**
 * Classifies a single resolved IP address.
 *
 * Fails closed: anything unparseable is refused as MALFORMED rather than
 * allowed. A caller that cannot parse an address cannot reason about where it
 * points, so it must not connect to it.
 */
export function classifyAddress(ip: string): AddressVerdict {
  const value = ip?.trim();
  if (!value) return refuse('MALFORMED');

  const v4 = parseIpv4(value);
  if (v4) return classifyIpv4(v4);

  const v6 = parseIpv6(value);
  if (v6) return classifyIpv6(v6.groups, v6.mappedIpv4);

  return refuse('MALFORMED');
}

/** Convenience wrapper: true when the address must never be connected to. */
export function isForbiddenAddress(ip: string): boolean {
  return !classifyAddress(ip).allowed;
}

/**
 * Classifies every address a hostname resolved to. Refuses if ANY address is
 * forbidden, not just the first: a host with one public and one private A
 * record is a DNS rebinding primitive, and connecting picks one at random.
 */
export function classifyResolvedAddresses(ips: readonly string[]): AddressVerdict {
  if (ips.length === 0) return refuse('MALFORMED');
  for (const ip of ips) {
    const verdict = classifyAddress(ip);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}
