import type { ScopeSnapshot } from "./types";

export function inOrigin(url: URL, origin: string): boolean {
  return url.origin === new URL(origin).origin;
}

export function pathAllowed(pathname: string, scope: ScopeSnapshot): boolean {
  if (scope.excludedPaths.some((p) => pathname.startsWith(p))) return false;
  if (scope.includedPaths.length === 0) return true;
  return scope.includedPaths.some((p) => pathname.startsWith(p));
}

export function ipsMatchVerified(resolved: string[], verified: string[]): boolean {
  if (verified.length === 0) return false;
  return resolved.every((ip) => verified.includes(ip));
}