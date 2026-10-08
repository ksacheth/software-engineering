import { describe, expect, test } from "bun:test";
import type { CrawlRecord } from "@wvs/shared";

import { loadDefinitions, runPassiveDetectors } from "../src";

const catalogue = await loadDefinitions();
const ORIGIN = "https://shop.example.com";
const SPA_SHELL = '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>';

function page(path: string, body: string | null, contentType = "text/html", overrides: Partial<CrawlRecord> = {}): CrawlRecord {
  return {
    url: `${ORIGIN}${path}`,
    statusCode: 200,
    responseHeaders: { "content-type": contentType, "cache-control": "no-store" },
    responseBody: body,
    ...overrides,
  };
}

function findingsFor(id: string, ...records: CrawlRecord[]) {
  return runPassiveDetectors(catalogue, "PASSIVE", records).findings.filter(
    (f) => f.detectorId === id,
  );
}

describe("file exposure (P-21..P-24)", () => {
  test.each([
    ["P-21", page("/.git/HEAD", "ref: refs/heads/main\n", "text/plain")],
    ["P-21", page("/.git/config", "[core]\n\trepositoryformatversion = 0\n", "text/plain")],
    ["P-21", page("/.git/", "<html><title>Index of /.git</title><h1>Index of /.git</h1></html>")],
    ["P-22", page("/.env", "APP_KEY=base64:abc\nDB_PASSWORD=hunter2\n", "text/plain")],
    ["P-22", page("/web.config", '<?xml version="1.0"?><configuration><appSettings/></configuration>', "application/xml")],
    ["P-23", page("/uploads/", "<html><head><title>Index of /uploads</title></head><body><h1>Index of /uploads</h1></body></html>")],
    ["P-24", page("/index.php.bak", "<?php $db = new PDO($dsn); ?>", "application/octet-stream")],
  ])("%s flags %s", (id, record) => {
    expect(findingsFor(id, record)).toHaveLength(1);
  });

  test.each([
    ["P-21", "/.git/HEAD"],
    ["P-22", "/.env"],
    ["P-24", "/backup.zip.old"],
  ])("%s ignores a catch-all route answering %s with the app shell", (id, path) => {
    expect(findingsFor(id, page(path, SPA_SHELL))).toEqual([]);
  });

  test("P-22 shows the setting name but never its value", () => {
    const [finding] = findingsFor("P-22", page("/.env", "DB_PASSWORD=hunter2\n", "text/plain"));
    expect(finding?.evidence?.extractedSnippet).toBe("DB_PASSWORD= [redacted]");
  });

  test("a backup of a configuration file is reported once, as P-22", () => {
    const backup = page("/config.php.bak", "<?php\ndefine('DB_HOST', 'db');\n", "application/octet-stream");
    expect(findingsFor("P-22", backup)).toHaveLength(1);
    expect(findingsFor("P-24", backup)).toEqual([]);
    expect(findingsFor("P-24", page("/notes.txt.bak", "shopping list", "application/octet-stream"))).toHaveLength(1);
  });

  test("a 404 for a sensitive path is not an exposure", () => {
    expect(findingsFor("P-21", page("/.git/HEAD", "ref: refs/heads/main", "text/plain", { statusCode: 404 }))).toEqual([]);
  });
});

