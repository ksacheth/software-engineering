import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { WebSocket } from "ws";
import {
  createSession,
  createVerifiedTarget,
  prepareDatabase,
  prisma,
  redisClient,
  request,
  resetDatabase,
  scanQueue,
  startTestApi,
  type TestApi,
  type TestSession,
  type TestTarget,
} from "../../test-support/harness";

/**
 * F.3 trigger, control and observation, exercised through the running API.
 *
 * These tests assert on what a caller can observe: response bodies and
 * statuses, scan rows, queue contents, audit records and socket traffic. They
 * deliberately do not mock the database, Redis or the session middleware,
 * because the failures worth catching here are exactly the ones a handler-level
 * mock would hide: a role check that never runs, a quota that two simultaneous
 * requests can both pass, an organisation boundary that leaks.
 */

setDefaultTimeout(30_000);

const CHANNEL = "wvs:scan-events";

let api: TestApi;
let queue: ReturnType<typeof scanQueue>;

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
  queue = scanQueue();
});

afterAll(async () => {
  await api.close();
  await queue.close();
});

beforeEach(async () => {
  await resetDatabase();
  await queue.obliterate({ force: true });
});

/** A scan row in a given state, standing in for what the orchestrator does. */
async function seedScan(
  session: TestSession,
  target: TestTarget,
  status: "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED" | "ABORTED_SAFETY",
  extra: Record<string, unknown> = {},
) {
  return prisma.scanJob.create({
    data: {
      targetId: target.id,
      organizationId: session.organizationId,
      status,
      createdById: session.userId,
      startedAt: status === "RUNNING" || status === "PAUSED" ? new Date() : null,
      completedAt: status === "COMPLETED" ? new Date() : null,
      ...extra,
    },
  });
}

