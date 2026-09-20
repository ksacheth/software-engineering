import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createSession,
  prepareDatabase,
  prisma,
  request,
  resetDatabase,
  startTestApi,
  type TestApi,
  type TestSession,
} from "../../test-support/harness";

/**
 * F.2 target management and ownership verification, through the running API.
 *
 * C.2 says scanning is permitted only against targets whose ownership is
 * verified, with no option to disable the check. Everything downstream trusts
 * that; this module is where the trust is established, so the tests care less
 * about the happy path than about the ways a target could reach VERIFIED
 * without deserving it, or reach it pointing somewhere it must never point.
 *
 * DNS is the one thing replaced. A test may not depend on a public zone, and
 * refusal cases need a hostname that resolves to a private or metadata address,
 * which no registrar will sell. Everything else is real: the database, Redis,
 * the session middleware, the rate limiter and, for the well-known challenge, a
 * genuine HTTP server.
 */

setDefaultTimeout(30_000);

const realDns = await import("node:dns");

interface ZoneEntry {
  a?: string[];
  aaaa?: string[];
  txt?: string[][];
  /** Make every lookup for this name fail with a code, e.g. SERVFAIL. */
  error?: string;
}

const zone = new Map<string, ZoneEntry>();

function dnsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`query ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** An absent name is NXDOMAIN; a present name missing that family is ENODATA. */
function answer(name: string, family: "a" | "aaaa" | "txt") {
  const entry = zone.get(name);
  if (!entry) throw dnsError("ENOTFOUND");
  if (entry.error) throw dnsError(entry.error);
  const records = entry[family];
  if (!records) throw dnsError("ENODATA");
  return records;
}

mock.module("node:dns", () => ({
  ...realDns,
  promises: {
    ...realDns.promises,
    resolve4: async (name: string) => answer(name, "a") as string[],
    resolve6: async (name: string) => answer(name, "aaaa") as string[],
    resolveTxt: async (name: string) => answer(name, "txt") as string[][],
  },
}));

/** A public address, so the origin gate has no reason to refuse it. */
const PUBLIC_IPV4 = "93.184.216.34";
const PUBLIC_IPV6 = "2606:2800:220:1:248:1893:25c8:1946";
const TXT_PREFIX = "_wvs-verification";

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
  zone.clear();
});

/** Give a hostname addresses, as a registrar and a resolver would. */
function publish(hostname: string, entry: ZoneEntry): void {
  zone.set(hostname, { a: [PUBLIC_IPV4], ...entry });
}

/** Publish the TXT record the DNS challenge looks for. */
function publishToken(hostname: string, token: string): void {
  zone.set(`${TXT_PREFIX}.${hostname}`, { txt: [[token]] });
}

function uniqueHost(): string {
  return `t-${randomUUID().slice(0, 8)}.example.test`;
}

interface Registered {
  id: string;
  origin: string;
  hostname: string;
  verificationToken: string;
}

/** Register a resolvable target and return it with its token. */
async function register(
  session: TestSession,
  overrides: Record<string, unknown> = {},
  hostname = uniqueHost(),
): Promise<Registered> {
  publish(hostname, {});

  const response = await request(api, session, "/api/targets", {
    method: "POST",
    body: JSON.stringify({
      origin: `https://${hostname}`,
      label: "Test target",
      authorisationAck: true,
      ...overrides,
    }),
  });

  expect(response.status).toBe(201);
  const { target } = (await readBody(response)) as {
    target: { id: string; origin: string; verificationToken: string };
  };

  return {
    id: target.id,
    origin: target.origin,
    hostname,
    verificationToken: target.verificationToken,
  };
}

