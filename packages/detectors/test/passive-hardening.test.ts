import { describe, expect, test } from "bun:test";
import type { CertificateFacts, CrawlRecord, TlsFacts } from "@wvs/shared";

import { fingerprint, loadDefinitions, runPassiveDetectors, runTlsDetectors, toPageView, type PassiveDetector } from "../src";

const catalogue = await loadDefinitions();
const ORIGIN = "https://shop.example.com";

function page(path: string, body: string | null, headers: Record<string, string> = {}, overrides: Partial<CrawlRecord> = {}): CrawlRecord {
  return {
    url: `${ORIGIN}${path}`,
    statusCode: 200,
    responseHeaders: { "content-type": "text/html", "cache-control": "no-store", ...headers },
    responseBody: body,
    ...overrides,
  };
}

const run = (...records: CrawlRecord[]) => runPassiveDetectors(catalogue, "PASSIVE", records);
const findingsFor = (id: string, ...records: CrawlRecord[]) => run(...records).findings.filter((f) => f.detectorId === id);

describe("secrets never reach evidence (ADR-0010)", () => {
  test("cookie findings keep the name and attributes but not the value", () => {
    const record = page("/", "<p>hi</p>", { "set-cookie": "sid=supersecrettoken123; Path=/; HttpOnly" });
    for (const id of ["P-07", "P-09"]) {
      const [finding] = findingsFor(id, record);
      expect(JSON.stringify(finding?.evidence)).not.toContain("supersecrettoken123");
      expect(finding?.evidence?.extractedSnippet).toBe("sid=[redacted]; Path=/; HttpOnly");
      expect(finding?.evidence?.responseHeaders).toEqual({ "set-cookie": "sid=[redacted]; Path=/; HttpOnly" });
    }
  });

  test("cookie evidence drops a quoted value's tail and non-standard attributes", () => {
    const record = page("/", "<p>hi</p>", { "set-cookie": 'sid="abc;tailsecret"; Path=/; Foo=attrsecret' });
    const [finding] = findingsFor("P-07", record);
    expect(finding?.evidence?.extractedSnippet).toBe("sid=[redacted]; Path=/");
  });

  test("header findings store only the header concerned", () => {
    const record = page("/", "<p>hi</p>", {
      "set-cookie": "sid=supersecrettoken123; Secure",
      authorization: "Bearer topsecret",
    });
    const [finding] = findingsFor("P-03", record);
    expect(finding?.evidence?.responseHeaders).toEqual({ "x-content-type-options": "(absent)" });
    expect(JSON.stringify(finding?.evidence)).not.toContain("supersecrettoken123");
  });

  test("P-22 redacts every line of a multi-line PHP match", () => {
    const body = "<?php\n// Password: hunter2\ndefine('DB_PASSWORD','hunter2');\ndefine('DB_HOST', 'db');\n";
    const [finding] = findingsFor("P-22", page("/wp-config.php.bak", body, { "content-type": "text/plain" }));
    expect(finding?.evidence?.extractedSnippet).toBeDefined();
    expect(finding?.evidence?.extractedSnippet).not.toContain("hunter2");
  });

  test("P-22 does not pull the next line's value into a .env snippet", () => {
    const [finding] = findingsFor("P-22", page("/.env", "APP_KEY=\nDB_PASSWORD=hunter2\n", { "content-type": "text/plain" }));
    expect(JSON.stringify(finding?.evidence)).not.toContain("hunter2");
  });

  test("P-24 stores no body content", () => {
    const body = "INSERT INTO users VALUES ('admin', 'hunter2');\n";
    const [finding] = findingsFor("P-24", page("/dump.sql.old", body, { "content-type": "application/octet-stream" }));
    expect(finding).toBeDefined();
    expect(JSON.stringify(finding?.evidence)).not.toContain("hunter2");
    expect(finding?.evidence?.extractedSnippet).toContain("/dump.sql.old");
  });

  test("P-31 strips the value attribute of a prefilled password field", () => {
    const body = '<form><input type="password" name="pw" value="hunter2"></form>';
    const [finding] = findingsFor("P-31", page("/settings", body));
    expect(finding?.evidence?.extractedSnippet).toContain('name="pw"');
    expect(finding?.evidence?.extractedSnippet).not.toContain("hunter2");
  });

  test("P-31 evidence keeps only descriptive attributes", () => {
    const body = '<form><input type="password" name="pw" data-initial="hunter2" placeholder="hunter2"></form>';
    const [finding] = findingsFor("P-31", page("/settings", body));
    expect(finding?.evidence?.extractedSnippet).toBe('<input type="password" name="pw">');
  });
});