interface OpenSocket {
  socket: WebSocket;
  messages: unknown[];
  next(predicate: (message: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

async function openSocket(
  path: string,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<OpenSocket> {
  const socket = new WebSocket(`${api.wsUrl}${path}`, {
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
  });
  const messages: unknown[] = [];
  const waiters: { predicate: (m: unknown) => boolean; resolve: (m: unknown) => void }[] = [];

  socket.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    messages.push(parsed);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(parsed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    socket.on("open", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    // Persistent, not `once`: a refused handshake can emit more than one error,
    // and an unhandled error event would take down the test process.
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`socket closed with code ${code}`));
      }
    });
  });

  return {
    socket,
    messages,
    next: (predicate, timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        const existing = messages.find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`no matching event within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      }),
    close: () => socket.close(),
  };
}

function isScanEventOfType(value: unknown, type: string): boolean {
  return (value as { type?: string }).type === type;
}

describe("starting a scan", () => {
  test("returns an identifier immediately and records a queued row", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, profile: "PASSIVE" }),
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("content-type")).toContain("application/json");

    const { scan } = (await res.json()) as { scan: Record<string, unknown> };
    expect(typeof scan.id).toBe("string");
    expect(scan.status).toBe("QUEUED");
    expect(scan.profile).toBe("PASSIVE");
    expect(scan.configuration).toEqual({
      rateLimit: 5,
      concurrency: 5,
      maxDepth: 3,
      maxPages: 100,
      maxRequests: 1000,
    });
    expect(scan.target).toMatchObject({ id: target.id });

    const row = await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id as string } });
    expect(row.status).toBe("QUEUED");
    expect(row.organizationId).toBe(session.organizationId);
    expect(row.createdById).toBe(session.userId);
    // The scope snapshot is copied at launch (F.2/F.3 reproducibility).
    expect(row.includedPaths).toEqual([]);
  });

  test("enqueues a job whose id is the scan id, so a double submit cannot duplicate it", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });
    const { scan } = (await res.json()) as { scan: { id: string } };

    const job = await queue.getJob(scan.id);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({
      scanJobId: scan.id,
      organizationId: session.organizationId,
      attempt: 1,
    });
  });

  test("records who started the scan, so activity can be attributed", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    const { scan } = (await res.json()) as {
      scan: { startedBy: { id: string; name: string } | null; createdById: string };
    };
    expect(scan.createdById).toBe(session.userId);
    expect(scan.startedBy?.id).toBe(session.userId);
    expect(scan.startedBy?.name).toBe("Test ANALYST");
  });

  test("writes exactly one queued audit record", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });
    const { scan } = (await res.json()) as { scan: { id: string } };

    const audits = await prisma.auditLog.findMany({ where: { resourceId: scan.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("SCAN_QUEUED");
    expect(audits[0]!.userId).toBe(session.userId);
    expect(audits[0]!.organizationId).toBe(session.organizationId);
  });

  test("refuses every configuration problem at once", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({
        targetId: target.id,
        configuration: { rateLimit: 99, maxDepth: 0, maxRequests: -5 },
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as {
      title: string;
      errors: { pointer: string; detail: string }[];
    };
    expect(problem.title).toBe("Validation failed");
    expect(problem.errors.map((error) => error.pointer).sort()).toEqual([
      "/configuration/maxDepth",
      "/configuration/maxRequests",
      "/configuration/rateLimit",
    ]);
  });

  test("refuses a request ceiling below the page ceiling", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({
        targetId: target.id,
        configuration: { maxPages: 200, maxRequests: 100 },
      }),
    });

    expect(res.status).toBe(400);
    const problem = (await res.json()) as { errors: { pointer: string }[] };
    expect(problem.errors.map((error) => error.pointer)).toContain(
      "/configuration/maxRequests",
    );
  });

  test("refuses unknown request members rather than ignoring them", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, maxPages: 500 }),
    });

    expect(res.status).toBe(400);
  });

  test("does not write an audit row for a refused start", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    await prisma.target.update({
      where: { id: target.id },
      data: { isArchived: true },
    });

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(res.status).toBe(422);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  test("refuses an unverified target, naming the reason C.2 refuses it", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    await prisma.target.update({
      where: { id: target.id },
      data: { verificationStatus: "PENDING", verifiedIpRanges: [] },
    });

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe("NOT_VERIFIED");
    expect(problem.detail).toContain("C.2");
  });

  test("does not find another organisation's target", async () => {
    const session = await createSession("ANALYST");
    const other = await createSession("ANALYST");
    const target = await createVerifiedTarget(other.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(res.status).toBe(404);
  });

  test("refuses a viewer, because read-only means read-only", async () => {
    const session = await createSession("VIEWER");
    const target = await createVerifiedTarget(session.organizationId);

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(res.status).toBe(403);
  });

  test("names the concurrency limit when the quota is full", async () => {
    const session = await createSession("ANALYST");
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: { maxConcurrentScans: true },
    });
    expect(organization.maxConcurrentScans).toBe(2);

    const first = await createVerifiedTarget(session.organizationId);
    const second = await createVerifiedTarget(session.organizationId);
    const third = await createVerifiedTarget(session.organizationId);

    for (const target of [first, second]) {
      const res = await request(api, session, "/api/scans", {
        method: "POST",
        body: JSON.stringify({ targetId: target.id }),
      });
      expect(res.status).toBe(202);
    }

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: third.id }),
    });

    expect(res.status).toBe(429);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe("ORG_CONCURRENCY_LIMIT");
    expect(problem.detail).toContain("2 concurrent scans");
    expect(await prisma.scanJob.count()).toBe(2);
  });

  test("refuses a second scan of the same target while one is active", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);

    const first = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });
    expect(first.status).toBe(202);

    const second = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(second.status).toBe(409);
    const problem = (await second.json()) as { code: string };
    expect(problem.code).toBe("TARGET_ALREADY_ACTIVE");
    expect(await prisma.scanJob.count()).toBe(1);
  });

  test("allows a new scan once the previous one is terminal", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    await seedScan(session, target, "COMPLETED");

    const res = await request(api, session, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id }),
    });

    expect(res.status).toBe(202);
  });
});

describe("controlling a scan", () => {
  test("pauses a running scan and audits it once", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    const res = await request(api, session, `/api/scans/${scan.id}/pause`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { status: string } };
    expect(body.scan.status).toBe("PAUSED");
    expect((await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } })).pausedAt).not.toBeNull();

    const audits = await prisma.auditLog.findMany({ where: { resourceId: scan.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("SCAN_PAUSED");
  });

  test("resumes a paused scan", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "PAUSED");

    const res = await request(api, session, `/api/scans/${scan.id}/resume`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { status: string } };
    expect(body.scan.status).toBe("RUNNING");
    expect((await prisma.auditLog.findMany({ where: { resourceId: scan.id } }))[0]!.action).toBe(
      "SCAN_RESUMED",
    );
  });

  test("cancels a running scan and records when", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    const res = await request(api, session, `/api/scans/${scan.id}/cancel`, { method: "POST" });

    expect(res.status).toBe(200);
    const row = await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledAt).not.toBeNull();
  });

  test("refuses to pause a scan that is not running", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "QUEUED");

    const res = await request(api, session, `/api/scans/${scan.id}/pause`, { method: "POST" });

    expect(res.status).toBe(409);
    const problem = (await res.json()) as { code: string; scanStatus: string; detail: string };
    expect(problem.code).toBe("CANNOT_PAUSE");
    expect(problem.scanStatus).toBe("QUEUED");
    expect((await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe("QUEUED");
  });

  test("tells the user a queued scan has not started when they resume it", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "QUEUED");

    const res = await request(api, session, `/api/scans/${scan.id}/resume`, { method: "POST" });

    expect(res.status).toBe(409);
    const problem = (await res.json()) as { code: string; detail: string };
    expect(problem.code).toBe("CANNOT_RESUME");
    expect(problem.detail).toContain("has not started");
  });

  test("refuses to cancel a finished scan and leaves the result intact", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "COMPLETED");

    const res = await request(api, session, `/api/scans/${scan.id}/cancel`, { method: "POST" });

    expect(res.status).toBe(409);
    const problem = (await res.json()) as { code: string };
    expect(problem.code).toBe("CANNOT_CANCEL");
    expect((await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe(
      "COMPLETED",
    );
  });

  test("does not find another organisation's scan", async () => {
    const session = await createSession("ANALYST");
    const other = await createSession("ANALYST");
    const target = await createVerifiedTarget(other.organizationId);
    const scan = await seedScan(other, target, "RUNNING");

    const res = await request(api, session, `/api/scans/${scan.id}/pause`, { method: "POST" });
    expect(res.status).toBe(404);

    const read = await request(api, session, `/api/scans/${scan.id}`);
    expect(read.status).toBe(404);

    // And the row is untouched.
    expect((await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe("RUNNING");
  });
});

describe("reading scans", () => {
  test("lists newest first with the target attached", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    await seedScan(session, target, "COMPLETED", { createdAt: new Date("2026-01-01T00:00:00Z") });
    await seedScan(session, target, "FAILED", {
      createdAt: new Date("2026-02-01T00:00:00Z"),
      failureReason: "DNS resolution failed",
    });

    const res = await request(api, session, "/api/scans");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scans: { status: string; target: { id: string }; failureReason: string | null }[];
      nextCursor: string | null;
    };
    expect(body.scans.map((scan) => scan.status)).toEqual(["FAILED", "COMPLETED"]);
    expect(body.scans[0]!.target.id).toBe(target.id);
    expect(body.scans[0]!.failureReason).toBe("DNS resolution failed");
    expect(body.nextCursor).toBeNull();
  });

  test("filters by target and by status", async () => {
    const session = await createSession("ANALYST");
    const targetA = await createVerifiedTarget(session.organizationId);
    const targetB = await createVerifiedTarget(session.organizationId);
    await seedScan(session, targetA, "COMPLETED");
    await seedScan(session, targetB, "FAILED");

    const byTarget = (await (
      await request(api, session, `/api/scans?targetId=${targetA.id}`)
    ).json()) as { scans: { targetId: string }[] };
    expect(byTarget.scans).toHaveLength(1);
    expect(byTarget.scans[0]!.targetId).toBe(targetA.id);

    const byStatus = (await (
      await request(api, session, "/api/scans?status=FAILED")
    ).json()) as { scans: { status: string }[] };
    expect(byStatus.scans).toHaveLength(1);
    expect(byStatus.scans[0]!.status).toBe("FAILED");
  });

  test("paginates with a cursor", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    for (let index = 0; index < 3; index += 1) {
      await seedScan(session, target, "COMPLETED", {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const firstPage = (await (
      await request(api, session, "/api/scans?limit=2")
    ).json()) as { scans: { id: string }[]; nextCursor: string | null };
    expect(firstPage.scans).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = (await (
      await request(api, session, `/api/scans?limit=2&cursor=${firstPage.nextCursor}`)
    ).json()) as { scans: { id: string }[]; nextCursor: string | null };
    expect(secondPage.scans).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const ids = [...firstPage.scans, ...secondPage.scans].map((scan) => scan.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("refuses a malformed cursor and an unknown status", async () => {
    const session = await createSession("ANALYST");

    const badCursor = await request(api, session, "/api/scans?cursor=not-a-cursor");
    expect(badCursor.status).toBe(400);

    const badStatus = await request(api, session, "/api/scans?status=STALLED");
    expect(badStatus.status).toBe(400);
  });

  test("lets a viewer read scans", async () => {
    const session = await createSession("VIEWER");
    const res = await request(api, session, "/api/scans");
    expect(res.status).toBe(200);
  });

  test("surfaces recorded warnings after a reload", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "COMPLETED", {
      degradations: [
        { code: "RENDERING_UNAVAILABLE", message: "JavaScript rendering was unavailable." },
      ],
      blockingDetected: true,
      bindingLimit: "PAGE_CEILING_REACHED",
    });

    const res = await request(api, session, `/api/scans/${scan.id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { scan: { warnings: { code: string }[] } };
    expect(body.scan.warnings.map((warning) => warning.code).sort()).toEqual([
      "CRAWL_LIMIT_REACHED",
      "RENDERING_UNAVAILABLE",
      "TARGET_BLOCKING_DETECTED",
    ]);
  });

  test("rebuilds the live finding list after a reload", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");
    await prisma.finding.create({
      data: {
        fingerprint: "fp-1",
        scanJobId: scan.id,
        targetId: target.id,
        detectorId: "P-01",
        name: "Missing Content-Security-Policy",
        description: "No CSP header was returned.",
        remediation: "Set a restrictive Content-Security-Policy.",
        severity: "MEDIUM",
        confidence: "CONFIRMED",
        affectedUrl: `${target.origin}/`,
      },
    });

    const res = await request(api, session, `/api/scans/${scan.id}/findings`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      findings: { fingerprint: string; detectorId: string; severity: string }[];
    };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      fingerprint: "fp-1",
      detectorId: "P-01",
      severity: "MEDIUM",
    });
  });

  test("does not expose another organisation's findings", async () => {
    const session = await createSession("ANALYST");
    const other = await createSession("ANALYST");
    const otherTarget = await createVerifiedTarget(other.organizationId);
    const otherScan = await seedScan(other, otherTarget, "RUNNING");

    const res = await request(api, session, `/api/scans/${otherScan.id}/findings`);
    expect(res.status).toBe(404);
  });
});