/**
 * A response body, untyped on purpose: these are wire shapes asserted field by
 * field, and mirroring them in an interface would only test the mirror.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(response: Response): Promise<any> {
  return response.json();
}

async function auditActions(resourceId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { resourceId },
    orderBy: { timestamp: "asc" },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

// ------------------------------------------------------------------ access ---

describe("access control", () => {
  test("refuses a request with no session", async () => {
    const response = await fetch(`${api.baseUrl}/api/targets`);
    expect(response.status).toBe(401);
  });

  test("lets a VIEWER read targets", async () => {
    const viewer = await createSession("VIEWER");
    const response = await request(api, viewer, "/api/targets");
    expect(response.status).toBe(200);
  });

  test("stops a VIEWER changing anything", async () => {
    // VIEWER is read-only by definition (SRS §2.1 personas). The guard is
    // applied by HTTP method rather than per route, so every mutation is
    // covered here, including any added later.
    const analyst = await createSession("ANALYST");
    const target = await register(analyst);

    const viewer = await createSession("VIEWER");
    // Same organisation, so a 403 is genuinely the role talking and not the
    // tenant boundary returning 404.
    await prisma.member.updateMany({
      where: { userId: viewer.userId },
      data: { organizationId: analyst.organizationId },
    });

    const mutations: Array<[string, string, string | undefined]> = [
      ["POST", "/api/targets", JSON.stringify({ origin: "https://x.test" })],
      ["POST", `/api/targets/${target.id}/verify`, undefined],
      [
        "PATCH",
        `/api/targets/${target.id}/scope`,
        JSON.stringify({ includedPaths: [] }),
      ],
      ["POST", `/api/targets/${target.id}/archive`, undefined],
      ["DELETE", `/api/targets/${target.id}`, undefined],
    ];

    for (const [method, path, body] of mutations) {
      const response = await request(api, viewer, path, { method, body });
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 403`,
      );
    }

    // Nothing moved.
    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.isArchived).toBe(false);
    expect(row.verificationStatus).toBe("PENDING");
  });

  test("keeps every route inside the caller's organisation", async () => {
    // NFR-SEC-2. The organisation comes from the session, never the request, so
    // the boundary is one property of the whole module rather than a check each
    // route has to remember. An ADMIN elsewhere is the hardest case: a high
    // privilege that must buy nothing here.
    const owner = await createSession("ANALYST");
    const target = await register(owner);
    publishToken(target.hostname, target.verificationToken);

    const stranger = await createSession("ADMIN");
    const routes: Array<[string, string, string | undefined]> = [
      ["GET", `/api/targets/${target.id}`, undefined],
      ["POST", `/api/targets/${target.id}/verify`, undefined],
      [
        "PATCH",
        `/api/targets/${target.id}/scope`,
        JSON.stringify({ includedPaths: ["/x"], excludedPaths: [] }),
      ],
      ["POST", `/api/targets/${target.id}/archive`, undefined],
      ["DELETE", `/api/targets/${target.id}`, undefined],
    ];

    for (const [method, path, requestBody] of routes) {
      const response = await request(api, stranger, path, {
        method,
        body: requestBody,
      });
      // 404 rather than 403: a stranger should not learn that this id exists.
      expect(`${method} ${path} -> ${response.status}`).toBe(
        `${method} ${path} -> 404`,
      );
    }

    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.verificationStatus).toBe("PENDING");
    expect(row.isArchived).toBe(false);

    // The stranger's own list is unaffected by the target existing at all.
    const listed = await readBody(await request(api, stranger, "/api/targets"));
    expect(listed.targets).toHaveLength(0);
  });

  for (const role of ["ADMIN", "ANALYST", "DEVELOPER"] as const) {
    test(`lets a ${role} register a target`, async () => {
      const session = await createSession(role);
      const target = await register(session);
      expect(target.id).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------- register ---

describe("registering a target", () => {
  test("starts it unverified, with instructions for proving ownership", async () => {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `https://${hostname}`,
        label: "Corporate site",
        authorisationAck: true,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await readBody(response)) as any;

    expect(body.target.verificationStatus).toBe("PENDING");
    expect(body.target.verifiedIpRanges).toEqual([]);
    expect(body.target.authorisationAck).toBe(true);
    expect(body.target.authorisationAckById).toBe(session.userId);
    expect(body.instructions).toEqual({
      method: "DNS_TXT",
      recordName: `${TXT_PREFIX}.${hostname}`,
      recordType: "TXT",
      recordValue: body.target.verificationToken,
    });
    expect(await auditActions(body.target.id)).toEqual(["TARGET_CREATED"]);
  });

  test("gives well-known instructions when that method is chosen", async () => {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `https://${hostname}`,
        label: "Site",
        authorisationAck: true,
        verificationMethod: "WELL_KNOWN",
      }),
    });

    const body = (await readBody(response)) as any;
    expect(body.instructions.method).toBe("WELL_KNOWN");
    expect(body.instructions.url).toBe(
      `https://${hostname}/.well-known/wvs-verification.txt`,
    );
  });

  test("canonicalises the origin before storing it", async () => {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `HTTPS://${hostname.toUpperCase()}:443/`,
        label: "Site",
        authorisationAck: true,
      }),
    });

    const body = (await readBody(response)) as any;
    expect(body.target.origin).toBe(`https://${hostname}`);
  });

  test("requires the authorisation acknowledgement", async () => {
    // F.2: the attestation is a precondition of the target existing, not a flag
    // to be set afterwards. A target registered without it would be a target
    // nobody ever claimed to be allowed to scan.
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    for (const ack of [undefined, false, "true", 1]) {
      const response = await request(api, session, "/api/targets", {
        method: "POST",
        body: JSON.stringify({
          origin: `https://${hostname}`,
          label: "Site",
          authorisationAck: ack,
        }),
      });
      expect(response.status).toBe(400);
    }

    expect(await prisma.target.count()).toBe(0);
  });

  test("requires an origin and a label", async () => {
    const session = await createSession("ANALYST");

    const bodies = [
      {},
      { origin: "https://a.example.test" },
      { label: "No origin" },
      { origin: "https://a.example.test", label: "   " },
      { origin: 42, label: "Not a string" },
    ];

    for (const body of bodies) {
      const response = await request(api, session, "/api/targets", {
        method: "POST",
        body: JSON.stringify({ ...body, authorisationAck: true }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("rejects an unknown verification method", async () => {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `https://${hostname}`,
        label: "Site",
        authorisationAck: true,
        verificationMethod: "EMAIL",
      }),
    });

    expect(response.status).toBe(400);
  });

  test("defaults the scope to empty and accepts absolute paths", async () => {
    const session = await createSession("ANALYST");
    const plain = await register(session);
    expect(
      (await prisma.target.findUniqueOrThrow({ where: { id: plain.id } }))
        .includedPaths,
    ).toEqual([]);

    const scoped = await register(session, {
      includedPaths: ["/app", "  /api/v1  "],
      excludedPaths: ["/logout"],
    });
    const row = await prisma.target.findUniqueOrThrow({
      where: { id: scoped.id },
    });
    expect(row.includedPaths).toEqual(["/app", "/api/v1"]);
    expect(row.excludedPaths).toEqual(["/logout"]);
  });

  test("rejects a scope that is not a list of absolute paths", async () => {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    publish(hostname, {});

    const scopes = [
      { includedPaths: "/app" },
      { includedPaths: ["app"] },
      { includedPaths: [42] },
      { includedPaths: [`/${"x".repeat(600)}`] },
      { excludedPaths: ["../etc"] },
    ];

    for (const scope of scopes) {
      const response = await request(api, session, "/api/targets", {
        method: "POST",
        body: JSON.stringify({
          origin: `https://${hostname}`,
          label: "Site",
          authorisationAck: true,
          ...scope,
        }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("refuses a second registration of the same origin", async () => {
    const session = await createSession("ANALYST");
    const first = await register(session);

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: first.origin,
        label: "Duplicate",
        authorisationAck: true,
      }),
    });

    expect(response.status).toBe(409);
    expect((await readBody(response)).targetId).toBe(first.id);
  });

  test("lets a different organisation register the same origin", async () => {
    // Two customers may legitimately both own a claim on one origin, and each
    // has to prove it separately. Uniqueness is per organisation, not global.
    const first = await createSession("ANALYST");
    const hostname = uniqueHost();
    const mine = await register(first, {}, hostname);

    const second = await createSession("ANALYST");
    publish(hostname, {});
    const response = await request(api, second, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: mine.origin,
        label: "Also mine",
        authorisationAck: true,
      }),
    });

    expect(response.status).toBe(201);
  });
});

// ------------------------------------------------------------------ refusal ---

describe("the address refusal gate at registration", () => {
  /** Register against a hostname with the given records, expecting refusal. */
  async function attempt(entry: ZoneEntry, originOverride?: string) {
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    zone.set(hostname, entry);

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: originOverride ?? `https://${hostname}`,
        label: "Site",
        authorisationAck: true,
      }),
    });

    return { response, body: (await readBody(response)) as any };
  }

  const privateAddresses: [string, string][] = [
    ["127.0.0.1", "LOOPBACK"],
    ["10.1.2.3", "PRIVATE"],
    ["192.168.1.1", "PRIVATE"],
    ["172.16.0.5", "PRIVATE"],
    ["169.254.169.254", "CLOUD_METADATA"],
    ["169.254.1.1", "LINK_LOCAL"],
    ["0.0.0.0", "UNSPECIFIED"],
  ];

  for (const [address, reason] of privateAddresses) {
    test(`refuses a hostname resolving to ${address}`, async () => {
      // This is the SSRF gate. A name is cheap to register and can point
      // anywhere, so the refusal is on the resolved address, not the name.
      const { response, body } = await attempt({ a: [address] });

      expect(response.status).toBe(422);
      expect(body.rule).toMatchObject({ kind: "ADDRESS", reason });
      expect(await prisma.target.count()).toBe(0);
    });
  }

  test("refuses when only one of several addresses is forbidden", async () => {
    // A host with one public A record and one private one is a rebinding
    // primitive: which address a later connection picks is not ours to predict,
    // so any forbidden address in the set refuses the whole name.
    const { response } = await attempt({ a: [PUBLIC_IPV4, "10.0.0.7"] });
    expect(response.status).toBe(422);
    expect(await prisma.target.count()).toBe(0);
  });

  test("refuses when a forbidden address arrives over IPv6", async () => {
    const { response } = await attempt({ a: [PUBLIC_IPV4], aaaa: ["::1"] });
    expect(response.status).toBe(422);
  });

  test("refuses an IP literal, which has no owner to prove anything", async () => {
    const { response, body } = await attempt({}, "https://93.184.216.34");
    expect(response.status).toBe(422);
    expect(body.rule).toMatchObject({
      kind: "ORIGIN",
      problem: "IS_IP_LITERAL",
    });
  });

  test("refuses a hostname that does not resolve", async () => {
    const session = await createSession("ANALYST");
    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `https://${uniqueHost()}`,
        label: "Site",
        authorisationAck: true,
      }),
    });

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toMatchObject({
      kind: "RESOLUTION",
      failure: "NXDOMAIN",
    });
  });

  test("refuses a hostname with no address records", async () => {
    // The name exists but carries no A or AAAA. There is nothing to classify
    // and nothing to record in the verified set, so it cannot be a target.
    const { response, body } = await attempt({ txt: [["unrelated"]] });

    expect(response.status).toBe(422);
    expect(body.rule).toMatchObject({
      kind: "RESOLUTION",
      failure: "NO_ADDRESSES",
    });
  });

  test("refuses when the lookup itself fails", async () => {
    // SERVFAIL is not "no such host": we do not know what this name resolves
    // to, and registering it would mean classifying an address we never saw.
    const { response, body } = await attempt({ error: "SERVFAIL" });

    expect(response.status).toBe(422);
    expect(body.rule).toMatchObject({
      kind: "RESOLUTION",
      failure: "DNS_ERROR",
    });
  });

  test("records a refusal in the audit log", async () => {
    // F.8 wants one record per event, and a refused target is exactly the event
    // an auditor asks about: someone pointed the scanner at an internal address.
    const session = await createSession("ANALYST");
    const hostname = uniqueHost();
    zone.set(hostname, { a: ["169.254.169.254"] });

    await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin: `https://${hostname}`,
        label: "Metadata",
        authorisationAck: true,
      }),
    });

    const rows = await prisma.auditLog.findMany({
      where: { organizationId: session.organizationId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("TARGET_REFUSED");
    expect(rows[0]!.userId).toBe(session.userId);
    expect((rows[0]!.metadata as any).refusal.reason).toBe("CLOUD_METADATA");
  });

  test("names the rule that refused, so the message is actionable", async () => {
    const { body } = await attempt({ a: ["10.0.0.1"] });
    expect(body.error).toContain("private");
  });
});

