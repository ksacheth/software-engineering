export {
  BLOCKED_CIDRS_V4,
  BLOCKED_CIDRS_V6,
  BLOCKED_HOSTNAMES,
  ipv4InCidr,
  isBlockedAddress,
  isBlockedHostname,
} from "./blocked-networks";
export { evaluate } from "./evaluate";
export { TokenBucket } from "./rate-limit";
export { resolveHostIps } from "./resolve";
export { inOrigin, ipsMatchVerified, pathAllowed } from "./scope";
export type { OriginOptions } from "./scope";
export type { BlocklistEntry } from "@wvs/scope-rules";
export type {
  EvaluateInput,
  GuardDecision,
  GuardDenyCode,
  ScopeSnapshot,
} from "./types";
