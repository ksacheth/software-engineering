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
  startTestApi,
  TEST_PASSWORD,
  type TestApi,
  type TestSession,
} from "../../test-support/harness";
import { grantAdminFromHost } from "./users";

/**
 * F.8 account administration (ADR-0009): listing accounts across
 * organisations, changing roles, and suspension.
 */

setDefaultTimeout(30_000);

let api: TestApi;

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await resetDatabase();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

function signIn(email: string) {
  return fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
}

function changeRole(admin: TestSession, userId: string, role: string) {
  return request(api, admin, `/api/admin/users/${userId}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

function suspend(admin: TestSession, userId: string, reason = "Abuse report") {
  return request(api, admin, `/api/admin/users/${userId}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

describe("listing accounts", () => {
  test("shows accounts from every organisation with what an operator needs", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");

    const { users } = await json(await request(api, admin, "/api/admin/users"));

    expect(users).toHaveLength(2);
    const row = users.find((u: Json) => u.id === alice.userId);
    expect(row).toMatchObject({
      email: alice.email,
      role: "ANALYST",
      twoFactorEnabled: false,
      suspendedAt: null,
      organization: { id: alice.organizationId },
    });
    expect(typeof row.lastSignInAt).toBe("string");
  });

  test("can be searched by email", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    await createSession("ANALYST");

    const { users } = await json(
      await request(
        api,
        admin,
        `/api/admin/users?q=${encodeURIComponent(alice.email.slice(0, 12))}`,
      ),
    );

    expect(users.map((u: Json) => u.id)).toEqual([alice.userId]);
  });

  test("pages with a cursor", async () => {
    const admin = await createAdminSession();
    await createSession("ANALYST");
    await createSession("ANALYST");

    const first = await json(
      await request(api, admin, "/api/admin/users?limit=2"),
    );
    expect(first.users).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await json(
      await request(
        api,
        admin,
        `/api/admin/users?limit=2&cursor=${first.nextCursor}`,
      ),
    );
    expect(second.users).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe("changing a role", () => {
  test("applies and is audited in the account's organisation", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");

    const res = await changeRole(admin, alice.userId, "VIEWER");

    expect(res.status).toBe(200);
    expect((await json(res)).user.role).toBe("VIEWER");
    const me = await json(await request(api, alice, "/api/me"));
    expect(me.user.role).toBe("VIEWER");

    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_USER_ROLE_CHANGED" },
    });
    expect(record).toMatchObject({
      userId: admin.userId,
      organizationId: alice.organizationId,
      resourceId: alice.userId,
    });
    expect(record.metadata).toMatchObject({ from: "ANALYST", to: "VIEWER" });
  });

  test("an administrator cannot change their own role", async () => {
    // Refusing every change to oneself is also what guarantees at least one
    // administrator survives: the caller is always one.
    const admin = await createAdminSession();
    const res = await changeRole(admin, admin.userId, "ANALYST");
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("CANNOT_CHANGE_SELF");
  });

  test("an unknown role is refused", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    const res = await changeRole(admin, alice.userId, "OWNER");
    expect(res.status).toBe(400);
  });

  test("an unknown account is not found", async () => {
    const admin = await createAdminSession();
    const res = await changeRole(admin, "nope", "VIEWER");
    expect(res.status).toBe(404);
  });
});

describe("suspension", () => {
  test("ends the account's sessions and blocks signing in again", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");

    const res = await suspend(admin, alice.userId);

    expect(res.status).toBe(200);
    expect((await json(res)).user.suspendedAt).toBeTruthy();
    expect((await request(api, alice, "/api/me")).status).toBe(401);
    const attempt = await signIn(alice.email);
    expect(attempt.status).toBe(403);
    expect(attempt.headers.get("set-cookie") ?? "").not.toContain("session");
  });

  test("is audited with its reason", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");

    await suspend(admin, alice.userId, "Scanning targets it does not own");

    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_USER_SUSPENDED" },
    });
    expect(record.organizationId).toBe(alice.organizationId);
    expect(record.metadata).toMatchObject({
      reason: "Scanning targets it does not own",
    });
  });

  test("can be lifted, after which the account can sign in", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    await suspend(admin, alice.userId);

    const res = await request(
      api,
      admin,
      `/api/admin/users/${alice.userId}/unsuspend`,
      { method: "POST", body: JSON.stringify({ reason: "Resolved" }) },
    );

    expect(res.status).toBe(200);
    expect((await json(res)).user.suspendedAt).toBeNull();
    expect((await signIn(alice.email)).status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { action: "ADMIN_USER_UNSUSPENDED" },
      }),
    ).toBe(1);
  });

  test("an administrator cannot suspend themselves", async () => {
    const admin = await createAdminSession();
    const res = await suspend(admin, admin.userId);
    expect(res.status).toBe(409);
  });

  test("suspending a suspended account is refused", async () => {
    const admin = await createAdminSession();
    const alice = await createSession("ANALYST");
    await suspend(admin, alice.userId);
    expect((await suspend(admin, alice.userId)).status).toBe(409);
  });
});

describe("granting the first administrator from the deployment host", () => {
  test("promotes a verified account and records it as the host's doing", async () => {
    const alice = await createSession("ANALYST");

    const result = await grantAdminFromHost(alice.email);

    expect(result).toEqual({ ok: true, userId: alice.userId });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } }))
        .role,
    ).toBe("ADMIN");
    const record = await prisma.auditLog.findFirstOrThrow({
      where: { action: "ADMIN_ROLE_GRANTED" },
    });
    expect(record).toMatchObject({
      userId: null,
      organizationId: alice.organizationId,
      resourceId: alice.userId,
    });
    expect(record.metadata).toMatchObject({ source: "cli", from: "ANALYST" });
  });

  test("refuses an address nobody has confirmed", async () => {
    const alice = await createSession("ANALYST");
    await prisma.user.update({
      where: { id: alice.userId },
      data: { emailVerified: false },
    });

    expect(await grantAdminFromHost(alice.email)).toEqual({
      ok: false,
      reason: "EMAIL_NOT_VERIFIED",
    });
  });

  test("refuses an address with no account", async () => {
    expect(await grantAdminFromHost("nobody@example.test")).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  test("refuses a suspended account", async () => {
    const alice = await createSession("ANALYST");
    await prisma.user.update({
      where: { id: alice.userId },
      data: { suspendedAt: new Date() },
    });
    expect(await grantAdminFromHost(alice.email)).toEqual({
      ok: false,
      reason: "SUSPENDED",
    });
  });

  test("does nothing to an account that is already an administrator", async () => {
    const admin = await createAdminSession();
    expect(await grantAdminFromHost(admin.email)).toEqual({
      ok: false,
      reason: "ALREADY_ADMIN",
    });
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
