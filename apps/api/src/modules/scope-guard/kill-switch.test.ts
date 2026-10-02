import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  createAdminSession,
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
import { reconcileScans } from "../scans/scan-reconciler";
import { enqueueScan } from "../scans/scan-queue";

/**
 * F.8 kill switch (ADR-0008), exercised through the running API.
 *
 * Scan rows stand in for the orchestrator, as in the F.3 suite: what matters
 * here is what the switch does to rows, the queue, the audit log and the scan
 * endpoints, all of which are observable without a worker.
 */

setDefaultTimeout(30_000);

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

type SeedStatus =
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED";

async function seedScan(
  session: TestSession,
  target: TestTarget,
  status: SeedStatus,
) {
  return prisma.scanJob.create({
    data: {
      targetId: target.id,
      organizationId: session.organizationId,
      status,
      createdById: session.userId,
      startedAt:
        status === "RUNNING" || status === "PAUSED" ? new Date() : null,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });
}

function engage(admin: TestSession, reason = "Scanner is hammering a target") {
  return request(api, admin, "/api/admin/kill-switch/engage", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

function release(admin: TestSession, reason = "Cause fixed") {
  return request(api, admin, "/api/admin/kill-switch/release", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

describe("who may use the kill switch", () => {
  test("a signed-out caller is refused", async () => {
    const res = await fetch(`${api.baseUrl}/api/admin/kill-switch/engage`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("an analyst is refused", async () => {
    const analyst = await createSession("ANALYST");
    const res = await engage(analyst);
    expect(res.status).toBe(403);
  });

  test("an administrator without two-factor authentication is refused, and told why", async () => {
    const admin = await createSession("ADMIN");
    const res = await engage(admin);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("TWO_FACTOR_REQUIRED");
  });

  test("engaging needs a reason", async () => {
    const admin = await createAdminSession();
    const res = await engage(admin, "  ");
    expect(res.status).toBe(400);
  });
});

describe("engaging", () => {
  test("aborts every active scan in every organisation and leaves finished ones alone", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const bob = await createSession("ANALYST");
    const aliceTarget = await createVerifiedTarget(alice.organizationId);
    const bobTarget = await createVerifiedTarget(bob.organizationId);
    const bobOther = await createVerifiedTarget(bob.organizationId);
    const bobThird = await createVerifiedTarget(bob.organizationId);

    const queued = await seedScan(alice, aliceTarget, "QUEUED");
    const running = await seedScan(bob, bobTarget, "RUNNING");
    const paused = await seedScan(bob, bobOther, "PAUSED");
    const completed = await seedScan(bob, bobThird, "COMPLETED");

    const res = await engage(admin);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.killSwitch.engaged).toBe(true);
    expect(body.abortedScans).toBe(3);

    const rows = await prisma.scanJob.findMany({
      select: { id: true, status: true, failureReason: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const scan of [queued, running, paused]) {
      expect(byId.get(scan.id)?.status).toBe("ABORTED_SAFETY");
      expect(byId.get(scan.id)?.failureReason).toContain("kill switch");
    }
    expect(byId.get(completed.id)?.status).toBe("COMPLETED");
  });

  test("records the engagement and one abort per scan, each in that scan's organisation", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const scan = await seedScan(alice, target, "RUNNING");

    await engage(admin, "Runaway scan");

    const engaged = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_KILL_SWITCH_ENGAGED" },
    });
    expect(engaged.userId).toBe(admin.userId);
    expect(engaged.organizationId).toBeNull();
    expect(engaged.metadata).toMatchObject({
      reason: "Runaway scan",
      abortedScans: 1,
    });

    const aborted = await prisma.auditLog.findFirstOrThrow({
      where: { action: "SCAN_ABORTED_SAFETY", resourceId: scan.id },
    });
    expect(aborted.organizationId).toBe(alice.organizationId);
    expect(aborted.userId).toBe(admin.userId);
  });

  test("takes queued jobs off the queue", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const scan = await seedScan(alice, target, "QUEUED");
    await enqueueScan(scan.id, alice.organizationId);

    await engage(admin);

    expect(await queue.getJobCounts("waiting", "delayed")).toMatchObject({
      waiting: 0,
      delayed: 0,
    });
  });

  test("tells live views the scan has stopped", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const scan = await seedScan(alice, target, "RUNNING");

    const subscriber = redisClient();
    const received: unknown[] = [];
    subscriber.on("message", (_channel, payload) =>
      received.push(JSON.parse(payload)),
    );
    await subscriber.subscribe("wvs:scan-events");
    try {
      await engage(admin);
      const deadline = Date.now() + 2_000;
      while (received.length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
    } finally {
      await subscriber.quit();
    }

    expect(received).toContainEqual(
      expect.objectContaining({
        type: "scan.status",
        scanJobId: scan.id,
        status: "ABORTED_SAFETY",
      }),
    );
  });

  test("engaging an engaged switch is refused", async () => {
    const admin = await createAdminSession();
    await engage(admin);
    const res = await engage(admin);
    expect(res.status).toBe(409);
  });
});

describe("while engaged", () => {
  test("no scan can start", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await engage(admin);

    const res = await request(api, alice, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, profile: "PASSIVE" }),
    });

    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("KILL_SWITCH_ENGAGED");
    expect(await prisma.scanJob.count()).toBe(0);
  });

  test("no paused scan can resume", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    // Engage first, then pause a scan behind its back, as a straggler would.
    await engage(admin);
    const scan = await seedScan(alice, target, "PAUSED");

    const res = await request(api, alice, `/api/scans/${scan.id}/resume`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("KILL_SWITCH_ENGAGED");
    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } }))
        .status,
    ).toBe("PAUSED");
  });

  test("the reconciler does not re-deliver lost scans", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await engage(admin);
    await prisma.scanJob.create({
      data: {
        targetId: target.id,
        organizationId: alice.organizationId,
        status: "QUEUED",
        createdById: alice.userId,
        queuedAt: new Date(Date.now() - 5 * 60_000),
      },
    });

    const summary = await reconcileScans();

    expect(summary.requeued).toBe(0);
    expect(await queue.getJobCounts("waiting")).toMatchObject({ waiting: 0 });
  });

  test("every signed-in user can see that it is engaged", async () => {
    const admin = await createAdminSession();
    const viewer = await createSession("VIEWER");
    await engage(admin);

    const res = await request(api, viewer, "/api/system/status");

    expect(res.status).toBe(200);
    expect((await json(res)).killSwitch.engaged).toBe(true);
  });
});