describe("hostile bodies are scanned quickly", () => {
  const KB200 = 200 * 1024;
  const hostile: Array<[string, string]> = [
    ["dotted runs", "a.".repeat(KB200 / 2)],
    ["newlines", "\n".repeat(KB200)],
    ["indented at", "\n at (/ ".repeat(KB200 / 8)],
    ["at-lines", "\n  at a.b(".repeat(KB200 / 10)],
    ["php warnings", "<b>Warning</b>:".repeat(KB200 / 15)],
    ["dotnet frames", "   at a(".repeat(KB200 / 8)],
    ["at signs", "a@a.".repeat(KB200 / 4)],
  ];

  test.each(hostile)("P-28 and P-20 finish fast on %s", (_, body) => {
    const started = performance.now();
    run(page("/", body, { "content-type": "text/html" }, { statusCode: 500 }));
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the scanned body is capped", () => {
    const view = toPageView(page("/", "x".repeat(2_000_000)));
    expect(view.body!.length).toBeLessThan(1_000_000);
  });

  test.each([
    ["/.svn/entries", "1" + "\n".repeat(KB200)],
    ["/application.yml", "\n".repeat(KB200)],
  ])("file-exposure signatures finish fast on %s", (path, body) => {
    const started = performance.now();
    run(page(path, body, { "content-type": "text/plain" }));
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the Subversion signature still matches a real entries file", () => {
    expect(findingsFor("P-21", page("/.svn/entries", "10\n\ndir\n0\n", { "content-type": "text/plain" }))).toHaveLength(1);
  });
});

describe("false positives", () => {
  test("a jQuery plugin is not the core library", () => {
    const body = `<script src="/js/jquery.validate.min.js"></script>
      <script src="/js/jquery-migrate-3.4.0.min.js"></script>
      <script src="/js/bootstrap-datepicker-1.9.0.js"></script>
      <script src="/js/moment-timezone-with-data-0.5.34.js"></script>
      <script src="/js/jquery-ui-1.13.2.min.js"></script>`;
    expect(fingerprint(toPageView(page("/", body))).map((t) => [t.name, t.version])).toEqual([["jQuery UI", "1.13.2"]]);
  });

  test("P-27 ignores a public Google key and placeholder assignments", () => {
    const body = `key=AIza${"B".repeat(35)}; var a = { api_key: "your_api_key_here_please" }; var b = { secret_key: "aaaaaaaaaaaaaaaaaaaaaaaa" }`;
    expect(findingsFor("P-27", page("/app.js", body, { "content-type": "application/javascript" }))).toEqual([]);
  });

  test("P-29 does not treat a Set-Cookie as a sensitive signal", () => {
    const record = page("/about", "<p>about</p>", { "set-cookie": "_ga=1", "cache-control": "" });
    expect(findingsFor("P-29", record)).toEqual([]);
  });

  test("P-20 ignores a tutorial quoting a trace, but not a 500 or a platform error page", () => {
    const trace = "<pre>Traceback (most recent call last):\n  File x</pre>";
    expect(findingsFor("P-20", page("/blog/python", trace))).toEqual([]);
    expect(findingsFor("P-20", page("/blog/python", trace, {}, { statusCode: 500 }))).toHaveLength(1);
    expect(findingsFor("P-20", page("/x", "<h1>Whoops, looks like something went wrong.</h1>"))).toHaveLength(1);
  });

  test("P-20 reports rendered PHP and database errors at any status", () => {
    const php = "<br />\n<b>Warning</b>:  Undefined variable $x in <b>/var/www/a.php</b> on line <b>3</b><br />";
    const sql = "<p>You have an error in your SQL syntax; check the manual near '1'</p>";
    expect(findingsFor("P-20", page("/item", php))).toHaveLength(1);
    expect(findingsFor("P-20", page("/item", sql))).toHaveLength(1);
    expect(findingsFor("P-20", page("/missing", "<pre>ActionController::RoutingError</pre>", {}, { statusCode: 404 }))).toHaveLength(1);
  });

  test("P-20 keeps only the first trace line", () => {
    const body = "Traceback (most recent call last):\n  File \"/srv/secret/app.py\", line 3\n";
    const [finding] = findingsFor("P-20", page("/", body, {}, { statusCode: 500 }));
    expect(finding?.evidence?.extractedSnippet).toBe("Traceback (most recent call last):");
  });

  test("P-30 is not reported when security.txt was never requested", () => {
    expect(findingsFor("P-30", page("/app", "<p>app</p>"))).toEqual([]);
  });
});