// -------------------------------------------------------------------- read ---

describe("reading targets", () => {
  test("never returns the verification token in a list", async () => {
    // The token is the proof of ownership. A list view is the widest-read
    // endpoint here, and leaking the token there would let any member of the
    // organisation publish it for a target they did not register.
    const session = await createSession("ANALYST");
    await register(session);

    const body = (await (
      await request(api, session, "/api/targets")
    ).json()) as any;

    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].verificationToken).toBeUndefined();
  });

  test("hides archived targets unless they are asked for", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    await request(api, session, `/api/targets/${target.id}/archive`, {
      method: "POST",
    });

    const listed = (await (
      await request(api, session, "/api/targets")
    ).json()) as any;
    expect(listed.targets).toHaveLength(0);

    const all = (await (
      await request(api, session, "/api/targets?includeArchived=true")
    ).json()) as any;
    expect(all.targets).toHaveLength(1);
  });

  test("returns the scannable verdict alongside the target", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);

    const body = (await (
      await request(api, session, `/api/targets/${target.id}`)
    ).json()) as any;

    expect(body.scannable).toEqual({
      scannable: false,
      reason: "NOT_VERIFIED",
    });
    expect(body.instructions.recordValue).toBe(target.verificationToken);
  });
});

// ------------------------------------------------------------------ verify ---

