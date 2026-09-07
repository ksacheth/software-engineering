import { promises as dns } from 'node:dns';
import {
  classifyResolvedAddresses,
  type AddressRefusalReason,
} from '@wvs/scope-rules';

/**
 * Origin parsing and DNS resolution for F.2.
 *
 * This is the only place in the API that resolves DNS. Keeping resolution in
 * one function means the TOCTOU window between "we checked this address" and
 * "we connected to it" has a single owner: callers receive the resolved
 * addresses and are expected to connect to those, not to re-resolve the name.
 */

export interface ParsedOrigin {
  /** Canonical origin: scheme://host[:port], lowercased, no trailing slash. */
  origin: string;
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
}

export type OriginProblem =
  | 'MALFORMED'
  | 'UNSUPPORTED_SCHEME'
  | 'HAS_PATH'
  | 'HAS_CREDENTIALS'
  | 'IS_IP_LITERAL';

export type ParseOriginResult =
  | { ok: true; value: ParsedOrigin }
  | { ok: false; problem: OriginProblem; detail?: string };

/**
 * Parses and canonicalises a user-supplied origin.
 *
 * IP literals are refused outright. An origin is a name whose ownership can be
 * proven by publishing a DNS TXT record or serving a file; a bare address has
 * no owner to prove anything, and accepting one would let a user skip straight
 * past the name-based half of verification.
 */
export function parseOrigin(input: string): ParseOriginResult {
  const raw = input?.trim();
  if (!raw) return { ok: false, problem: 'MALFORMED' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'MALFORMED' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, problem: 'UNSUPPORTED_SCHEME', detail: url.protocol };
  }

  if (url.username || url.password) {
    return { ok: false, problem: 'HAS_CREDENTIALS' };
  }

  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, problem: 'HAS_PATH' };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return { ok: false, problem: 'MALFORMED' };

  // URL wraps IPv6 literals in brackets; both forms are refused.
  const isIpLiteral =
    hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) {
    return { ok: false, problem: 'IS_IP_LITERAL', detail: hostname };
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const isDefaultPort =
    (url.protocol === 'https:' && port === 443) || (url.protocol === 'http:' && port === 80);

  return {
    ok: true,
    value: {
      origin: `${url.protocol}//${hostname}${isDefaultPort ? '' : `:${port}`}`,
      hostname,
      port,
      protocol: url.protocol,
    },
  };
}

export type ResolutionFailure = 'NXDOMAIN' | 'NO_ADDRESSES' | 'DNS_ERROR';

export type ResolveResult =
  | { ok: true; addresses: string[] }
  | { ok: false; failure: ResolutionFailure; detail?: string };

/**
 * Resolves every A and AAAA record for a hostname.
 *
 * Both families are queried because a host with one public A record and one
 * private AAAA record is a rebinding primitive, and which one a connection
 * uses is not ours to predict. classifyOrigin refuses if any of them is
 * forbidden.
 */
export async function resolveHost(hostname: string): Promise<ResolveResult> {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);

  const addresses: string[] = [];
  if (v4.status === 'fulfilled') addresses.push(...v4.value);
  if (v6.status === 'fulfilled') addresses.push(...v6.value);

  if (addresses.length === 0) {
    const reasons = [v4, v6]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as NodeJS.ErrnoException)?.code)
      .filter(Boolean);

    if (reasons.includes('ENOTFOUND')) {
      return { ok: false, failure: 'NXDOMAIN' };
    }
    if (reasons.every((c) => c === 'ENODATA')) {
      return { ok: false, failure: 'NO_ADDRESSES' };
    }
    return { ok: false, failure: 'DNS_ERROR', detail: reasons.join(',') };
  }

  return { ok: true, addresses };
}

export type OriginRefusal =
  | { kind: 'ORIGIN'; problem: OriginProblem; detail?: string }
  | { kind: 'RESOLUTION'; failure: ResolutionFailure; detail?: string }
  | { kind: 'ADDRESS'; reason: AddressRefusalReason; detail?: string };

export type ClassifyOriginResult =
  | { ok: true; parsed: ParsedOrigin; addresses: string[] }
  | { ok: false; refusal: OriginRefusal };

/**
 * The F.2 refusal gate: parse, resolve, and classify in one call.
 *
 * Used at registration (fast feedback, and so a forbidden target never exists)
 * and again at verification (the security boundary, because DNS can change
 * between the two and verification is when addresses are committed).
 */
export async function classifyOrigin(input: string): Promise<ClassifyOriginResult> {
  const parsed = parseOrigin(input);
  if (!parsed.ok) {
    return { ok: false, refusal: { kind: 'ORIGIN', problem: parsed.problem, detail: parsed.detail } };
  }

  const resolved = await resolveHost(parsed.value.hostname);
  if (!resolved.ok) {
    return {
      ok: false,
      refusal: { kind: 'RESOLUTION', failure: resolved.failure, detail: resolved.detail },
    };
  }

  const verdict = classifyResolvedAddresses(resolved.addresses);
  if (!verdict.allowed) {
    return {
      ok: false,
      refusal: {
        kind: 'ADDRESS',
        reason: verdict.reason ?? 'MALFORMED',
        detail: verdict.normalised,
      },
    };
  }

  return { ok: true, parsed: parsed.value, addresses: resolved.addresses };
}

/** Human-readable refusal message naming the triggering rule, per F.2. */
export function describeRefusal(refusal: OriginRefusal): string {
  switch (refusal.kind) {
    case 'ORIGIN':
      return {
        MALFORMED: 'The origin is not a valid absolute URL.',
        UNSUPPORTED_SCHEME: 'Only http and https origins are supported.',
        HAS_PATH: 'An origin must not include a path, query, or fragment.',
        HAS_CREDENTIALS: 'An origin must not include credentials.',
        IS_IP_LITERAL:
          'An origin must be a hostname, not an IP address: ownership cannot be proven for a bare address.',
      }[refusal.problem];
    case 'RESOLUTION':
      return {
        NXDOMAIN: 'The hostname does not resolve.',
        NO_ADDRESSES: 'The hostname has no A or AAAA records.',
        DNS_ERROR: 'DNS resolution failed.',
      }[refusal.failure];
    case 'ADDRESS':
      return `Refused: the hostname resolves to a ${refusal.reason.toLowerCase().replace(/_/g, ' ')} address${
        refusal.detail ? ` (${refusal.detail})` : ''
      }.`;
  }
}
