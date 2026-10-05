/**
 * F.8 evaluate order (fixed, no bypass):
 * kill switch → method → hostname → origin/path scope → crawl ceilings →
 * verified IP set → DNS result → private/metadata → admin blocklist →
 * rebinding (fresh IPs must match the verified set).
 *
 * Rate limiting is TokenBucket.tryRemove() in the HTTP interceptor, before
 * this function, so a refused request never consumes a network round-trip.
 */
import { isBlockedAddress, isBlockedHostname } from "./blocked-networks";
import { ipsMatchVerified, inOrigin, pathAllowed } from "./scope";
import type { EvaluateInput, GuardDecision } from "./types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function evaluate(input: EvaluateInput): GuardDecision {
  if (input.killSwitchEngaged) {
    return { allowed: false, reason: "Kill switch engaged", code: "KILL_SWITCH" };
  }
  if (!SAFE_METHODS.has(input.method.toUpperCase())) {
    return { allowed: false, reason: "Method not permitted", code: "UNSAFE_METHOD" };
  }
  if (isBlockedHostname(input.hostname)) {
    return { allowed: false, reason: "Blocked hostname", code: "PRIVATE_OR_METADATA" };
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { allowed: false, reason: "Invalid URL", code: "OUT_OF_SCOPE" };
  }
  if (!inOrigin(url, input.scope.origin) || !pathAllowed(input.pathname, input.scope)) {
    return { allowed: false, reason: "Outside target scope", code: "OUT_OF_SCOPE" };
  }
  if (input.requestsMade >= input.scope.maxRequests || input.pagesCrawled >= input.scope.maxPages) {
    return { allowed: false, reason: "Crawl ceiling reached", code: "CEILING" };
  }
  if (input.depth > input.scope.maxDepth) {
    return { allowed: false, reason: "Max depth reached", code: "CEILING" };
  }
  if (input.scope.verifiedIpSet.length === 0) {
    return { allowed: false, reason: "Target has no verified IP set", code: "EMPTY_VERIFIED_IPS" };
  }
  if (input.resolvedIps.length === 0) {
    return { allowed: false, reason: "DNS resolution failed", code: "DNS_FAILED" };
  }
  if (input.resolvedIps.some(isBlockedAddress)) {
    return { allowed: false, reason: "Resolved to a blocked address", code: "PRIVATE_OR_METADATA" };
  }
  if (input.adminBlocklist.some((entry) => input.resolvedIps.includes(entry) || input.hostname === entry)) {
    return { allowed: false, reason: "Administrator blocklist", code: "BLOCKLIST" };
  }
  if (!ipsMatchVerified(input.resolvedIps, input.scope.verifiedIpSet)) {
    return { allowed: false, reason: "IP set changed since verification", code: "REBINDING" };
  }
  return { allowed: true, ips: input.resolvedIps };
}