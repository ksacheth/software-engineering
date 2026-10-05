import { describe, expect, test } from "bun:test";

import {
  ACTIVE_DETECTORS,
  createMarker,
  loadDefinitions,
  runActiveDetectors,
  type ActiveContext,
  type ActiveSurface,
  type ProbeFn,
  type ProbeRequest,
  type ProbeResponse,
} from "../src";

const catalogue = await loadDefinitions();
const ORIGIN = "https://shop.example.com";

/** A reply the fixture server can return; headers default to text/html 200. */
type Reply = { status?: number; headers?: Record<string, string>; body?: string };

/** Builds a probe over an in-memory site. `routes` is matched by method+path;
 *  a function route can read the request to reflect inputs. The record of
 *  requests lets a test assert what was (and was not) sent. */
function fixture(routes: Record<string, Reply | ((req: ProbeRequest, url: URL) => Reply)>) {
  const requests: ProbeRequest[] = [];
  const probe: ProbeFn = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const route = routes[`${request.method} ${url.pathname}`] ?? routes[url.pathname];
    if (route === undefined) return { ok: true, status: 404, headers: new Headers({ "content-type": "text/html" }), body: "Not found" };
    const reply = typeof route === "function" ? route(request, url) : route;
    return {
      ok: true,
      status: reply.status ?? 200,
      headers: new Headers({ "content-type": "text/html", ...reply.headers }),
      body: reply.body ?? "",
    } satisfies ProbeResponse;
  };
  return { probe, requests };
}

function surface(overrides: Partial<ActiveSurface> = {}): ActiveSurface {
  return {
    origin: ORIGIN,
    entryUrls: [`${ORIGIN}/search?q=hello`],
    parameters: ["q"],
    forms: [],
    adminUrls: [],
    entryHeaders: {},
    ...overrides,
  };
}

function context(probe: ProbeFn, overrides: Partial<ActiveSurface> = {}): ActiveContext {
  return { surface: surface(overrides), probe, marker: createMarker };
}

const run = (ctx: ActiveContext) => runActiveDetectors(catalogue, "STANDARD", ctx);
const idsFrom = async (ctx: ActiveContext) => (await run(ctx)).findings.map((f) => f.detectorId);

