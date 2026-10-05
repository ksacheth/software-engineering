import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

export async function resolveHostIps(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const resolver = new Resolver();
  resolver.setServers(resolver.getServers());
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const ips = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];
  if (ips.length === 0) {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }
  return [...new Set(ips)];
}