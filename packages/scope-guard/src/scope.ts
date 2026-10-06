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
    method.toUpperCase() === "GET"
  );
}

export function inOrigin(url: URL, origin: string, options: OriginOptions = {}): boolean {
  const scopeOrigin = new URL(origin);
  if (url.origin === scopeOrigin.origin) return true;
  if (!options.allowPlaintextTwin) return false;
  return isPlaintextTwin(url, scopeOrigin, options.method ?? "GET");
}

/**
 * Decodes percent-escapes once, resolves dot segments and collapses repeated
 * slashes, so `/%61dmin`, `//admin` and `/a/%2e%2e/admin` all compare as
 * `/admin`. Returns null for a malformed escape; callers treat that as out of
 * scope.
 */
function normalisePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** Prefix match on segment boundaries: `/app` matches `/app/x`, not `/apple`. */
function underPrefix(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function matchesAny(path: string, prefixes: readonly string[], fold: boolean): boolean {
  const subject = fold ? path.toLowerCase() : path;
  return prefixes.some((raw) => {
    const prefix = normalisePath(raw) ?? raw;
    return underPrefix(subject, fold ? prefix.toLowerCase() : prefix);
  });
}

export function pathAllowed(pathname: string, scope: ScopeSnapshot): boolean {
  const path = normalisePath(pathname);
  if (path === null) return false;
  // Exclusions fold case: a case-insensitive server serves /Admin as /admin.
  if (matchesAny(path, scope.excludedPaths, true)) return false;
  if (scope.includedPaths.length === 0) return true;
  return matchesAny(path, scope.includedPaths, false);
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
