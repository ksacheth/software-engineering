import { isWithinVerifiedSet } from "@wvs/scope-rules";
import type { ScopeSnapshot } from "./types";

export interface OriginOptions {
  /** Admit `http://<scope host>/` for an https scope (A-14 plaintext twin). */
  allowPlaintextTwin?: boolean;
  /** Defaults to GET; the twin is admitted for GET only. */
  method?: string;
}

function isPlaintextTwin(url: URL, scopeOrigin: URL, method: string): boolean {
  return (
    scopeOrigin.protocol === "https:" &&
    url.protocol === "http:" &&
    url.hostname === scopeOrigin.hostname &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    method.toUpperCase() === "GET"
  );
}

export function inOrigin(url: URL, origin: string, options: OriginOptions = {}): boolean {
  const scopeOrigin = new URL(origin);
  if (url.origin === scopeOrigin.origin) return true;
  if (!options.allowPlaintextTwin) return false;
  return isPlaintextTwin(url, scopeOrigin, options.method ?? "GET");
}

/** Rounds of percent-decoding, so a double-encoded `/%2561dmin` still reads as `/admin`. */
const DECODE_ROUNDS = 3;

/** Decodes each run of valid escapes and leaves a malformed one (`/100%`) as it is. */
function decodeOnce(path: string): string {
  return path.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Decodes percent-escapes (up to DECODE_ROUNDS deep), treats `\` as `/`,
 * resolves dot segments and collapses repeated slashes, so `/%61dmin`,
 * `/%5cadmin`, `//admin` and `/a/%2e%2e/admin` all compare as `/admin`.
 */
function normalisePath(pathname: string): string {
  let decoded = pathname;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return resolveSegments(decoded.replace(/\\/g, "/"));
}

/** Drops empty and `.` segments and applies `..`, so the result is `/`-rooted and canonical. */
function resolveSegments(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Exclusions over-match on purpose: `/admin` also covers `/admin.php`,
 * `/admin;jsessionid=1` and `/administrator`, compared case-insensitively
 * because many servers treat `/Admin` as `/admin`.
 */
function excluded(path: string, prefixes: readonly string[]): boolean {
  const subject = path.toLowerCase();
  return prefixes.some((raw) => subject.startsWith(normalisePath(raw).toLowerCase()));
}

/** Inclusions match on segment boundaries: `/app` admits `/app/x`, not `/apple`. */
function included(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((raw) => {
    const prefix = normalisePath(raw);
    return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
  });
}

export function pathAllowed(pathname: string, scope: ScopeSnapshot): boolean {
  const path = normalisePath(pathname);
  if (excluded(path, scope.excludedPaths)) return false;
  return scope.includedPaths.length === 0 || included(path, scope.includedPaths);
}

/**
 * Every resolved address must be in the verified set. Entries are the
 * single-host CIDRs stored in Target.verifiedIpRanges (`/32`, `/128`);
 * fails closed on an empty set, empty resolution or a malformed entry.
 */
export function ipsMatchVerified(resolved: readonly string[], verified: readonly string[]): boolean {
  if (resolved.length === 0) return false;
  return resolved.every((ip) => isWithinVerifiedSet(ip, verified).allowed);
}
