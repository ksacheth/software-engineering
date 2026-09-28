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
import { reconcileScans } from "../scans/scan-reconciler";

/**
 * F.8 network blocklist: administering it, and what it does to scans of
 * targets that were verified before an entry matched them. Registration and
 * verification refusals live with the F.2 suite, which owns the DNS stand-in.
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

function create(admin: TestSession, body: Record<string, unknown>) {
  return request(api, admin, "/api/admin/blocklist", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("administering entries", () => {
  test("an entry is stored in the form it will be matched in, and audited", async () => {
    const admin = await createAdminSession();

    const res = await create(admin, {
      patternType: "CIDR",
      pattern: "10.1.2.3/8",
      reason: "Partner network",
    });

    expect(res.status).toBe(201);
    const { entry } = await json(res);
    expect(entry).toMatchObject({
      patternType: "CIDR",
      pattern: "10.0.0.0/8",
      reason: "Partner network",
      isActive: true,
    });

    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_BLOCKLIST_CREATED", resourceId: entry.id },
    });
    expect(record.organizationId).toBeNull();
    expect(record.metadata).toMatchObject({ pattern: "10.0.0.0/8" });
  });

  test("regular expressions are not accepted", async () => {
    const admin = await createAdminSession();
    const res = await create(admin, {
      patternType: "REGEX",
      pattern: ".*",
      reason: "Everything",
    });
    expect(res.status).toBe(400);
    expect(await prisma.networkBlocklist.count()).toBe(0);
  });

  test("a malformed pattern is refused with the field that is wrong", async () => {
    const admin = await createAdminSession();
    const res = await create(admin, {
      patternType: "IP_RANGE",
      pattern: "10.0.0.9-10.0.0.1",
      reason: "Backwards",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).errors[0].pointer).toBe("/pattern");
  });

  test("an entry needs a reason", async () => {
    const admin = await createAdminSession();
    const res = await create(admin, {
      patternType: "HOST_SUFFIX",
      pattern: "gov.example",
    });
    expect(res.status).toBe(400);
  });

  test("entries are listed with who added them", async () => {
    const admin = await createAdminSession();
    await create(admin, {
      patternType: "HOST_SUFFIX",
      pattern: "gov.example",
      reason: "Government",
    });

    const { entries } = await json(
      await request(api, admin, "/api/admin/blocklist"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].createdBy).toMatchObject({ email: admin.email });
  });

  test("an entry can be deactivated and its reason edited, and both are audited", async () => {
    const admin = await createAdminSession();
    const { entry } = await json(
      await create(admin, {
        patternType: "HOST_SUFFIX",
        pattern: "gov.example",
        reason: "Government",
      }),
    );

    const res = await request(api, admin, `/api/admin/blocklist/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: false, reason: "Lifted by legal" }),
    });

    expect(res.status).toBe(200);
    expect((await json(res)).entry).toMatchObject({
      isActive: false,
      reason: "Lifted by legal",
    });
    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_BLOCKLIST_UPDATED", resourceId: entry.id },
    });
    expect(record.metadata).toMatchObject({
      before: { isActive: true, reason: "Government" },
      after: { isActive: false, reason: "Lifted by legal" },
    });
  });

  test("an entry's pattern cannot be edited in place", async () => {
    const admin = await createAdminSession();
    const { entry } = await json(
      await create(admin, {
        patternType: "HOST_SUFFIX",
        pattern: "gov.example",
        reason: "Government",
      }),
    );

    const res = await request(api, admin, `/api/admin/blocklist/${entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ pattern: "mil.example" }),
    });

    expect(res.status).toBe(400);
  });

  test("an entry can be deleted, and the audit log keeps what it was", async () => {
    const admin = await createAdminSession();
    const { entry } = await json(
      await create(admin, {
        patternType: "HOST_SUFFIX",
        pattern: "gov.example",
        reason: "Government",
      }),
    );

    const res = await request(api, admin, `/api/admin/blocklist/${entry.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(await prisma.networkBlocklist.count()).toBe(0);
    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_BLOCKLIST_DELETED", resourceId: entry.id },
    });
    expect(record.metadata).toMatchObject({
      patternType: "HOST_SUFFIX",
      pattern: "gov.example",
    });
  });

  test("an unknown entry is not found", async () => {
    const admin = await createAdminSession();
    const res = await request(api, admin, "/api/admin/blocklist/nope", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("scans of a target blocked after it was verified", () => {
  test("cannot start", async () => {
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await prisma.networkBlocklist.create({
      data: { patternType: "CIDR", pattern: "93.184.216.0/24", reason: "x" },
    });

    const res = await request(api, alice, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, profile: "PASSIVE" }),
    });

    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe("BLOCKLISTED");
  });

  test("cannot resume", async () => {
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const scan = await prisma.scanJob.create({
      data: {
        targetId: target.id,
        organizationId: alice.organizationId,
        status: "PAUSED",
        createdById: alice.userId,
        startedAt: new Date(),
      },
    });
    await prisma.networkBlocklist.create({
      data: { patternType: "HOST_SUFFIX", pattern: "example.test", reason: "x" },
    });

    const res = await request(api, alice, `/api/scans/${scan.id}/resume`, {
      method: "POST",
    });

    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe("BLOCKLISTED");
  });

  test("are not re-delivered by the reconciler", async () => {
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    const scan = await prisma.scanJob.create({
      data: {
        targetId: target.id,
        organizationId: alice.organizationId,
        status: "QUEUED",
        createdById: alice.userId,
        queuedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await prisma.networkBlocklist.create({
      data: { patternType: "HOST_SUFFIX", pattern: "example.test", reason: "x" },
    });

    const summary = await reconcileScans();

    expect(summary.refused).toBe(1);
    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } }))
        .status,
    ).toBe("FAILED");
  });

  test("an inactive entry does not stop a scan", async () => {
    const alice = await createSession("ANALYST");
    const target = await createVerifiedTarget(alice.organizationId);
    await prisma.networkBlocklist.create({
      data: {
        patternType: "CIDR",
        pattern: "93.184.216.0/24",
        reason: "x",
        isActive: false,
      },
    });

    const res = await request(api, alice, "/api/scans", {
      method: "POST",
      body: JSON.stringify({ targetId: target.id, profile: "PASSIVE" }),
    });

    expect(res.status).toBe(202);
  });
});