describe("releasing", () => {
  test("lets scans start again and restarts nothing", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const other = await createVerifiedTarget(alice.organizationId);
    const aborted = await seedScan(alice, other, "RUNNING");
    await engage(admin);

    const res = await release(admin);
    expect(res.status).toBe(200);
    expect((await json(res)).killSwitch.engaged).toBe(false);

    const start = await request(api, alice, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, profile: "PASSIVE" }),
    });
    expect(start.status).toBe(202);
    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: aborted.id } }))
        .status,
    ).toBe("ABORTED_SAFETY");
  });

  test("is recorded with its reason", async () => {
    const admin = await createAdminSession();
    await engage(admin);
    await release(admin, "Target owner confirmed it was us");

    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_KILL_SWITCH_DISENGAGED" },
    });
    expect(record.metadata).toMatchObject({
      reason: "Target owner confirmed it was us",
    });
  });

  test("releasing a released switch is refused", async () => {
    const admin = await createAdminSession();
    const res = await release(admin);
    expect(res.status).toBe(409);
  });
});

test("the kill switch state is readable by administrators with who changed it and why", async () => {
  const admin = await createAdminSession();
  await engage(admin, "Investigating");

  const res = await request(api, admin, "/api/admin/kill-switch");

  expect(res.status).toBe(200);
  expect((await json(res)).killSwitch).toMatchObject({
    engaged: true,
    reason: "Investigating",
    changedBy: { id: admin.userId, email: admin.email },
  });
});