describe("profile gating", () => {
  test("a PASSIVE scan runs no active detector", async () => {
    const { probe, requests } = fixture({ "/": { body: "home" } });
    const result = await runActiveDetectors(catalogue, "PASSIVE", context(probe));
    expect(result.findings).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("every active detector has a catalogue definition", () => {
    for (const detector of ACTIVE_DETECTORS) expect(catalogue.has(detector.id)).toBe(true);
  });
});

describe("a hardened site", () => {
  test("produces no findings", async () => {
    const { probe } = fixture({
      "/": (_req, url): Reply =>
        url.protocol === "http:"
          ? { status: 301, headers: { location: `https://${url.host}/` } }
          : { headers: { "x-frame-options": "DENY", "strict-transport-security": "max-age=63072000" }, body: "welcome" },
      "OPTIONS /": { headers: { allow: "GET, HEAD, POST, OPTIONS" } },
      "/search": (_req, url) => ({ body: `You searched for: ${escapeHtml(url.searchParams.get("q") ?? "")}` }),
    });
    expect(await idsFrom(context(probe))).toEqual([]);
  });
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

describe("injection probes", () => {
  test("A-01 flags a parameter reflected without HTML encoding", async () => {
    const { probe } = fixture({ "/search": (_req, url) => ({ body: `Results for ${url.searchParams.get("q")}` }) });
    const [finding] = (await run(context(probe))).findings.filter((f) => f.detectorId === "A-01");
    expect(finding).toMatchObject({ affectedParameter: "q", severity: "HIGH", cwe: "CWE-79" });
  });

  test("A-01 does not flag a parameter that is HTML-encoded on the way out", async () => {
    const { probe } = fixture({ "/search": (_req, url) => ({ body: `Results for ${escapeHtml(url.searchParams.get("q") ?? "")}` }) });
    expect(await idsFrom(context(probe))).not.toContain("A-01");
  });

  test("A-02 flags a database error from a syntax-breaking character", async () => {
    const { probe } = fixture({
      "/search": (_req, url) =>
        url.searchParams.get("q") === "'" ? { status: 500, body: "You have an error in your SQL syntax near ''" } : { body: "ok" },
    });
    expect(await idsFrom(context(probe))).toContain("A-02");
  });

  test("A-03 flags a boolean condition that changes the response shape", async () => {
    const { probe } = fixture({
      "/search": (_req, url) => {
        const q = url.searchParams.get("q");
        const rows = q === "1 AND 1=2" ? [] : [1, 2, 3];
        return { body: `<ul>${rows.map((n) => `<li>item ${n}</li>`).join("")}</ul>` };
      },
    });
    expect(await idsFrom(context(probe))).toContain("A-03");
  });

  test("A-03 stays quiet when the parameter does not change the page", async () => {
    const { probe } = fixture({ "/search": { body: "<ul><li>static</li></ul>" } });
    expect(await idsFrom(context(probe))).not.toContain("A-03");
  });

  test("A-11 flags a read-only traversal that returns a system-file signature", async () => {
    const { probe } = fixture({
      "/search": (_req, url) => (/etc\/passwd/.test(url.searchParams.get("q") ?? "") ? { body: "root:x:0:0:root:/root:/bin/bash" } : { body: "ok" }),
    });
    expect(await idsFrom(context(probe))).toContain("A-11");
  });

  test("A-12 flags server-side evaluation but not a page that echoes the expression", async () => {
    const evaluates = fixture({ "/search": (_req, url) => ({ body: `= ${/\{\{71\*71\}\}/.test(url.searchParams.get("q") ?? "") ? "5041" : ""}` }) });
    expect(await idsFrom(context(evaluates.probe))).toContain("A-12");
    const echoes = fixture({ "/search": (_req, url) => ({ body: `You typed ${url.searchParams.get("q")}` }) });
    expect(await idsFrom(context(echoes.probe))).not.toContain("A-12");
  });
});

describe("http probes", () => {
  test("A-04 flags a redirect that follows a sentinel target", async () => {
    const { probe } = fixture({
      "/go": (_req, url) => ({ status: 302, headers: { location: url.searchParams.get("next") ?? "/" } }),
    });
    const ctx = context(probe, { parameters: ["next"], entryUrls: [`${ORIGIN}/go?next=/home`] });
    const [finding] = (await run(ctx)).findings.filter((f) => f.detectorId === "A-04");
    expect(finding).toMatchObject({ affectedParameter: "next" });
  });

  test("A-05 flags a reflected Origin, and clears a same-origin-only policy", async () => {
    const reflecting = fixture({ "/": (req) => ({ headers: { "access-control-allow-origin": req.headers?.Origin ?? "", "access-control-allow-credentials": "true" } }) });
    expect(await idsFrom(context(reflecting.probe))).toContain("A-05");
    const strict = fixture({ "/": { headers: { "access-control-allow-origin": "https://shop.example.com" } } });
    expect(await idsFrom(context(strict.probe))).not.toContain("A-05");
  });

  test("A-06 flags a framable page", async () => {
    const { probe } = fixture({ "/": { body: "framable" } });
    expect(await idsFrom(context(probe))).toContain("A-06");
  });

  test("A-07 enumerates risky methods via OPTIONS without sending them", async () => {
    const { probe, requests } = fixture({ "OPTIONS /": { headers: { allow: "GET, POST, PUT, DELETE, TRACE" } }, "/": { body: "home" } });
    expect(await idsFrom(context(probe))).toContain("A-07");
    expect(requests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);
  });

  test("A-08 flags a reflected Host header", async () => {
    const { probe } = fixture({ "/": (req) => ({ body: `<link rel="canonical" href="https://${req.headers?.Host}/"/>` }) });
    const [finding] = (await run(context(probe))).findings.filter((f) => f.detectorId === "A-08");
    expect(finding).toMatchObject({ affectedParameter: "Host" });
  });

  test("A-14 flags a plaintext origin that does not redirect to HTTPS", async () => {
    const { probe } = fixture({ "/": { body: "served over http" } });
    expect(await idsFrom(context(probe))).toContain("A-14");
  });
});

describe("access probes", () => {
  test("A-09 flags a reachable sensitive path and raises severity for secrets", async () => {
    const { probe } = fixture({ "/.env": { body: "APP_KEY=x" }, "/admin": { body: "panel" } });
    const findings = (await run(context(probe))).findings.filter((f) => f.detectorId === "A-09");
    expect(findings.find((f) => f.affectedUrl.endsWith("/.env"))?.severity).toBe("HIGH");
    expect(findings.find((f) => f.affectedUrl.endsWith("/admin"))?.severity).toBe("MEDIUM");
  });

  test("A-10 flags a POST form with no anti-CSRF token, not one that has it", async () => {
    const withoutToken = { action: `${ORIGIN}/transfer`, method: "POST", inputs: [{ name: "amount", type: "text" }] };
    const withToken = { action: `${ORIGIN}/pay`, method: "POST", inputs: [{ name: "csrf_token", type: "hidden" }] };
    const { probe } = fixture({});
    const findings = (await run(context(probe, { forms: [withoutToken, withToken] }))).findings.filter((f) => f.detectorId === "A-10");
    expect(findings.map((f) => f.affectedUrl)).toEqual([`${ORIGIN}/transfer`]);
  });

  test("A-13 flags an admin page served without a login prompt", async () => {
    const open = fixture({ "/admin": { body: "<h1>Admin Dashboard</h1><p>Manage users</p>" } });
    expect(await idsFrom(context(open.probe, { adminUrls: [`${ORIGIN}/admin`] }))).toContain("A-13");
    const gated = fixture({ "/admin": { body: "<form>Please sign in with your password</form>" } });
    expect(await idsFrom(context(gated.probe, { adminUrls: [`${ORIGIN}/admin`] }))).not.toContain("A-13");
  });
});

describe("resilience", () => {
  test("a detector that throws is recorded and the others still run", async () => {
    const probe: ProbeFn = async () => {
      throw new Error("connection reset");
    };
    const result = await runActiveDetectors(catalogue, "STANDARD", context(probe));
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toMatchObject({ affectedUrl: ORIGIN, message: "connection reset" });
  });
});
