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
  prepareDatabase,
  prisma,
  request,
  resetDatabase,
  scanQueue,
  startTestApi,
  type TestApi,
} from "../../test-support/harness";

/**
 * F.8 "should": filtered audit review and a health view, both for
 * administrators only.
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

async function seedAudit(
  action: "TARGET_CREATED" | "SCAN_QUEUED" | "AUTH_LOGIN",
  over: {
    organizationId?: string | null;
    userId?: string | null;
    resourceType?: string;
    resourceId?: string;
    timestamp?: Date;
  } = {},
) {
  return prisma.auditLog.create({
    data: {
      action,
      organizationId: over.organizationId ?? null,
      userId: over.userId ?? null,
      resourceType: over.resourceType ?? "target",
      resourceId: over.resourceId,
      timestamp: over.timestamp,
    },
  });
}

describe("audit review", () => {
  test("lists records newest first, naming the actor and the organisation", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    await seedAudit("TARGET_CREATED", {
      organizationId: alice.organizationId,
      userId: alice.userId,
      timestamp: new Date("2026-09-01T00:00:00Z"),
    });
    await seedAudit("SCAN_QUEUED", {
      organizationId: alice.organizationId,
      userId: alice.userId,
      timestamp: new Date("2026-09-02T00:00:00Z"),
    });

    const { entries } = await json(await request(api, admin, "/api/admin/audit"));

    expect(entries.map((e: Json) => e.action)).toEqual([
      "SCAN_QUEUED",
      "TARGET_CREATED",
    ]);
    expect(entries[0].user).toMatchObject({ id: alice.userId, email: alice.email });
    expect(entries[0].organization).toMatchObject({ id: alice.organizationId });
  });

  test("still shows a record whose user has since been deleted", async () => {
    // ADR-0002: the trail outlives what it audits.
    const admin = await createAdminSession();
    await seedAudit("TARGET_CREATED", { userId: "deleted-user" });

    const { entries } = await json(await request(api, admin, "/api/admin/audit"));

    expect(entries[0]).toMatchObject({ userId: "deleted-user", user: null });
  });

  test("filters by action, organisation, user and resource", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const bob = await createSession("ANALYST");
    await seedAudit("TARGET_CREATED", {
      organizationId: alice.organizationId,
      userId: alice.userId,
      resourceId: "t1",
    });
    await seedAudit("SCAN_QUEUED", {
      organizationId: alice.organizationId,
      userId: alice.userId,
      resourceType: "scan",
      resourceId: "s1",
    });
    await seedAudit("TARGET_CREATED", {
      organizationId: bob.organizationId,
      userId: bob.userId,
      resourceId: "t2",
    });

    const query = async (qs: string) =>
      (await json(await request(api, admin, `/api/admin/audit?${qs}`))).entries.map(
        (e: Json) => e.resourceId,
      );

    expect(await query("action=TARGET_CREATED")).toEqual(
      expect.arrayContaining(["t1", "t2"]),
    );
    expect(await query(`organizationId=${alice.organizationId}`)).toEqual(
      expect.arrayContaining(["t1", "s1"]),
    );
    expect(await query(`userId=${bob.userId}`)).toEqual(["t2"]);
    expect(await query("resourceType=scan")).toEqual(["s1"]);
    expect(await query("resourceId=t1")).toEqual(["t1"]);
  });

  test("filters by time range, inclusive of both ends", async () => {
    const admin = await createAdminSession();
    for (const day of ["01", "02", "03"]) {
      await seedAudit("TARGET_CREATED", {
        resourceId: day,
        timestamp: new Date(`2026-09-${day}T00:00:00Z`),
      });
    }

    const { entries } = await json(
      await request(
        api,
        admin,
        "/api/admin/audit?resourceType=target&from=2026-09-02T00:00:00Z&to=2026-09-03T00:00:00Z",
      ),
    );

    expect(entries.map((e: Json) => e.resourceId)).toEqual(["03", "02"]);
  });

  test("pages with a cursor, without repeating or skipping records that share a timestamp", async () => {
    const admin = await createAdminSession();
    const at = new Date("2026-09-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      await seedAudit("TARGET_CREATED", { resourceId: `r${i}`, timestamp: at });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = await json(
        await request(
          api,
          admin,
          `/api/admin/audit?resourceType=target&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        ),
      );
      seen.push(...page.entries.map((e: Json) => e.resourceId));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  test("an unknown action is a validation error, not an empty result", async () => {
    const admin = await createAdminSession();
    const res = await request(api, admin, "/api/admin/audit?action=NOPE");
    expect(res.status).toBe(400);
  });

  test("an analyst cannot read it", async () => {
    const analyst = await createSession("ANALYST");
    const res = await request(api, analyst, "/api/admin/audit");
    expect(res.status).toBe(403);
  });
});

describe("health", () => {
  test("reports the database, Redis, the queue, active scans and the kill switch", async () => {
    const admin = await createAdminSession();

    const res = await request(api, admin, "/api/admin/health");

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.database).toEqual({ ok: true });
    expect(body.redis).toEqual({ ok: true });
    expect(body.queue).toMatchObject({ waiting: 0, active: 0 });
    expect(body.scans).toMatchObject({ QUEUED: 0, RUNNING: 0, PAUSED: 0 });
    expect(body.killSwitch).toEqual({ engaged: false });
    // Signing the administrator up queued a verification email that the test
    // environment cannot deliver, so the outbox is honestly not empty.
    expect(body.email).toMatchObject({
      pending: expect.any(Number),
      deadLettered: 0,
    });
  });

  test("the public liveness probe reveals nothing but that the process is up", async () => {
    const res = await fetch(`${api.baseUrl}/api/health`);
    expect(Object.keys(await json(res)).sort()).toEqual(["status", "timestamp"]);
  });
});
