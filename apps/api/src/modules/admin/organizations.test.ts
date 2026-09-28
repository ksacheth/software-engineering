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
  request,
  resetDatabase,
  scanQueue,
  startTestApi,
  type TestApi,
  type TestSession,
} from "../../test-support/harness";

/**
 * F.8 quotas: an administrator sets an organisation's concurrent-scan limit
 * and the fastest request rate its scans may use, and F.3 enforces both.
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

function setQuota(
  admin: TestSession,
  organizationId: string,
  quota: Record<string, unknown>,
) {
  return request(api, admin, `/api/admin/organizations/${organizationId}/quota`, {
    method: "PATCH",
    body: JSON.stringify(quota),
  });
}

function startScan(
  session: TestSession,
  targetId: string,
  configuration?: Record<string, unknown>,
) {
  return request(api, session, "/api/scans", {
    method: "POST",
    body: JSON.stringify({ targetId, profile: "STANDARD", configuration }),
  });
}

describe("listing organisations", () => {
  test("shows every organisation with its quota, members and active scans", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await prisma.scanJob.create({
      data: {
        targetId: target.id,
        organizationId: alice.organizationId,
        status: "RUNNING",
      },
    });

    const { organizations } = await json(
      await request(api, admin, "/api/admin/organizations"),
    );

    const row = organizations.find((o: Json) => o.id === alice.organizationId);
    expect(row).toMatchObject({
      maxConcurrentScans: 2,
      scanRateLimit: 10,
      memberCount: 1,
      activeScans: 1,
    });
    expect(organizations).toHaveLength(2);
  });
});

describe("changing a quota", () => {
  test("is applied and audited in that organisation's trail", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");

    const res = await setQuota(admin, alice.organizationId, {
      maxConcurrentScans: 5,
      scanRateLimit: 4,
    });

    expect(res.status).toBe(200);
    expect((await json(res)).organization).toMatchObject({
      maxConcurrentScans: 5,
      scanRateLimit: 4,
    });
    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_QUOTA_CHANGED" },
    });
    expect(record.organizationId).toBe(alice.organizationId);
    expect(record.userId).toBe(admin.userId);
    expect(record.metadata).toMatchObject({
      before: { maxConcurrentScans: 2, scanRateLimit: 10 },
      after: { maxConcurrentScans: 5, scanRateLimit: 4 },
    });
  });

  test("the request rate cannot be raised above the 10 per second F.8 sets", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const res = await setQuota(admin, alice.organizationId, {
      scanRateLimit: 11,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).errors[0].pointer).toBe("/scanRateLimit");
  });

  test("the concurrent limit is bounded", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    expect(
      (await setQuota(admin, alice.organizationId, { maxConcurrentScans: 21 }))
        .status,
    ).toBe(400);
    expect(
      (await setQuota(admin, alice.organizationId, { maxConcurrentScans: -1 }))
        .status,
    ).toBe(400);
  });

  test("an unknown organisation is not found", async () => {
    const admin = await createAdminSession();
    const res = await setQuota(admin, "nope", { maxConcurrentScans: 3 });
    expect(res.status).toBe(404);
  });
});

describe("what a quota does to scans", () => {
  test("a limit of zero suspends the organisation's scanning", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await setQuota(admin, alice.organizationId, { maxConcurrentScans: 0 });

    const res = await startScan(alice, target.id);

    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("ORG_SCANNING_SUSPENDED");
  });

  test("lowering the limit below what is running stops nothing", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const running = await prisma.scanJob.create({
      data: {
        targetId: target.id,
        organizationId: alice.organizationId,
        status: "RUNNING",
      },
    });

    await setQuota(admin, alice.organizationId, { maxConcurrentScans: 0 });

    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: running.id } }))
        .status,
    ).toBe("RUNNING");
  });

  test("a scan asking for a faster rate than the quota allows is refused", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await setQuota(admin, alice.organizationId, { scanRateLimit: 5 });

    const res = await startScan(alice, target.id, { rateLimit: 8 });

    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe("RATE_LIMIT_ABOVE_QUOTA");
    expect(body.errors[0].pointer).toBe("/configuration/rateLimit");
    expect(await prisma.scanJob.count()).toBe(0);
  });

  test("a scan that did not ask for a rate runs at the quota instead of the profile's", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await setQuota(admin, alice.organizationId, { scanRateLimit: 5 });

    const res = await startScan(alice, target.id);

    expect(res.status).toBe(202);
    const row = await prisma.scanJob.findFirstOrThrow();
    expect(row.rateLimit).toBe(5);
  });
});
