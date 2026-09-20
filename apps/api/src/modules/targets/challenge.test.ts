import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

/**
 * F.2 ownership verification challenges.
 *
 * This is the evidence C.2 rests on: everything downstream treats a VERIFIED
 * target as proof that the requester controls the origin, so a challenge that
 * accepts something it should not is the one bug that turns the product into
 * the anonymous attack platform the SRS forbids. The tests are therefore
 * written from the attacker's side as much as the happy path.
 *
 * Only the network edge is replaced. DNS is a stub because a test may not
 * depend on a public zone existing, but the well-known half runs against a real
 * HTTP server on loopback: its failure modes are redirects, statuses and slow
 * responses, and a stubbed `fetch` would assert nothing about any of them.
 */

const realDns = await import("node:dns");

/** Hostname -> TXT record sets, in the shape `dns.resolveTxt` returns. */
const txtZone = new Map<string, string[][]>();
/** Hostname -> the code a lookup should fail with. */
const txtErrors = new Map<string, string>();

function dnsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`queryTxt ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

mock.module("node:dns", () => ({
  ...realDns,
  promises: {
    ...realDns.promises,
    resolveTxt: async (name: string) => {
      const failure = txtErrors.get(name);
      if (failure) throw dnsError(failure);
      const records = txtZone.get(name);
      if (!records) throw dnsError("ENOTFOUND");
      return records;
    },
  },
}));

const {
  checkDnsTxt,
  checkWellKnown,
  describeChallengeFailure,
  generateVerificationToken,
  TXT_RECORD_PREFIX,
  WELL_KNOWN_PATH,
} = await import("./challenge");

afterEach(() => {
  txtZone.clear();
  txtErrors.clear();
});

const TOKEN = "3Xq9dVQ0mJYQ0mF0y0kU0lV0x0nZ0aB0cD0eF0gH0iJ";

describe("the verification token", () => {
  test("is unpredictable and unique per call", () => {
    const tokens = new Set(
      Array.from({ length: 500 }, () => generateVerificationToken()),
    );
    // 32 bytes of randomness: a collision in 500 draws means the source is not
    // random, which is the failure that lets someone verify a domain they do
    // not control.
    expect(tokens.size).toBe(500);
  });

  test("is url-safe, so it survives a DNS record and a text file unaltered", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateVerificationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("the DNS TXT challenge", () => {
  const host = "example.test";
  const name = `${TXT_RECORD_PREFIX}.${host}`;

  test("accepts a record carrying the token", async () => {
    txtZone.set(name, [[TOKEN]]);
    expect(await checkDnsTxt(host, TOKEN)).toEqual({ ok: true });
  });

  test("queries the prefixed name, not the target itself", async () => {
    txtZone.set(host, [[TOKEN]]);

    // Publishing the token at the apex proves nothing about the prefixed name
    // we asked for, and accepting it would widen the challenge to any record
    // the host already serves.
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "NO_RECORD",
    });
  });

  test("joins a record split across strings before comparing", async () => {
    // TXT strings are capped at 255 bytes, so resolvers hand back chunks. A
    // comparison against the first chunk alone would reject a correctly
    // published token.
    txtZone.set(name, [[TOKEN.slice(0, 20), TOKEN.slice(20)]]);
    expect(await checkDnsTxt(host, TOKEN)).toEqual({ ok: true });
  });

  test("finds the token among unrelated records", async () => {
    txtZone.set(name, [["v=spf1 -all"], ["unrelated"], [TOKEN]]);
    expect(await checkDnsTxt(host, TOKEN)).toEqual({ ok: true });
  });

  test("tolerates surrounding whitespace", async () => {
    txtZone.set(name, [[`  ${TOKEN}\n`]]);
    expect(await checkDnsTxt(host, TOKEN)).toEqual({ ok: true });
  });

  test("refuses a record that merely contains the token", async () => {
    // A substring match would let anyone who can publish any TXT record at the
    // prefixed name pass by appending the token to existing content.
    txtZone.set(name, [[`not-yours-${TOKEN}-either`]]);
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "TOKEN_MISMATCH",
    });
  });

  test("refuses a different token", async () => {
    txtZone.set(name, [[generateVerificationToken()]]);
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "TOKEN_MISMATCH",
    });
  });

  test("reports a missing name as NO_RECORD", async () => {
    txtErrors.set(name, "ENOTFOUND");
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "NO_RECORD",
      detail: name,
    });
  });

  test("reports a name with no TXT records as NO_RECORD", async () => {
    txtErrors.set(name, "ENODATA");
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "NO_RECORD",
    });
  });

  test("reports an empty answer as NO_RECORD", async () => {
    txtZone.set(name, []);
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "NO_RECORD",
    });
  });

  test("distinguishes a broken lookup from an absent record", async () => {
    // SERVFAIL means we do not know whether the record exists. Reporting it as
    // NO_RECORD would tell the user to go and publish a record they may already
    // have published.
    txtErrors.set(name, "SERVFAIL");
    expect(await checkDnsTxt(host, TOKEN)).toMatchObject({
      ok: false,
      failure: "LOOKUP_FAILED",
      detail: "SERVFAIL",
    });
  });
});

describe("the well-known challenge", () => {
  let origin: string;
  let respond: (request: Request) => Response | Promise<Response>;
  let server: ReturnType<typeof Bun.serve>;

  /**
   * What the server saw, read while the request is still live. Holding the
   * `Request` itself and reading it afterwards yields an empty husk, because
   * Bun releases it once the handler returns.
   */
  interface Seen {
    pathname: string;
    userAgent: string | null;
    accept: string | null;
  }
  let seen: Seen | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen = {
          pathname: new URL(request.url).pathname,
          userAgent: request.headers.get("user-agent"),
          accept: request.headers.get("accept"),
        };
        return respond(request);
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  afterEach(() => {
    seen = null;
  });

  const serve = (body: string, init?: ResponseInit) => {
    respond = () => new Response(body, init);
  };

  test("accepts a file containing exactly the token", async () => {
    serve(TOKEN);
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toEqual({
      ok: true,
    });
  });

  test("requests the well-known path", async () => {
    serve(TOKEN);
    await checkWellKnown(origin, TOKEN, "127.0.0.1");
    expect(seen!.pathname).toBe(WELL_KNOWN_PATH);
  });

  test("identifies itself on the outbound request", async () => {
    // F.8: every request WVS originates is attributable, including the ones it
    // makes before a target is verified.
    serve(TOKEN);
    await checkWellKnown(origin, TOKEN, "127.0.0.1");
    expect(seen!.userAgent).toContain("WVS-Verification");
    expect(seen!.accept).toBe("text/plain");
  });

  test("tolerates a trailing newline, which every editor adds", async () => {
    serve(`${TOKEN}\n`);
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toEqual({
      ok: true,
    });
  });

  test("refuses a file with different content", async () => {
    serve("not the token");
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "TOKEN_MISMATCH",
    });
  });

  test("refuses a body that buries the token in padding", async () => {
    // The read is capped, so a large body cannot be streamed at us, and the
    // comparison is against the whole capped read rather than a search within
    // it.
    serve(`${TOKEN}${"x".repeat(8192)}`);
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "TOKEN_MISMATCH",
    });
  });

  test("refuses a missing file", async () => {
    serve("nope", { status: 404 });
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "HTTP_ERROR",
      detail: "404",
    });
  });

  test("refuses a server error", async () => {
    serve("boom", { status: 500 });
    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "HTTP_ERROR",
      detail: "500",
    });
  });

  test("refuses to follow a redirect, even to a file with the right token", async () => {
    // The redirect target is chosen by the unverified host, so following one
    // would let it point the check at something it does not control, or at an
    // address the origin gate already refused.
    respond = (request) =>
      new URL(request.url).pathname === WELL_KNOWN_PATH
        ? new Response(null, { status: 302, headers: { location: "/token" } })
        : new Response(TOKEN);

    expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "HTTP_ERROR",
    });
  });

  test("refuses when nothing is listening", async () => {
    const dead = "http://127.0.0.1:1";
    expect(await checkWellKnown(dead, TOKEN, "127.0.0.1")).toMatchObject({
      ok: false,
      failure: "HTTP_ERROR",
    });
  });

  test(
    "gives up on a host that never responds",
    async () => {
      // An unverified host holding the connection open is a way to tie up a
      // request slot, so the challenge has its own deadline.
      respond = () => new Promise<Response>(() => {});
      expect(await checkWellKnown(origin, TOKEN, "127.0.0.1")).toEqual({
        ok: false,
        failure: "TIMEOUT",
      });
    },
    15_000,
  );
});

describe("refusal messages", () => {
  test("tell a DNS user about DNS and a file user about the file", async () => {
    const dns = describeChallengeFailure("NO_RECORD", "DNS_TXT", "example.test");
    const file = describeChallengeFailure(
      "NO_RECORD",
      "WELL_KNOWN",
      "example.test",
    );

    expect(dns).toContain(`${TXT_RECORD_PREFIX}.example.test`);
    expect(file).toContain(WELL_KNOWN_PATH);
    expect(dns).not.toBe(file);
  });

  test("never leave a failure without an explanation", () => {
    const failures = [
      "NO_RECORD",
      "TOKEN_MISMATCH",
      "LOOKUP_FAILED",
      "HTTP_ERROR",
      "TIMEOUT",
    ] as const;

    for (const failure of failures) {
      for (const method of ["DNS_TXT", "WELL_KNOWN"]) {
        expect(
          describeChallengeFailure(failure, method, "example.test").length,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("never quote the token back", () => {
    // The message is shown in a UI and may be copied into a bug report; the
    // token is the proof and does not belong in either.
    const message = describeChallengeFailure(
      "TOKEN_MISMATCH",
      "DNS_TXT",
      "example.test",
    );
    expect(message).not.toContain(TOKEN);
  });
});