describe("verifying ownership by DNS", () => {
  test("marks the target verified and records the addresses it resolved to", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    publishToken(target.hostname, target.verificationToken);
    zone.set(target.hostname, { a: [PUBLIC_IPV4], aaaa: [PUBLIC_IPV6] });

    const before = Date.now();
    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = (await readBody(response)) as any;

    expect(body.target.verificationStatus).toBe("VERIFIED");
    expect(body.scannable).toEqual({ scannable: true });

    // The literal addresses observed now, as single-host CIDRs: this is what
    // the Scope Guard compares against later to catch rebinding (ADR-0004).
    expect(body.target.verifiedIpRanges.sort()).toEqual(
      [`${PUBLIC_IPV4}/32`, `${PUBLIC_IPV6}/128`].sort(),
    );

    const expiresAt = new Date(body.target.verificationExpiresAt).getTime();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(expiresAt - before).toBeGreaterThan(ninetyDays - 60_000);
    expect(expiresAt - before).toBeLessThan(ninetyDays + 60_000);

    expect(await auditActions(target.id)).toEqual([
      "TARGET_CREATED",
      "TARGET_VERIFIED",
    ]);
  });

  test("is what makes a target scannable at all", async () => {
    // C.2 in one test: before the proof the target cannot be scanned, after it
    // it can, and nothing else in the module moves that verdict.
    const session = await createSession("ANALYST");
    const target = await register(session);

    const beforeRow = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(beforeRow.verificationStatus).toBe("PENDING");
    expect(beforeRow.verifiedIpRanges).toEqual([]);

    publishToken(target.hostname, target.verificationToken);
    await request(api, session, `/api/targets/${target.id}/verify`, {
      method: "POST",
    });

    const afterRow = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(afterRow.verificationStatus).toBe("VERIFIED");
    expect(afterRow.verifiedIpRanges.length).toBeGreaterThan(0);
  });

  test("refuses a record carrying somebody else's token", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    zone.set(`${TXT_PREFIX}.${target.hostname}`, {
      txt: [["a-token-from-a-different-target"]],
    });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toBe("TOKEN_MISMATCH");

    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.verificationStatus).toBe("FAILED");
    expect(row.verifiedIpRanges).toEqual([]);
    expect(await auditActions(target.id)).toEqual([
      "TARGET_CREATED",
      "TARGET_VERIFICATION_FAILED",
    ]);
  });

  test("refuses when no record has been published", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toBe("NO_RECORD");
  });

  test("re-runs the address gate, so a name that turns inward is refused", async () => {
    // The sharp edge of F.2. Registration checked the address, but DNS is the
    // registrant's to change: they can register a public address, wait, and
    // repoint at loopback or the cloud metadata service before verifying. The
    // verification is where addresses are committed, so the gate runs again
    // here and this is the run that matters.
    const session = await createSession("ANALYST");
    const target = await register(session);
    publishToken(target.hostname, target.verificationToken);

    zone.set(target.hostname, { a: ["169.254.169.254"] });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toMatchObject({
      kind: "ADDRESS",
      reason: "CLOUD_METADATA",
    });

    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.verificationStatus).toBe("FAILED");
    expect(row.verifiedIpRanges).toEqual([]);
  });

  test("checks the address before the challenge, so a forbidden host is never contacted", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    // A correctly published token at a host that now resolves inward. The
    // token must not rescue it.
    publishToken(target.hostname, target.verificationToken);
    zone.set(target.hostname, { a: ["127.0.0.1"] });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toMatchObject({ kind: "ADDRESS" });
  });

  test("refuses to verify an archived target", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    publishToken(target.hostname, target.verificationToken);
    await request(api, session, `/api/targets/${target.id}/archive`, {
      method: "POST",
    });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(400);
    expect(
      (await prisma.target.findUniqueOrThrow({ where: { id: target.id } }))
        .verificationStatus,
    ).toBe("PENDING");
  });

  test("rate limits repeated attempts", async () => {
    // Each attempt sends DNS or HTTP to a host nobody has verified, so a retry
    // loop here is an amplifier aimed at a third party.
    const session = await createSession("ANALYST");
    const target = await register(session);

    const first = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );
    expect(first.status).toBe(422); // No record published; the attempt was spent.

    const second = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(second.status).toBe(429);
    expect((await readBody(second)).rule.kind).toBe("TOO_SOON");
  });
});