describe("page content (P-25..P-29, P-31)", () => {
  test("P-25 flags plaintext scripts and styles on an HTTPS page, not images", () => {
    const body = `<script src="http://cdn.example.net/a.js"></script>
      <link rel="stylesheet" href="http://cdn.example.net/a.css">
      <img src="http://cdn.example.net/a.png">`;
    expect(findingsFor("P-25", page("/", body)).map((f) => f.affectedParameter)).toEqual([
      "http://cdn.example.net/a.js",
      "http://cdn.example.net/a.css",
    ]);
  });

  test("P-26 flags a third-party script without integrity, once per script", () => {
    const body = `<script src="https://cdn.example.net/lib.js"></script>
      <script src="https://cdn.example.net/ok.js" integrity="sha384-abc" crossorigin="anonymous"></script>
      <script src="/own.js"></script>`;
    const findings = findingsFor("P-26", page("/", body), page("/about", body));
    expect(findings.map((f) => f.affectedParameter)).toEqual(["https://cdn.example.net/lib.js"]);
  });

  test.each([
    ["AWS access key", 'const key = "AKIAIOSFODNN7EXAMPLE";'],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow"],
    ["credential assignment", 'window.config = { "api_key": "sk_abcdefghijklmnopqrstuvwx" }'],
  ])("P-27 flags a %s and redacts it", (kind, body) => {
    const [finding] = findingsFor("P-27", page("/app.js", body, "application/javascript"));
    expect(finding?.affectedParameter).toBe(kind);
    expect(finding?.evidence?.extractedSnippet).toContain("[redacted]");
  });

  test("P-27 does not mistake a login form for a leaked password", () => {
    const body = '<form><input name="password" type="password"></form><script>const password = form.password.value;</script>';
    expect(findingsFor("P-27", page("/login", body))).toEqual([]);
  });

  test("P-28 reports each address once per site and skips asset names", () => {
    const body = '<a href="mailto:jane.doe@shop.example.com">Jane</a><img src="logo@2x.png"> support@example.com';
    const findings = findingsFor("P-28", page("/", body), page("/team", body));
    expect(findings.map((f) => f.affectedParameter)).toEqual(["jane.doe@shop.example.com"]);
  });

  test("P-28 does not read an SSH remote or a URL's user part as an address", () => {
    const config = '[remote "origin"]\n\turl = git@github.com:shop/site.git\n\tpushurl = ssh://deploy@git.shop.example.com/site.git\n';
    expect(findingsFor("P-28", page("/.git/config", config, "text/plain"))).toEqual([]);
    const contact = "Contact: security@shop.example.com: reply within a day";
    expect(findingsFor("P-28", page("/", contact, "text/plain")).map((f) => f.affectedParameter)).toEqual(["security@shop.example.com"]);
  });

  test("P-29 flags a cacheable account page but not one sent with no-store", () => {
    const cacheable = page("/account", "<h1>Your orders</h1>", "text/html", {
      responseHeaders: { "content-type": "text/html", "cache-control": "public, max-age=600" },
    });
    expect(findingsFor("P-29", cacheable)).toHaveLength(1);
    expect(findingsFor("P-29", page("/account", "<h1>Your orders</h1>"))).toEqual([]);
    expect(findingsFor("P-29", page("/about", "<h1>About us</h1>", "text/html", { responseHeaders: { "content-type": "text/html" } }))).toEqual([]);
  });

  test("P-31 flags a password field the browser may save, unless autocomplete says otherwise", () => {
    const body = `<form><input type="password" name="pw"></form>
      <form><input type="password" name="new" autocomplete="new-password"></form>
      <form autocomplete="off"><input type="password" name="pin"></form>`;
    expect(findingsFor("P-31", page("/login", body)).map((f) => f.affectedParameter)).toEqual(["pw"]);
  });
});

describe("security.txt (P-30)", () => {
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toUTCString();

  test("accepts a published file with Contact and a future Expires", () => {
    const file = page("/.well-known/security.txt", `Contact: mailto:security@shop.example.com\nExpires: ${validUntil}\n`, "text/plain");
    expect(findingsFor("P-30", page("/", "<p>home</p>"), file)).toEqual([]);
  });

  test.each([
    ["missing", [page("/.well-known/security.txt", "Not found", "text/plain", { statusCode: 404 })], "is not published"],
    ["answered by the app shell", [page("/.well-known/security.txt", SPA_SHELL)], "is not published"],
    ["without Contact", [page("/.well-known/security.txt", `Expires: ${validUntil}\n`, "text/plain")], "no Contact"],
    ["expired", [page("/.well-known/security.txt", "Contact: mailto:a@b.co\nExpires: 2020-01-01T00:00:00Z\n", "text/plain")], "expired"],
  ])("flags a file that is %s", (_, files, detail) => {
    const [finding] = findingsFor("P-30", page("/", "<p>home</p>"), ...files);
    expect(finding).toMatchObject({ affectedUrl: `${ORIGIN}/`, severity: "INFO" });
    expect(finding?.description).toContain(detail);
  });
});
