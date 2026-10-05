/**
 * The proxies Better Auth may strip from X-Forwarded-For, derived from the same
 * TRUST_PROXY value Express uses, so the two cannot disagree about who the
 * client is.
 *
 * Express understands named subnets; Better Auth only takes addresses and CIDR
 * ranges. Without this, the containerised deployment (where nginx reaches the
 * API from a private bridge address, not loopback) would leave Better Auth
 * trusting nobody, and every sign-in attempt would land in one shared per-path
 * rate-limit bucket.
 */
const NAMED_SUBNETS: Record<string, readonly string[]> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

export function trustedProxyCidrs(setting: boolean | number | string): string[] {
  if (setting === false) return [];
  if (setting === true) return ["0.0.0.0/0", "::/0"];
  // A hop count has no address form. Loopback is the safe reading: it is what
  // the default deployment needs, and it never trusts a spoofed header from a
  // remote caller.
  if (typeof setting === "number") return [...NAMED_SUBNETS.loopback!];

  return setting
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => NAMED_SUBNETS[entry] ?? [entry]);
}
