import { describe, expect, test } from "bun:test";

import {
  ACTIVE_DETECTORS,
  createMarker,
  loadDefinitions,
  runActiveDetectors,
  type ActiveContext,
  type ActiveDetector,
  type ActiveSurface,
  type ProbeFn,
  type ProbeRequest,
  type ProbeResponse,
} from "../src";
import { createMarkerFactory } from "../src/active";

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

/** Parameter URLs default to the entry pages, as on a site whose query
 *  inputs all return HTML. */
function surface(overrides: Partial<ActiveSurface> = {}): ActiveSurface {
  const entryUrls = overrides.entryUrls ?? [`${ORIGIN}/search?q=hello`];
  return {
    origin: ORIGIN,
    entryUrls,
    parameterUrls: entryUrls,
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

  test("A-11 probes a parameter seen only on a URL that served plain text", async () => {
    const { probe } = fixture({
      "/download": (_req, url) =>
        /etc\/passwd/.test(url.searchParams.get("file") ?? "")
          ? { headers: { "content-type": "text/plain" }, body: "root:x:0:0:root:/root:/bin/bash" }
          : { status: 404, body: "Not found" },
    });
    const ctx = context(probe, {
      parameters: ["file"],
      entryUrls: [`${ORIGIN}/`],
      parameterUrls: [`${ORIGIN}/download?file=report.txt`],
    });
    expect(await idsFrom(ctx)).toContain("A-11");
  });

  test("A-12 flags server-side evaluation but not a page that echoes the expression", async () => {
    const evaluates = fixture({ "/search": (_req, url) => ({ body: `= ${(url.searchParams.get("q") ?? "").replace("{{71*71}}", "5041")}` }) });
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
    const { probe } = fixture({
      "/.env": { headers: { "content-type": "text/plain" }, body: "APP_KEY=x" },
      "/admin": { body: "<h1>Admin Panel</h1><a href='/users'>Manage users</a>" },
    });
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
    const { probe } = fixture({ "/": { body: "framable" } });
    const broken: ActiveDetector = {
      id: "A-10",
      run: async () => {
        throw new Error("boom");
      },
    };
    const working = ACTIVE_DETECTORS.find((d) => d.id === "A-06")!;
    const result = await runActiveDetectors(catalogue, "STANDARD", context(probe), [broken, working]);
    expect(result.failures).toEqual([{ detectorId: "A-10", affectedUrl: ORIGIN, message: "boom" }]);
    expect(result.findings.map((f) => f.detectorId)).toEqual(["A-06"]);
  });

  test("a probe that throws is treated as a failed request, not a lost detector", async () => {
    const probe: ProbeFn = async () => {
      throw new Error("connection reset");
    };
    const result = await runActiveDetectors(catalogue, "STANDARD", context(probe));
    expect(result.failures).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  test("a probe that throws on one path does not drop observations from the others", async () => {
    const { probe: inner } = fixture({
      "/.env": { headers: { "content-type": "text/plain" }, body: "APP_KEY=x" },
      "/.git/config": { headers: { "content-type": "text/plain" }, body: "[core]\n\trepositoryformatversion = 0" },
    });
    const probe: ProbeFn = async (request) => {
      if (request.url.endsWith("/admin")) throw new Error("connection reset");
      return inner(request);
    };
    const findings = (await run(context(probe))).findings.filter((f) => f.detectorId === "A-09");
    expect(findings.map((f) => new URL(f.affectedUrl).pathname).sort()).toEqual(["/.env", "/.git/config"]);
  });
});

const TEXT = { "content-type": "text/plain" };

describe("A-01 content type", () => {
  test("a JSON response that echoes the value is not reflected XSS", async () => {
    const { probe } = fixture({
      "/search": (_req, url) => ({ headers: { "content-type": "application/json" }, body: `{"q":"${url.searchParams.get("q")}"}` }),
    });
    expect(await idsFrom(context(probe))).not.toContain("A-01");
  });

  test("an XHTML response that echoes the value is flagged", async () => {
    const { probe } = fixture({
      "/search": (_req, url) => ({ headers: { "content-type": "application/xhtml+xml" }, body: `<p>${url.searchParams.get("q")}</p>` }),
    });
    expect(await idsFrom(context(probe))).toContain("A-01");
  });
});

describe("control requests (A-02, A-11)", () => {
  test("A-02 ignores a docs page that shows SQL error text for any input", async () => {
    const { probe } = fixture({ "/search": { body: "Common error: You have an error in your SQL syntax near ..." } });
    expect(await idsFrom(context(probe))).not.toContain("A-02");
  });

  test("A-11 ignores a page that documents the passwd format for any input", async () => {
    const { probe } = fixture({ "/search": { body: "Example line: root:x:0:0:root:/root:/bin/bash" } });
    expect(await idsFrom(context(probe))).not.toContain("A-11");
  });

  test("A-02 sends a benign control value after seeing a signature", async () => {
    const { probe, requests } = fixture({
      "/search": (_req, url) => (url.searchParams.get("q") === "'" ? { body: "SQLSTATE[42000]" } : { body: "ok" }),
    });
    await run(context(probe));
    expect(requests.some((r) => new URL(r.url).searchParams.get("q")?.startsWith("wvsprobe"))).toBe(true);
  });
});

describe("A-12 marker bracketing", () => {
  test("a page that merely contains 5041 is not template injection", async () => {
    const { probe } = fixture({ "/search": { body: "<script src=/app.5041.js></script> price 5041" } });
    expect(await idsFrom(context(probe))).not.toContain("A-12");
  });

  test("the evaluated result must sit between the markers", async () => {
    const { probe } = fixture({
      "/search": (_req, url) => ({ body: `out: ${(url.searchParams.get("q") ?? "").replace("${71*71}", "5041")}` }),
    });
    const [finding] = (await run(context(probe))).findings.filter((f) => f.detectorId === "A-12");
    expect(finding?.evidence?.extractedSnippet).toBe("${71*71} -> 5041");
  });
});

describe("parameter volume", () => {
  test("probes at most 20 parameters per detector and prefers names seen in URLs", async () => {
    const formOnly = Array.from({ length: 30 }, (_, i) => `field${i}`);
    const { probe, requests } = fixture({ "/search": { body: "ok" } });
    await run(context(probe, { parameters: [...formOnly, "q"] }));
    const a01Probes = requests.filter((r) => new URL(r.url).searchParams.get("q")?.startsWith("'\"<")).length;
    expect(a01Probes).toBe(1);
    const fieldsProbed = new Set(
      requests.flatMap((r) => formOnly.filter((name) => new URL(r.url).searchParams.has(name))),
    );
    expect(fieldsProbed.size).toBe(19);
  });
});

describe("A-04 redirects", () => {
  test("probes a redirect endpoint the crawl saw only as a 302, not the first page", async () => {
    const { probe, requests } = fixture({
      "/go": (_req, url) => ({ status: 302, headers: { location: url.searchParams.get("url") ?? "/" } }),
    });
    const ctx = context(probe, {
      parameters: ["url"],
      entryUrls: [`${ORIGIN}/`],
      parameterUrls: [`${ORIGIN}/go?url=%2F`],
    });
    expect(await idsFrom(ctx)).toContain("A-04");
    expect(requests.some((r) => new URL(r.url).pathname === "/" && r.url.includes("url="))).toBe(false);
  });

  test("a /login?next= redirect that merely carries the sentinel is not an open redirect", async () => {
    const { probe } = fixture({
      "/go": (_req, url) => ({ status: 302, headers: { location: `/login?next=${encodeURIComponent(url.toString())}` } }),
    });
    const ctx = context(probe, { parameters: ["next"], entryUrls: [`${ORIGIN}/go?next=/home`] });
    expect(await idsFrom(ctx)).not.toContain("A-04");
  });

  test("a protocol-relative redirect to the sentinel host is flagged", async () => {
    const { probe } = fixture({ "/go": { status: 302, headers: { location: "//wvs-sentinel.invalid/" } } });
    const ctx = context(probe, { parameters: ["next"], entryUrls: [`${ORIGIN}/go?next=/home`] });
    expect(await idsFrom(ctx)).toContain("A-04");
  });
});

describe("A-05 CORS", () => {
  const reflect = (credentials: boolean, vary?: string) =>
    fixture({
      "/": (req) => ({
        headers: {
          "access-control-allow-origin": req.headers?.Origin ?? "",
          ...(credentials ? { "access-control-allow-credentials": "true" } : {}),
          ...(vary ? { vary } : {}),
        },
      }),
    });

  test("a reflected origin with credentials keeps the definition's severity", async () => {
    const [finding] = (await run(context(reflect(true, "Origin").probe))).findings.filter((f) => f.detectorId === "A-05");
    expect(finding?.severity).toBe("HIGH");
  });

  test("a reflected origin without credentials is lowered and notes a missing Vary", async () => {
    const [finding] = (await run(context(reflect(false).probe))).findings.filter((f) => f.detectorId === "A-05");
    expect(finding?.severity).toBe("LOW");
    expect(finding?.description).toContain("Vary: Origin is missing");
  });
});

describe("A-06 framing", () => {
  test.each([
    ["a redirect", { status: 302, headers: { location: "/home" } }],
    ["a 404", { status: 404, body: "gone" }],
    ["a JSON document", { headers: { "content-type": "application/json" }, body: "{}" }],
  ])("does not judge %s", async (_name, reply) => {
    const { probe } = fixture({ "/": reply });
    expect(await idsFrom(context(probe))).not.toContain("A-06");
  });
});

describe("A-08 host header", () => {
  test("a 404 page that prints the unknown host is not reflection", async () => {
    const { probe } = fixture({ "/": (req) => (req.headers?.Host ? { status: 404, body: `Unknown host ${req.headers.Host}` } : { body: "home" }) });
    expect(await idsFrom(context(probe))).not.toContain("A-08");
  });
});

describe("path-scoped targets", () => {
  test("root probes fall back to the first in-scope entry URL when / is refused", async () => {
    const inner = fixture({ "/app/home": { body: "framable", headers: { allow: "GET, TRACE" } } });
    const probe: ProbeFn = async (request) => (new URL(request.url).pathname.startsWith("/app") ? inner.probe(request) : { ok: false });
    const ctx = context(probe, { entryUrls: [`${ORIGIN}/app/home`], parameters: [] });
    const findings = (await run(ctx)).findings.filter((f) => ["A-06", "A-07"].includes(f.detectorId));
    expect(findings.map((f) => f.detectorId).sort()).toEqual(["A-06", "A-07"]);
    expect(findings.every((f) => f.affectedUrl === `${ORIGIN}/app/home`)).toBe(true);
  });

  test("records nothing when every root probe is refused", async () => {
    const probe: ProbeFn = async () => ({ ok: false });
    expect((await run(context(probe))).findings).toEqual([]);
  });
});

describe("A-14 plaintext twin", () => {
  test("probes http://<hostname>/ without the https port", async () => {
    const { probe, requests } = fixture({ "/": { body: "served over http" } });
    await run(context(probe, { origin: "https://shop.example.com:8443" }));
    expect(requests.map((r) => r.url)).toContain("http://shop.example.com/");
    expect(requests.some((r) => r.url.includes(":8443/") && r.url.startsWith("http://"))).toBe(false);
  });

  test("does not run for a plaintext origin", async () => {
    const { probe } = fixture({ "/": { body: "home" } });
    expect(await idsFrom(context(probe, { origin: "http://shop.example.com" }))).not.toContain("A-14");
  });
});

describe("A-09 sensitive paths", () => {
  const spaShell = { body: "<html><body><div id=root></div><script src=/app.js></script></body></html>" };

  test("a catch-all SPA that answers every path with its shell reports nothing", async () => {
    const { probe } = fixture({ "/": spaShell, "/.env": spaShell, "/.git/config": spaShell, "/backup.zip": spaShell, "/admin": spaShell, "/backup": spaShell });
    const catchAll: ProbeFn = (request) => probe({ ...request, url: new URL(request.url).pathname === "/" ? request.url : `${ORIGIN}/` });
    expect((await run(context(catchAll))).findings.filter((f) => f.detectorId === "A-09")).toEqual([]);
  });

  test("a 200 with a non-matching body is not an exposure", async () => {
    const { probe } = fixture({ "/.env": { headers: TEXT, body: "nothing here" }, "/.git/config": { headers: TEXT, body: "hello" } });
    expect((await run(context(probe))).findings.filter((f) => f.detectorId === "A-09")).toEqual([]);
  });

  test("an HTML reply for a non-HTML artefact is not reported even with the signature text", async () => {
    const { probe } = fixture({ "/.env": { body: "APP_KEY=x" } });
    expect((await run(context(probe))).findings.filter((f) => f.detectorId === "A-09")).toEqual([]);
  });

  test("reports each artefact that matches its content signature", async () => {
    const { probe } = fixture({
      "/.git/config": { headers: TEXT, body: "[core]\n\tbare = false" },
      "/backup.zip": { headers: { "content-type": "application/zip" }, body: "PK\u0003\u0004data" },
      "/phpinfo.php": { body: "<title>phpinfo()</title>" },
      "/server-status": { body: "<h1>Apache Server Status for shop</h1>" },
    });
    const paths = (await run(context(probe))).findings
      .filter((f) => f.detectorId === "A-09")
      .map((f) => new URL(f.affectedUrl).pathname)
      .sort();
    expect(paths).toEqual(["/.git/config", "/backup.zip", "/phpinfo.php", "/server-status"]);
  });

  test("a login page at /admin is not a finding", async () => {
    const { probe } = fixture({ "/admin": { body: "<h1>Admin Panel</h1><form>Sign in with your password</form>" } });
    expect((await run(context(probe))).findings.filter((f) => f.detectorId === "A-09")).toEqual([]);
  });

  test("sends exactly one random-path baseline request", async () => {
    const { probe, requests } = fixture({});
    await run(context(probe, { parameters: [], entryUrls: [] }));
    const baselines = requests.filter((r) => /\/wvsprobe[a-z0-9]+$/.test(new URL(r.url).pathname));
    expect(baselines).toHaveLength(1);
  });
});

describe("A-13 admin interfaces", () => {
  const admin = (probe: ProbeFn) => context(probe, { adminUrls: [`${ORIGIN}/dashboard`] });

  test("an SPA shell served at /dashboard and at every other path is not an open admin", async () => {
    const shell = "<title>Dashboard</title><div id=root>Admin</div>";
    const { probe } = fixture({ "/dashboard": { body: shell } });
    const catchAll: ProbeFn = (request) => probe({ ...request, url: `${ORIGIN}/dashboard` });
    expect(await idsFrom(admin(catchAll))).not.toContain("A-13");
  });

  test("a page that only mentions the word dashboard is not an open admin", async () => {
    const { probe } = fixture({ "/dashboard": { body: "<h1>Our dashboard product</h1><p>Admin tools for teams</p>" } });
    expect(await idsFrom(admin(probe))).not.toContain("A-13");
  });

  test("an admin page with management controls and no login is flagged", async () => {
    const { probe } = fixture({ "/dashboard": { body: "<h1>Admin Dashboard</h1><a href=/logout>Log out</a>" } });
    expect(await idsFrom(admin(probe))).toContain("A-13");
  });
});

describe("markers", () => {
  test("a factory yields unique, seed-prefixed, alphanumeric markers", () => {
    const next = createMarkerFactory("job-1234-abcd");
    const [a, b] = [next(), next()];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^wvsprobe[a-z0-9]+$/);
    expect(a.startsWith("wvsprobejob1234a")).toBe(true);
  });

  test("createMarker never repeats", () => {
    expect(new Set(Array.from({ length: 50 }, createMarker)).size).toBe(50);
  });
});