describe("live updates", () => {
  test("delivers a published progress event to a per-scan socket", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    const client = await openSocket(`/ws/scans/${scan.id}`, session.cookie);
    const publisher = redisClient();
    try {
      await publisher.publish(
        CHANNEL,
        JSON.stringify({
          type: "scan.progress",
          scanJobId: scan.id,
          at: "2026-09-11T09:15:00.000Z",
          phase: "DISCOVERY",
          pagesCrawled: 12,
          requestsMade: 40,
          findingsCount: 3,
          progressPercentage: 25,
        }),
      );

      const event = (await client.next(
        (message) => (message as { type?: string }).type === "scan.progress",
      )) as { scanJobId: string; at: string; pagesCrawled: number };
      expect(event.scanJobId).toBe(scan.id);
      expect(event.at).toBe("2026-09-11T09:15:00.000Z");
      expect(event.pagesCrawled).toBe(12);
    } finally {
      client.close();
      await publisher.quit();
    }
  });

  test("delivers findings and warnings through the multiplexed socket", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    const client = await openSocket("/ws", session.cookie);
    const publisher = redisClient();
    try {
      await publisher.publish(
        CHANNEL,
        JSON.stringify({
          type: "scan.finding",
          scanJobId: scan.id,
          at: "2026-09-11T09:15:01.000Z",
          fingerprint: "fp-1",
          detectorId: "P-01",
          name: "Missing Content-Security-Policy",
          severity: "MEDIUM",
          affectedUrl: `${target.origin}/`,
        }),
      );
      await publisher.publish(
        CHANNEL,
        JSON.stringify({
          type: "scan.warning",
          scanJobId: scan.id,
          at: "2026-09-11T09:15:02.000Z",
          code: "RENDERING_UNAVAILABLE",
          message: "JavaScript rendering was unavailable.",
        }),
      );

      const finding = (await client.next(
        (message) => (message as { type?: string }).type === "scan.finding",
      )) as { severity: string };
      expect(finding.severity).toBe("MEDIUM");

      const warning = (await client.next(
        (message) => (message as { type?: string }).type === "scan.warning",
      )) as { code: string };
      expect(warning.code).toBe("RENDERING_UNAVAILABLE");
    } finally {
      client.close();
      await publisher.quit();
    }
  });

  test("does not deliver another organisation's events", async () => {
    const session = await createSession("ANALYST");
    const other = await createSession("ANALYST");
    const otherTarget = await createVerifiedTarget(other.organizationId);
    const otherScan = await seedScan(other, otherTarget, "RUNNING");

    const client = await openSocket("/ws", session.cookie);
    const publisher = redisClient();
    try {
      await publisher.publish(
        CHANNEL,
        JSON.stringify({
          type: "scan.progress",
          scanJobId: otherScan.id,
          at: "2026-09-11T09:15:00.000Z",
          phase: "DISCOVERY",
          pagesCrawled: 1,
          requestsMade: 1,
          findingsCount: 0,
          progressPercentage: 1,
        }),
      );
      // Give the fan-out a chance to (incorrectly) deliver before asserting.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.messages.filter((message) => !isScanEventOfType(message, "ping"))).toEqual([]);
    } finally {
      client.close();
      await publisher.quit();
    }
  });

  test("refuses a socket for a scan the caller's organisation does not own", async () => {
    const session = await createSession("ANALYST");
    const other = await createSession("ANALYST");
    const otherTarget = await createVerifiedTarget(other.organizationId);
    const otherScan = await seedScan(other, otherTarget, "RUNNING");

    await expect(openSocket(`/ws/scans/${otherScan.id}`, session.cookie)).rejects.toThrow();
  });

  test("refuses a socket without a session", async () => {
    await expect(openSocket("/ws")).rejects.toThrow();
  });

  test("accepts a same-host origin, which is what a reverse proxy presents", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    // Vite's dev proxy and nginx rewrite Origin to the address they forward
    // to, so the API sees its own host rather than the public one.
    const client = await openSocket(`/ws/scans/${scan.id}`, session.cookie, {
      origin: api.wsUrl.replace(/^ws/, "http"),
    });
    client.close();
  });

  test("refuses a socket opened from another origin", async () => {
    const session = await createSession("ANALYST");
    await expect(
      openSocket("/ws", session.cookie, { origin: "http://evil.example" }),
    ).rejects.toThrow();
  });

  test("sends a keepalive ping so a quiet scan is not mistaken for a dead socket", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedScan(session, target, "RUNNING");

    const client = await openSocket(`/ws/scans/${scan.id}`, session.cookie);
    try {
      const ping = (await client.next((message) => isScanEventOfType(message, "ping"))) as {
        at: string;
      };
      expect(Number.isNaN(new Date(ping.at).getTime())).toBe(false);
    } finally {
      client.close();
    }
  });
});
