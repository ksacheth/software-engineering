import { readFileSync } from "node:fs";

/**
 * Bun auto-loads .env from the CWD, but under Turborepo the CWD is apps/api
 * while the repo-root .env lives one level up — load it manually if present.
 * Never overrides variables that are already set.
 */
const ROOT_ENV = new URL("../../../.env", import.meta.url);

function loadRootEnv(): void {
  let content: string;
  try {
    content = readFileSync(ROOT_ENV, "utf8");
  } catch {
    return; // no root .env — rely on process env / apps/api/.env
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return value === "true" || value === "1";
}

/**
 * F.1: a missing auth secret is fatal, not a default.
 *
 * Better Auth falls back to a publicly known development secret when none is
 * set, which would sign every session cookie with a value an attacker can read
 * from the library source. Refusing to boot is the safe failure.
 */
function requiredSecret(name: string, value: string | undefined): void {
  if (!value || value.trim() === "") {
    throw new Error(
      `[config] ${name} is required but was not set. Generate one with: openssl rand -base64 32`,
    );
  }
}

/**
 * Express `trust proxy` setting.
 *
 * Both the Vite dev proxy and the production nginx run on loopback, so trusting
 * loopback reads the real client IP out of X-Forwarded-For while still refusing
 * a spoofed header from a direct caller. Accepts `false`, `true`, a hop count,
 * or an Express trust-proxy expression.
 */
function trustProxySetting(
  value: string | undefined,
): boolean | number | string {
  if (value === undefined || value.trim() === "") return "loopback";
  if (value === "true") return true;
  if (value === "false") return false;
  const hops = Number(value);
  return Number.isInteger(hops) ? hops : value;
}

loadRootEnv();

requiredSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET);

if (!process.env.BETTER_AUTH_URL) {
  // Verification and reset links are built from baseURL. Without it Better Auth
  // infers the host from the request, which breaks behind a reverse proxy.
  console.warn(
    "[config] BETTER_AUTH_URL is not set; email links will be inferred from requests",
  );
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: num(process.env.PORT, 4100),
  corsOrigins: process.env.WEB_ORIGIN?.split(",") ?? ["http://localhost:3000"],
  trustProxy: trustProxySetting(process.env.TRUST_PROXY),
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: num(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD ?? "",
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "localhost",
    port: num(process.env.SMTP_PORT, 1025),
    user: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASS || undefined,
    from: process.env.SMTP_FROM ?? "noreply@wvs.local",
    secure: bool(process.env.SMTP_SECURE, false),
  },
} as const;