describe("CSP and frame headers", () => {
  const secure = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=()" };
  const p01 = (csp: string) => findingsFor("P-01", page("/", "<p>x</p>", { ...secure, "content-security-policy": csp }));

  test("a nonce policy with strict-dynamic and legacy fallbacks is strong", () => {
    expect(p01("script-src 'nonce-abc' 'strict-dynamic' 'unsafe-inline' https: http:; object-src 'none'")).toEqual([]);
    expect(p01("script-src 'sha256-abc' 'unsafe-inline'")).toEqual([]);
  });

  test("unsafe-inline without a nonce is still weak, and a strong second policy wins", () => {
    expect(p01("script-src 'self' 'unsafe-inline'")).toHaveLength(1);
    expect(p01("script-src 'self' 'unsafe-inline', script-src 'self'")).toEqual([]);
    expect(p01("script-src 'self', script-src 'unsafe-eval'")).toEqual([]);
  });

  test("comma-joined duplicate X-Frame-Options values are valid", () => {
    const headers = { ...secure, "content-security-policy": "default-src 'self'", "x-frame-options": "SAMEORIGIN, SAMEORIGIN" };
    expect(findingsFor("P-04", page("/", "<p>x</p>", headers))).toEqual([]);
  });
});

describe("TLS key size", () => {
  const facts = (keyBits: number | null): TlsFacts => ({
    origin: ORIGIN,
    hostname: "shop.example.com",
    acceptedLegacyProtocols: [],
    acceptedWeakCipher: null,
    certificate: {
      subjectAltNames: ["shop.example.com"],
      validFrom: new Date(Date.now() - 86_400_000).toISOString(),
      validTo: new Date(Date.now() + 300 * 86_400_000).toISOString(),
      hostnameMatches: true,
      selfSigned: false,
      trustError: null,
      signatureAlgorithm: "sha256WithRSAEncryption",
      keyType: "RSA",
      keyBits,
    } satisfies CertificateFacts,
  });

  test.each([0, null])("an unknown key size (%p) is not a weak key", (bits) => {
    expect(runTlsDetectors(catalogue, "PASSIVE", facts(bits)).findings).toEqual([]);
  });

  test("a known small key is still flagged", () => {
    expect(runTlsDetectors(catalogue, "PASSIVE", facts(1024)).findings.map((f) => f.detectorId)).toEqual(["P-16"]);
  });
});

describe("runner setup failures", () => {
  test("an unparseable URL is recorded and the other pages are still judged", () => {
    const result = run({ url: "not a url" }, page("/", "<p>x</p>"));
    expect(result.failures).toEqual([expect.objectContaining({ affectedUrl: "not a url" })]);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("a detector without a definition is recorded, not thrown", () => {
    const orphan: PassiveDetector = { id: "P-99", inspect: () => [] };
    const result = runPassiveDetectors(catalogue, "PASSIVE", [page("/", "<p>x</p>")], { page: [orphan], site: [] });
    expect(result.failures).toEqual([expect.objectContaining({ detectorId: "P-99" })]);
  });
});
