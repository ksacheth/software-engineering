import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelScan,
  fetchScan,
  fetchScans,
  pauseScan,
  ScanApiError,
  startScan,
} from "./scans";
import {
  archiveTarget,
  deleteTarget,
  fetchTargets,
  registerTarget,
  TargetApiError,
  verifyTarget,
} from "./targets";

/**
 * The dashboard's two API clients.
 *
 * Both endpoints refuse in ways the UI has to act on rather than merely print:
 * F.2 answers a refused origin with the rule that refused it and a rate limit
 * with how long to wait, and F.3 answers with RFC 9457 problem details carrying
 * a machine-readable code. A client that flattens those into a string leaves
 * every call site with nothing to branch on, so what is asserted here is that
 * the structure survives the trip.
 *
 * `fetch` is replaced rather than served, because what matters is the request
 * that goes out and the error that comes back, not the transport.
 */

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const calls: Call[] = [];
let respond: () => Response;

const realFetch = globalThis.fetch;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return respond();
};

afterAll(() => {
  globalThis.fetch = realFetch;
});

const lastCall = () => calls.at(-1)!;

function json(body: unknown, status = 200): void {
  respond = () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

beforeEach(() => {
  calls.length = 0;
  json({});
});

// ------------------------------------------------------------------ shared ---

describe("every request", () => {
  test("carries the session cookie", async () => {
    // The API authenticates by cookie. Without this the dashboard is
    // anonymous and every call is a 401.
    json({ scans: [], nextCursor: null });
    await fetchScans({});
    expect(lastCall().init?.credentials).toBe("same-origin");

    json({ targets: [] });
    await fetchTargets();
    expect(lastCall().init?.credentials).toBe("same-origin");
  });

  test("returns nothing for a 204 rather than failing to parse it", async () => {
    // Delete answers 204. Reading a body that is not there would turn a
    // successful delete into an error the user has to puzzle over.
    respond = () => new Response(null, { status: 204 });
    expect(await deleteTarget("target-1")).toBeUndefined();
  });

  test("survives an error body that is not JSON", async () => {
    // A proxy or a crashed process answers with HTML, and the client still has
    // to produce a usable error instead of throwing a parse failure.
    respond = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

    const error = (await fetchScan("scan-1").catch((e) => e)) as ScanApiError;
    expect(error).toBeInstanceOf(ScanApiError);
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });
});

// ------------------------------------------------------------------- scans ---

describe("the scan client", () => {
  test("posts a scan request", async () => {
    json({ scan: { id: "scan-1" } });

    await startScan({ targetId: "target-1", profile: "STANDARD" });

    expect(lastCall().url).toBe("/api/scans");
    expect(lastCall().init?.method).toBe("POST");
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      targetId: "target-1",
      profile: "STANDARD",
    });
  });

  test("keeps the problem code, which is what the UI branches on", async () => {
    // A refusal that only carries prose forces the dialog to match on message
    // text, which breaks the first time the wording is improved.
    json(
      {
        detail: "This target already has a scan in progress.",
        code: "TARGET_SCAN_IN_PROGRESS",
        scanStatus: "RUNNING",
      },
      409,
    );

    const error = (await startScan({
      targetId: "target-1",
      profile: "STANDARD",
    }).catch((e) => e)) as ScanApiError;

    expect(error.status).toBe(409);
    expect(error.code).toBe("TARGET_SCAN_IN_PROGRESS");
    expect(error.scanStatus).toBe("RUNNING");
    expect(error.message).toBe("This target already has a scan in progress.");
  });

  test("keeps field errors so a form can point at the field", async () => {
    json(
      {
        detail: "The scan configuration is invalid.",
        code: "INVALID_CONFIGURATION",
        errors: [{ pointer: "/configuration/maxDepth", detail: "Too deep." }],
      },
      400,
    );

    const error = (await startScan({
      targetId: "target-1",
      profile: "THOROUGH",
    }).catch((e) => e)) as ScanApiError;

    expect(error.errors).toEqual([
      { pointer: "/configuration/maxDepth", detail: "Too deep." },
    ]);
  });

  test("reads a plain error body as well as a problem document", async () => {
    // Not every refusal on this path is RFC 9457; the middleware ones are not.
    json({ error: "Forbidden" }, 403);

    const error = (await fetchScan("scan-1").catch((e) => e)) as ScanApiError;
    expect(error.message).toBe("Forbidden");
  });

  test("omits filters that were not set", async () => {
    // A blank `status=` is not the same request as no status at all, and the
    // API would read it as a filter on the empty string.
    json({ scans: [], nextCursor: null });

    await fetchScans({});
    expect(lastCall().url).toBe("/api/scans");

    await fetchScans({ targetId: "target-1", status: "RUNNING" }, "cursor-9");
    const url = new URL(lastCall().url, "http://localhost");
    expect(url.searchParams.get("targetId")).toBe("target-1");
    expect(url.searchParams.get("status")).toBe("RUNNING");
    expect(url.searchParams.get("cursor")).toBe("cursor-9");
  });

  test("sends each lifecycle control to its own endpoint", async () => {
    json({ scan: { id: "scan-1" } });

    await pauseScan("scan-1");
    expect(lastCall().url).toBe("/api/scans/scan-1/pause");
    expect(lastCall().init?.method).toBe("POST");

    await cancelScan("scan-1");
    expect(lastCall().url).toBe("/api/scans/scan-1/cancel");
  });
});

