import { isIPv4, isIPv6 } from "node:net";

/** Fixed refusals (F.8). Admin NetworkBlocklist is applied on top of these. */
export const BLOCKED_CIDRS_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

export const BLOCKED_CIDRS_V6 = [
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "::ffff:127.0.0.0/104",
  "::ffff:10.0.0.0/104",
  "::ffff:169.254.0.0/112",
  "::ffff:172.16.0.0/108",
  "::ffff:192.168.0.0/112",
] as const;

export const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
]);

function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return (
    (((parts[0]! << 24) >>> 0) |
      (parts[1]! << 16) |
      (parts[2]! << 8) |
      parts[3]!) >>>
    0
  );
}

function parseCidrV4(cidr: string): { start: number; mask: number } | null {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const addr = ipv4ToInt(base ?? "");
  if (addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return null;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { start: addr & mask, mask };
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const n = ipv4ToInt(ip);
  const range = parseCidrV4(cidr);
  if (n === null || !range) return false;
  return (n & range.mask) === range.start;
}

export function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAMES.has(hostname.toLowerCase());
}

export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    return BLOCKED_CIDRS_V4.some((cidr) => ipv4InCidr(ip, cidr));
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
  }
  return true;
}