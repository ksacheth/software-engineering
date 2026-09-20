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
  createSession,
  prepareDatabase,
  request,
  resetDatabase,
  startTestApi,
  type TestApi,
} from "../../test-support/harness";

/**
 * F.1 identity: the dashboard needs the caller's role to decide which controls
 * to offer, and it must come from the same resolution the authorisation checks
 * use rather than from a client claim.
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

describe("GET /api/me", () => {
  test("returns the session's user, organisation and role", async () => {
    const session = await createSession("ANALYST");

    const res = await request(api, session, "/api/me");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      user: { id: string; organizationId: string; role: string };
    };
    expect(body.user).toEqual({
      id: session.userId,
      organizationId: session.organizationId,
      role: "ANALYST",
    });
  });

  test("reports a viewer as a viewer, so the client can hide write controls", async () => {
    const session = await createSession("VIEWER");

    const body = (await (await request(api, session, "/api/me")).json()) as {
      user: { role: string };
    };
    expect(body.user.role).toBe("VIEWER");
  });

  test("refuses an unauthenticated caller", async () => {
    const res = await fetch(`${api.baseUrl}/api/me`);
    expect(res.status).toBe(401);
  });
});
