import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { SQL } from "bun";
import type { Role } from "@wvs/database";
import { SCAN_QUEUE_NAME } from "@wvs/shared";

/**
 * Seam 2 test harness: the running API process against real Postgres and Redis.
 *
 * Everything in this file that touches the application is imported dynamically.
 * `@wvs/database` and `config/env` read `DATABASE_URL` when they are first
 * evaluated, so the test database URL must be in `process.env` before any of
 * them is loaded. Static imports are evaluated before the module body, so a
 * dynamic import after the assignment is the only ordering that holds.
 */

const TEST_DATABASE_NAME = "wvs_test";

function withDatabase(url: URL, name: string): URL {
  const next = new URL(url.toString());
  next.pathname = `/${name}`;
  return next;
}

const BASE_DATABASE_URL = new URL(
  process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/wvs",
);

/**
 * Prisma keeps its `?schema=` option; the admin connection used to create the
 * database does not, because the raw Postgres driver would forward it as a
 * server option and fail.
 */
const SOURCE_DATABASE_URL = withDatabase(BASE_DATABASE_URL, TEST_DATABASE_NAME).toString();
const ADMIN_DATABASE_URL = withDatabase(BASE_DATABASE_URL, "postgres");
ADMIN_DATABASE_URL.search = "";

process.env.DATABASE_URL = SOURCE_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL = SOURCE_DATABASE_URL;

/**
 * A scratch Redis database. The suite obliterates the scan queue and publishes
 * synthetic events, which must not touch the database a developer's running
 * API is using.
 */
const TEST_REDIS_DB = process.env.TEST_REDIS_DB ?? "15";
process.env.REDIS_DB = TEST_REDIS_DB;

const database = await import("@wvs/database");
export const prisma = database.prisma;

const { createApp } = await import("../app");
const { auth } = await import("../lib/auth");
const { attachScanGateway } = await import("../modules/scans/scan-gateway");
const { closeScanQueue } = await import("../modules/scans/scan-queue");

export const TEST_PASSWORD = "correct-horse-battery-staple";

function adminUrl(): string {
  return ADMIN_DATABASE_URL.toString();
}

/**
 * Create the test database if missing, then migrate it. Idempotent: the
 * presence of `scan_job` skips both steps, so repeated test runs are fast.
 */
export async function prepareDatabase(): Promise<void> {
  const admin = new SQL(adminUrl());
  try {
    const existing = await admin`
      select 1 from pg_database where datname = ${TEST_DATABASE_NAME}
    `;
    if (existing.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    }
  } finally {
    await admin.end();
  }

  const migrated = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `select count(*)::bigint as count from information_schema.tables where table_schema = 'public' and table_name = 'scan_job'`,
  );
  if (Number(migrated[0]?.count ?? 0) > 0) return;

  const databaseDir = new URL("../../../../packages/database/", import.meta.url).pathname;
  const result = Bun.spawnSync(["bun", "run", "prisma", "migrate", "deploy"], {
    cwd: databaseDir,
    env: {
      ...process.env,
      DATABASE_URL: SOURCE_DATABASE_URL,
      MIGRATION_DATABASE_URL: SOURCE_DATABASE_URL,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `prisma migrate deploy failed: ${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
}

/**
 * Append-only stores (DC-9) refuse TRUNCATE at the database level, which is
 * exactly the behaviour they should have. A test database still has to start
 * from zero between tests, so their user triggers are disabled for the reset
 * and restored immediately after. Nothing in application code can do this: the
 * production role has no DDL rights and never runs a reset.
 */
const APPEND_ONLY_TABLES = ["audit_log", "url_ledger", "finding_triage_history"];

/** Truncate every application table, leaving the migration ledger alone. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) return;

  const present = new Set(tables.map((row) => row.tablename));
  const appendOnly = APPEND_ONLY_TABLES.filter((table) => present.has(table));
  const list = tables.map((row) => `"public"."${row.tablename}"`).join(", ");

  for (const table of appendOnly) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "public"."${table}" DISABLE TRIGGER USER`,
    );
  }
  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    for (const table of appendOnly) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "public"."${table}" ENABLE TRIGGER USER`,
      );
    }
  }
}

export function redisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(TEST_REDIS_DB),
    maxRetriesPerRequest: 2,
  });
}

export interface TestApi {
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestApi(): Promise<TestApi> {
  const app = createApp();
  const server: Server = createServer(app);
  // A short keepalive interval so the socket tests can observe a ping without
  // waiting the production 30 seconds.
  const gateway = attachScanGateway(server, { pingIntervalMs: 250 });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await gateway.close();
      // `fetch` keeps connections alive; without this, `server.close()` waits
      // for keep-alive sockets that will never be used again.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeScanQueue();
    },
  };
}

export interface TestSession {
  cookie: string;
  userId: string;
  organizationId: string;
  email: string;
  role: Role;
}

/**
 * A real account with a real Better Auth session cookie.
 *
 * Sign-up with `requireEmailVerification` issues no session, so the address is
 * marked verified directly and then signed in through the library: the cookie
 * is the genuine article, including its signature, and the organisation comes
 * from the signup hook rather than from a fixture.
 */
export async function createSession(role: Role = "ANALYST"): Promise<TestSession> {
  const email = `${randomUUID()}@example.test`;
  const password = TEST_PASSWORD;

  await auth.api.signUpEmail({
    body: { email, password, name: `Test ${role}` },
  });

  const user = await prisma.user.update({
    where: { email },
    data: { emailVerified: true, role },
  });
  const member = await prisma.member.findUniqueOrThrow({
    where: { userId: user.id },
    select: { organizationId: true },
  });

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });

  const setCookies =
    signIn.headers.getSetCookie?.() ?? [signIn.headers.get("set-cookie") ?? ""];
  const cookie = setCookies
    .map((entry) => entry.split(";")[0])
    .filter(Boolean)
    .join("; ");

  return {
    cookie,
    userId: user.id,
    organizationId: member.organizationId,
    email,
    role,
  };
}

export interface TestTarget {
  id: string;
  origin: string;
}

/** A target that passes the C.2 gate, so scan tests exercise the scan path. */
export async function createVerifiedTarget(
  organizationId: string,
): Promise<TestTarget> {
  const origin = `https://target-${randomUUID().slice(0, 8)}.example.test`;
  const target = await prisma.target.create({
    data: {
      organizationId,
      origin,
      label: "Test target",
      verificationToken: randomUUID(),
      verificationMethod: "DNS_TXT",
      verificationStatus: "VERIFIED",
      verifiedAt: new Date(),
      verificationExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      authorisationAck: true,
      authorisationAckAt: new Date(),
      verifiedIpRanges: ["93.184.216.34/32"],
    },
  });
  return { id: target.id, origin };
}

export function request(
  api: TestApi,
  session: TestSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${api.baseUrl}${path}`, {
    ...init,
    headers: {
      cookie: session.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export function scanQueue(): Queue {
  return new Queue(SCAN_QUEUE_NAME, {
    connection: {
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(TEST_REDIS_DB),
    },
  });
}