// ----------------------------------------------------------------- targets ---

describe("the target client", () => {
  test("keeps the refusal rule, so the UI can explain what was refused", async () => {
    // F.2 requires the refusal to name the triggering rule. Losing the
    // structure leaves the register dialog unable to tell an unresolvable
    // hostname from one that resolves somewhere it must not.
    json(
      {
        error:
          "Refused: the hostname resolves to a cloud metadata address (169.254.169.254).",
        rule: {
          kind: "ADDRESS",
          reason: "CLOUD_METADATA",
          detail: "169.254.169.254",
        },
      },
      422,
    );

    const error = (await registerTarget({
      origin: "https://evil.test",
      label: "Nope",
      verificationMethod: "DNS_TXT",
      authorisationAck: true,
    }).catch((e) => e)) as TargetApiError;

    expect(error).toBeInstanceOf(TargetApiError);
    expect(error.status).toBe(422);
    expect(error.rule).toEqual({
      kind: "ADDRESS",
      reason: "CLOUD_METADATA",
      detail: "169.254.169.254",
    });
  });

  test("keeps the id of an origin that is already registered", async () => {
    // A 409 is the one refusal with somewhere useful to go: the dialog can
    // offer the existing target rather than just saying no.
    json({ error: "This origin is already registered.", targetId: "target-7" }, 409);

    const error = (await registerTarget({
      origin: "https://a.test",
      label: "Duplicate",
      verificationMethod: "DNS_TXT",
      authorisationAck: true,
    }).catch((e) => e)) as TargetApiError;

    expect(error.status).toBe(409);
    expect(error.targetId).toBe("target-7");
  });

  test("keeps the retry delay from a rate limited verification", async () => {
    // The user is told how long to wait, so the number has to arrive intact.
    json(
      {
        error: "Please wait 24s before retrying verification.",
        rule: { kind: "TOO_SOON", retryAfterSeconds: 24 },
      },
      429,
    );

    const error = (await verifyTarget("target-1").catch(
      (e) => e,
    )) as TargetApiError;

    expect(error.status).toBe(429);
    expect(error.rule).toEqual({ kind: "TOO_SOON", retryAfterSeconds: 24 });
  });

  test("keeps the challenge failure from a verification that did not prove anything", async () => {
    json({ error: "No TXT record found.", rule: "NO_RECORD" }, 422);

    const error = (await verifyTarget("target-1").catch(
      (e) => e,
    )) as TargetApiError;

    expect(error.rule).toBe("NO_RECORD");
  });

  test("asks for archived targets only when told to", async () => {
    json({ targets: [] });

    await fetchTargets();
    expect(lastCall().url).toContain("includeArchived=false");

    await fetchTargets(true);
    expect(lastCall().url).toContain("includeArchived=true");
  });

  test("archives through its own endpoint rather than a general update", async () => {
    // Archiving is audited as its own action (F.8), so it is not a field the
    // client may set through a patch.
    json({ target: { id: "target-1" } });

    await archiveTarget("target-1");

    expect(lastCall().url).toBe("/api/targets/target-1/archive");
    expect(lastCall().init?.method).toBe("POST");
  });
});