describe("verifying ownership by a well-known file", () => {
  let server: ReturnType<typeof Bun.serve>;
  let respond: (request: Request) => Response;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => respond(request),
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  /**
   * A target the challenge can actually reach.
   *
   * The origin is `localhost` on the test server's port, so the real `fetch`
   * connects to the real server. The stubbed resolver reports a public address
   * for that name, which is what lets the origin gate pass: `fetch` does its
   * own resolution and is not affected by the stub.
   */
  async function registerLocal(session: TestSession): Promise<Registered> {
    zone.set("localhost", { a: [PUBLIC_IPV4] });
    const origin = `http://localhost:${server.port}`;

    const response = await request(api, session, "/api/targets", {
      method: "POST",
      body: JSON.stringify({
        origin,
        label: "Local site",
        authorisationAck: true,
        verificationMethod: "WELL_KNOWN",
      }),
    });

    expect(response.status).toBe(201);
    const { target } = (await readBody(response)) as any;
    return {
      id: target.id,
      origin: target.origin,
      hostname: "localhost",
      verificationToken: target.verificationToken,
    };
  }

  test("verifies when the file serves the token", async () => {
    const session = await createSession("ANALYST");
    const target = await registerLocal(session);
    respond = () => new Response(target.verificationToken);

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = (await readBody(response)) as any;
    expect(body.target.verificationStatus).toBe("VERIFIED");
    expect(body.target.verifiedIpRanges).toEqual([`${PUBLIC_IPV4}/32`]);
  });

  test("refuses when the file is missing", async () => {
    const session = await createSession("ANALYST");
    const target = await registerLocal(session);
    respond = () => new Response("Not found", { status: 404 });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toBe("HTTP_ERROR");
    expect(
      (await prisma.target.findUniqueOrThrow({ where: { id: target.id } }))
        .verificationStatus,
    ).toBe("FAILED");
  });

  test("refuses when the file serves the wrong content", async () => {
    const session = await createSession("ANALYST");
    const target = await registerLocal(session);
    respond = () => new Response("<html>404 page</html>");

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/verify`,
      { method: "POST" },
    );

    expect(response.status).toBe(422);
    expect((await readBody(response)).rule).toBe("TOKEN_MISMATCH");
  });
});

// ------------------------------------------------------------------- scope ---

describe("editing scope", () => {
  test("replaces the paths and audits what changed", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session, {
      includedPaths: ["/old"],
      excludedPaths: [],
    });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/scope`,
      {
        method: "PATCH",
        body: JSON.stringify({
          includedPaths: ["/app"],
          excludedPaths: ["/logout", "/admin"],
        }),
      },
    );

    expect(response.status).toBe(200);
    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.includedPaths).toEqual(["/app"]);
    expect(row.excludedPaths).toEqual(["/logout", "/admin"]);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceId: target.id, action: "TARGET_SCOPE_CHANGED" },
    });
    expect((audit.metadata as any).before.includedPaths).toEqual(["/old"]);
    expect((audit.metadata as any).after.includedPaths).toEqual(["/app"]);
  });

  test("does not invalidate the ownership proof", async () => {
    // Changing what gets crawled does not change who controls the origin, so
    // re-verification is not required. Making it required would train users to
    // re-verify for a harmless edit.
    const session = await createSession("ANALYST");
    const target = await register(session);
    publishToken(target.hostname, target.verificationToken);
    await request(api, session, `/api/targets/${target.id}/verify`, {
      method: "POST",
    });

    await request(api, session, `/api/targets/${target.id}/scope`, {
      method: "PATCH",
      body: JSON.stringify({ includedPaths: ["/app"], excludedPaths: [] }),
    });

    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.verificationStatus).toBe("VERIFIED");
    expect(row.verifiedIpRanges.length).toBeGreaterThan(0);
  });

  test("rejects paths that are not absolute", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/scope`,
      {
        method: "PATCH",
        body: JSON.stringify({ includedPaths: ["app"], excludedPaths: [] }),
      },
    );

    expect(response.status).toBe(400);
  });
});

// ------------------------------------------------------- archive and delete ---

describe("archiving a target", () => {
  test("stops it being scannable, whatever its verification says", async () => {
    // C.2 again: archiving is the operator's off switch for a target, so it has
    // to beat a live verification rather than sit alongside it.
    const session = await createSession("ANALYST");
    const target = await register(session);
    publishToken(target.hostname, target.verificationToken);
    await request(api, session, `/api/targets/${target.id}/verify`, {
      method: "POST",
    });

    const response = await request(
      api,
      session,
      `/api/targets/${target.id}/archive`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);

    const row = await prisma.target.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.isArchived).toBe(true);
    expect(row.archivedAt).not.toBeNull();
    // The proof is still on the row; the verdict is what changed.
    expect(row.verificationStatus).toBe("VERIFIED");

    const body = (await (
      await request(api, session, `/api/targets/${target.id}`)
    ).json()) as any;
    expect(body.scannable).toEqual({ scannable: false, reason: "ARCHIVED" });
  });

  test("is audited", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);
    await request(api, session, `/api/targets/${target.id}/archive`, {
      method: "POST",
    });

    expect(await auditActions(target.id)).toContain("TARGET_ARCHIVED");
  });
});

describe("deleting a target", () => {
  test("removes it", async () => {
    const session = await createSession("ANALYST");
    const target = await register(session);

    const response = await request(api, session, `/api/targets/${target.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(
      await prisma.target.findUnique({ where: { id: target.id } }),
    ).toBeNull();
  });

  test("leaves the audit trail behind", async () => {
    // The audit log carries no foreign key precisely so a delete cannot take
    // history with it (ADR-0002). Deleting a target must not erase the record
    // that it was registered and scanned.
    const session = await createSession("ANALYST");
    const target = await register(session);

    await request(api, session, `/api/targets/${target.id}`, {
      method: "DELETE",
    });

    expect(await auditActions(target.id)).toEqual([
      "TARGET_CREATED",
      "TARGET_DELETED",
    ]);
  });
});
