import { isIPv4 } from "node:net";
import { classifyAddress } from "@wvs/scope-rules";

/** Fixed refusals (F.8). Admin NetworkBlocklist is applied on top of these. */
export const BLOCKED_CIDRS_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

export const BLOCKED_CIDRS_V6 = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "64:ff9b::/96",
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

/** Expands canonical IPv6 text (as produced by classifyAddress) to 8 groups. */
function expandGroups(text: string): number[] {
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)));
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** The IPv4 address a 6to4 (2002::/16) address routes to, or null. */
function sixToFourTarget(normalised: string): string | null {
  const [g0, g1 = 0, g2 = 0] = expandGroups(normalised);
  if (g0 !== 0x2002) return null;
  return `${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`;
}

/**
 * True when the address must never be connected to. Built on scope-rules'
 * classifyAddress (ADR-0005) so public IPv6 is allowed while private,
 * link-local, metadata and IPv4-embedded forms are refused. Fails closed on
 * unparseable input. 6to4 addresses are refused when they embed a forbidden
 * IPv4 address.
 */
export function isBlockedAddress(ip: string): boolean {
  const verdict = classifyAddress(ip);
  if (!verdict.allowed) return true;
  const embedded = verdict.normalised ? sixToFourTarget(verdict.normalised) : null;
  return embedded !== null && !classifyAddress(embedded).allowed;
}
