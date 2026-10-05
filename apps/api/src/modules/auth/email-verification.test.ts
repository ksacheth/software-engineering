import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { EMAIL_VERIFICATION_CODE } from "@wvs/shared";
import {
  prepareDatabase,
  prisma,
  resetDatabase,
  startTestApi,
  TEST_PASSWORD,
  type TestApi,
} from "../../test-support/harness";

/**
 * F.1 registration with email confirmation, by one-time code (ADR-0013).
 *
 * Codes are created through Better Auth's server-only endpoint, because the
 * one sign-up sends is only ever in the email. Each test calls from its own
 * address (X-Forwarded-For through the trusted loopback proxy), so the
 * per-route rate limits of one test cannot refuse the next.
 */

setDefaultTimeout(30_000);

const ORIGIN = "http://localhost:3000";

let api: TestApi;
let auth: (typeof import("../../lib/auth"))["auth"];

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
  ({ auth } = await import("../../lib/auth"));
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await resetDatabase();
});

let clientCounter = 0;

/** A caller with an address of its own, for the rate limiter. */
function client() {
  clientCounter += 1;
  const address = `203.0.113.${clientCounter}`;
  return (path: string, body: unknown) =>
    fetch(`${api.baseUrl}/api/auth${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-Forwarded-For": address,
      },
      body: JSON.stringify(body),
    });
}

async function signUp(post: ReturnType<typeof client>): Promise<string> {
  const email = `${randomUUID()}@example.test`;
  const res = await post("/sign-up/email", {
    email,
    password: TEST_PASSWORD,
    name: "Code Tester",
  });
  expect(res.status).toBe(200);
  return email;
}

async function issueCode(email: string): Promise<string> {
  return auth.api.createVerificationOTP({
    body: { email, type: "email-verification" },
  });
}

async function isVerified(email: string): Promise<boolean> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return user.emailVerified;
}

describe("email confirmation by code", () => {
  test("sign-up stores only a hash of the code it sends", async () => {
    const email = await signUp(client());

    const row = await prisma.verification.findFirstOrThrow({
      where: { identifier: `email-verification-otp-${email}` },
    });
    const [stored] = row.value.split(":");
    expect(stored).not.toMatch(
      new RegExp(`^\\d{${EMAIL_VERIFICATION_CODE.length}}$`),
    );
    expect(await isVerified(email)).toBe(false);
  });

  test("the right code confirms the address, and the password then signs in", async () => {
    const post = client();
    const email = await signUp(post);

    const blocked = await post("/sign-in/email", { email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(403);

    const code = await issueCode(email);
    expect(code).toMatch(new RegExp(`^\\d{${EMAIL_VERIFICATION_CODE.length}}$`));
    const verified = await post("/email-otp/verify-email", { email, otp: code });
    expect(verified.status).toBe(200);
    // No session from the code alone: the password is still required.
    expect(verified.headers.get("set-cookie")).toBeNull();
    expect(await isVerified(email)).toBe(true);

    const signedIn = await post("/sign-in/email", { email, password: TEST_PASSWORD });
    expect(signedIn.status).toBe(200);
  });

  test("a wrong code is refused, and the code dies after the allowed attempts", async () => {
    const email = await signUp(client());
    const code = await issueCode(email);
    const wrong = code === "000000" ? "111111" : "000000";

    // A fresh address per attempt keeps the rate limiter out of the way, so
    // the attempt counter is what refuses the right code at the end.
    for (let attempt = 0; attempt < EMAIL_VERIFICATION_CODE.allowedAttempts; attempt += 1) {
      const res = await client()("/email-otp/verify-email", { email, otp: wrong });
      expect(res.status).toBe(400);
    }
    const late = await client()("/email-otp/verify-email", { email, otp: code });
    expect(late.status).not.toBe(200);
    expect(await isVerified(email)).toBe(false);
  });

  test("signing in to an unconfirmed account issues a fresh code", async () => {
    const post = client();
    const email = await signUp(post);
    const identifier = `email-verification-otp-${email}`;
    const first = await prisma.verification.findFirstOrThrow({ where: { identifier } });

    const res = await post("/sign-in/email", { email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);

    const latest = await prisma.verification.findFirstOrThrow({
      where: { identifier },
      orderBy: { createdAt: "desc" },
    });
    expect(latest.id).not.toBe(first.id);
  });

  test.each([
    "/sign-in/email-otp",
    "/email-otp/send-verification-otp",
    "/email-otp/check-verification-otp",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
    "/email-otp/change-email",
  ])("%s is closed", async (path) => {
    const res = await client()(path, {
      email: "someone@example.test",
      otp: "123456",
      type: "sign-in",
    });
    expect(res.status).toBe(404);
  });
});
