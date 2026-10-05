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
  adminBlocklist: string[];
  killSwitchEngaged: boolean;
  pagesCrawled: number;
  requestsMade: number;
  depth: number;
}