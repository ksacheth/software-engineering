import type { BlocklistEntry } from "@wvs/scope-rules";

export type GuardDecision =
  | { allowed: true; ips: string[] }
  | { allowed: false; reason: string; code: GuardDenyCode; ips?: string[] };

export type GuardDenyCode =
  | "UNVERIFIED"
  | "EMPTY_VERIFIED_IPS"
  | "OUT_OF_SCOPE"
  | "BLOCKLIST"
  | "PRIVATE_OR_METADATA"
  | "RATE_LIMIT"
  | "CEILING"
  | "KILL_SWITCH"
  | "DNS_FAILED"
  | "REBINDING"
  | "UNSAFE_METHOD";

export interface ScopeSnapshot {
  origin: string;
  includedPaths: string[];
  excludedPaths: string[];
  verifiedIpSet: string[];
  rateLimit: number;
  maxPages: number;
  maxRequests: number;
  maxDepth: number;
}

export interface EvaluateInput {
  url: string;
  method: string;
  hostname: string;
  pathname: string;
  resolvedIps: string[];
  scope: ScopeSnapshot;
  /** Active NetworkBlocklist rows; matched with @wvs/scope-rules' matchBlocklist. */
  adminBlocklist: readonly BlocklistEntry[];
  killSwitchEngaged: boolean;
  pagesCrawled: number;
  requestsMade: number;
  depth: number;
  /**
   * Admits `http://<scope host>/` (default port, GET only) for an https scope,
   * so A-14 can check that the plaintext origin redirects. Every other check
   * still applies.
   */
  allowPlaintextTwin?: boolean;
}