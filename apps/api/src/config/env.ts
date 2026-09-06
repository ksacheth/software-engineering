import { readFileSync } from 'node:fs';

/**
 * Bun auto-loads .env from the CWD, but under Turborepo the CWD is apps/api
 * while the repo-root .env lives one level up — load it manually if present.
 * Never overrides variables that are already set.
 */
const ROOT_ENV = new URL('../../../.env', import.meta.url);

function loadRootEnv(): void {
  let content: string;
  try {
    content = readFileSync(ROOT_ENV, 'utf8');
  } catch {
    return; // no root .env — rely on process env / apps/api/.env
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
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

loadRootEnv();

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),
  corsOrigins: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000'],
  jwt: {
    // TODO(F.1): fail fast at boot when missing instead of defaulting.
    secret: process.env.JWT_SECRET ?? '',
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION ?? '15m',
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION ?? '7d',
  },
} as const;
