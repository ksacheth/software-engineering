/**
 * A deliberately weak website for exercising the scanner end to end.
 *
 * Every page exists to trip one or more detectors (see README.md for the map).
 * The weaknesses are imitations: nothing here reads files, runs queries or
 * evaluates templates. A "path traversal" returns a canned passwd file and the
 * "template injection" only multiplies two integers, so the lab looks
 * vulnerable to the scanner without being exploitable by anyone else.
 */

const PORT = Number(process.env.PORT ?? 8090);
const TOKEN_FILE = process.env.TOKEN_FILE ?? "/data/wvs-verification.txt";

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function originOf(req: Request, url: URL): string {
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${req.headers.get("host") ?? url.host}`;
}

/** The host one label up, for a cookie scoped wider than the site (P-10). */
function parentDomain(host: string): string | null {
  const labels = host.split(":")[0].split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : null;
}

/** An HTML page with no security headers and loose session cookies. */
function html(req: Request, body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.append("set-cookie", `PHPSESSID=${crypto.randomUUID()}; Path=/`);
  const parent = parentDomain(req.headers.get("host") ?? "");
  if (parent) headers.append("set-cookie", `lab_theme=dark; Domain=${parent}; Path=/`);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">${body}</html>`,
    { ...init, headers },
  );
}

function text(body: string | Uint8Array, type = "text/plain; charset=utf-8", status = 200) {
  return new Response(body, { status, headers: { "content-type": type } });
}

const notFound = (req: Request) =>
  html(req, `<title>Not found</title></head><body><h1>404</h1><p>Nothing here.</p></body>`, {
    status: 404,
  });

// --- Pages ------------------------------------------------------------------

const index: Handler = (req, url) =>
  html(
    req,
    `<title>Vuln Lab Shop</title>
<meta name="generator" content="WordPress 4.7">
<link rel="canonical" href="http://${req.headers.get("host") ?? url.host}/">
<link rel="stylesheet" href="http://code.jquery.com/ui/1.12.1/themes/base/jquery-ui.css">
<script src="/static/js/jquery-1.12.4.min.js"></script>
<script src="https://code.jquery.com/jquery-1.12.4.min.js"></script>
</head><body>
<h1>Vuln Lab Shop</h1>
<p>A test target for the website vulnerability scanner. Do not use real data here.</p>
<ul>
  <li><a href="/search?q=hello">Search</a></li>
  <li><a href="/product?id=1">Product 1</a></li>
  <li><a href="/download?file=report.txt">Download report</a></li>
  <li><a href="/greet?name=world">Greeting</a></li>
  <li><a href="/go?url=%2F">Home via redirect</a></li>
  <li><a href="/login">Sign in</a></li>
  <li><a href="/account">My account</a></li>
  <li><a href="/admin">Admin</a></li>
  <li><a href="/error">Report a problem</a></li>
  <li><a href="/legacy.php">Legacy page</a></li>
  <li><a href="/backup/">Backups</a></li>
</ul>
<p>Contact: webmaster@vuln-lab.sacheth.tech</p>
<!-- TODO remove before launch: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE -->
<script>var config = { api_key: "Zq8vN3rT6wY1pL5sK9dF2hJ4mX7cB0aE" };</script>
</body>`,
  );

const search: Handler = (req, url) => {
  // A-01: the query is echoed without encoding.
  const q = url.searchParams.get("q") ?? "";
  return html(req, `<title>Search</title></head><body><h1>Search</h1><p>Results for: ${q}</p><p>No results.</p></body>`);
};

const product: Handler = (req, url) => {
  const id = url.searchParams.get("id") ?? "";
  // A-02: a stray quote "breaks" the query and leaks the driver error (also P-20).
  if (id.includes("'")) {
    return html(
      req,
      `<title>Error</title></head><body><p>You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near ''' at line 1</p></body>`,
      { status: 500 },
    );
  }
  // A-03: "1 OR 1=1" behaves like "1", "1 AND 1=2" returns nothing.
  const always = /^\d+\s+or\s+1=1/i.test(id);
  const never = /\band\s+1=2/i.test(id);
  if (never || !(always || /^\d+$/.test(id))) {
    return html(req, `<title>Product</title></head><body><h1>Product</h1><p>No products found.</p></body>`);
  }
  return html(
    req,
    `<title>Product</title></head><body><h1>Product</h1><p>Lab Widget</p><p>Price: 19.99</p><p>In stock: 42</p></body>`,
  );
};

const PASSWD = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
`;

const download: Handler = (req, url) => {
  const file = url.searchParams.get("file") ?? "";
  // A-11: imitated. The canned passwd stands in for a real read.
  if (file.includes("etc/passwd")) return text(PASSWD);
  if (file === "report.txt") return text("Quarterly report: all systems nominal.\n");
  return notFound(req);
};

const greet: Handler = (req, url) => {
  // A-12: imitated. Only "{{a*b}}", "${a*b}" and "#{a*b}" with integers are
  // "evaluated", and the result is escaped, so nothing actually runs.
  const name = (url.searchParams.get("name") ?? "").replace(
    /(?:\{\{|\$\{|#\{)\s*(\d+)\s*\*\s*(\d+)\s*\}{1,2}/g,
    (_, a, b) => String(Number(a) * Number(b)),
  );
  return html(req, `<title>Greeting</title></head><body><h1>Hello, ${escape(name)}!</h1></body>`);
};

const go: Handler = (_req, url) =>
  // A-04: follows any destination it is given.
  new Response(null, { status: 302, headers: { location: url.searchParams.get("url") ?? "/" } });

const login: Handler = (req) => {
  // A-10: POST form without a CSRF token. P-31: password field allows autofill.
  // P-29: no Cache-Control on a page with a password field.
  const failed = req.method === "POST" ? `<p>Invalid credentials.</p>` : "";
  return html(
    req,
    `<title>Sign in</title></head><body><h1>Sign in</h1>${failed}
<form method="POST" action="/login">
  <label>Email <input type="text" name="email"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Sign in</button>
</form></body>`,
  );
};

const account: Handler = (req) =>
  html(req, `<title>My account</title></head><body><h1>My account</h1><p>Order history and saved cards.</p></body>`);

const admin: Handler = (req) =>
  // A-09 / A-13: an admin heading and controls, with no sign-in in the way.
  html(
    req,
    `<title>Admin Panel</title></head><body><h1>Admin Panel</h1>
<ul><li>Manage users</li><li>Site settings</li><li>Roles and permissions</li></ul>
<a href="/admin/logout">Logout</a></body>`,
  );

const error: Handler = (req) =>
  // P-20: a stack trace on a 500.
  html(
    req,
    `<title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1><pre>Traceback (most recent call last):
  File "/srv/app/views.py", line 42, in report
    handle(request)
ValueError: invalid literal for int() with base 10: 'abc'</pre></body>`,
    { status: 500 },
  );

const legacy: Handler = (req) =>
  // P-20: PHP fatal error, which counts at any status.
  html(
    req,
    `<title>Legacy</title></head><body><br><b>Fatal error</b>:  Uncaught Error: Call to undefined function mysql_connect() in /var/www/html/legacy.php on line <b>12</b><br></body>`,
  );

const backupListing: Handler = (req) =>
  // P-23 / A-09: an autoindex page.
  html(
    req,
    `<title>Index of /backup</title></head><body><h1>Index of /backup</h1><pre>
<a href="/">../</a>
<a href="/backup.zip">backup.zip</a>
<a href="/backup/db.sql.old">db.sql.old</a>
<a href="/index.php~">index.php~</a>
<a href="/config.php.bak">config.php.bak</a>
</pre></body>`,
  );

const phpinfo: Handler = (req) =>
  html(req, `<title>phpinfo()</title></head><body><h1>PHP Version 5.6.40</h1><table><tr><td>System</td><td>Linux vuln-lab</td></tr></table></body>`);

const serverStatus: Handler = (req) =>
  html(req, `<title>Apache Status</title></head><body><h1>Apache Server Status for vuln-lab</h1><p>Server Version: Apache/2.4.49 (Unix)</p></body>`);

const verification: Handler = async (req) => {
  // Ownership proof for the scanner (WELL_KNOWN method). Written on the VPS.
  const file = Bun.file(TOKEN_FILE);
  return (await file.exists()) ? text(await file.text()) : notFound(req);
};

// --- Exposed files ----------------------------------------------------------

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const sqlite = new TextEncoder().encode("SQLite format 3\0" + "\0".repeat(84));

const files: Record<string, () => Response> = {
  // P-21 / A-09
  "/.git/HEAD": () => text("ref: refs/heads/main\n"),
  "/.git/config": () =>
    text(`[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:vuln-lab/shop.git\n`),
  "/.svn/wc.db": () => text(sqlite, "application/octet-stream"),
  "/.hg/requires": () => text("dotencode\nfncache\nrevlogv1\nstore\n"),
  // P-22 / A-09
  "/.env": () => text("APP_ENV=production\nDB_HOST=db.internal\nDB_PASSWORD=lab-not-a-real-password\n"),
  "/web.config": () =>
    text(`<?xml version="1.0"?>\n<configuration>\n  <connectionStrings>\n    <add name="Shop" connectionString="Server=db;Database=shop" />\n  </connectionStrings>\n</configuration>\n`, "application/xml"),
  "/wp-config.php": () =>
    text(`<?php\ndefine('DB_NAME', 'shop');\ndefine('DB_USER', 'shop');\n$table_prefix = 'wp_';\n`),
  "/application.yml": () => text("spring:\n  datasource:\n    url: jdbc:mysql://db/shop\n", "text/yaml"),
  "/appsettings.json": () =>
    text(`{\n  "ConnectionStrings": { "Shop": "Server=db;Database=shop" },\n  "Logging": { "LogLevel": { "Default": "Information" } }\n}\n`, "application/json"),
  "/docker-compose.yml": () => text("services:\n  db:\n    image: mysql:5.7\n", "text/yaml"),
  "/.npmrc": () => text("//registry.npmjs.org/:_authToken=00000000-0000-0000-0000-000000000000\n"),
  // P-24 / A-09
  "/config.php.bak": () => text(`<?php\n$db_user = 'shop';\ndefine('DB_HOST', 'db');\n`, "application/octet-stream"),
  "/backup/db.sql.old": () => text("-- MySQL dump 10.13\nCREATE TABLE users (id int);\n", "application/octet-stream"),
  "/index.php~": () => text(`<?php\ninclude 'config.php';\n`, "application/octet-stream"),
  "/backup.zip": () => text(zip, "application/zip"),
  // P-27: a private key left in the web root
  "/keys/deploy_key": () =>
    text("-----BEGIN RSA PRIVATE KEY-----\n(lab placeholder, not a key)\n-----END RSA PRIVATE KEY-----\n"),
  // P-18: the file a vulnerable jQuery would be
  "/static/js/jquery-1.12.4.min.js": () => text("/*! jQuery v1.12.4 (lab stub) */\n", "application/javascript"),
};

// Listed in the sitemap so the crawler visits them; nothing links to them.
const HIDDEN = Object.keys(files).filter((p) => !p.startsWith("/static/") && !p.startsWith("/backup/"));

const robots: Handler = (req, url) =>
  text(`User-agent: *\nAllow: /\nSitemap: ${originOf(req, url)}/sitemap.xml\n`);

const sitemap: Handler = (req, url) => {
  const origin = originOf(req, url);
  const locs = ["/", ...HIDDEN, "/phpinfo.php", "/server-status"]
    .map((p) => `  <url><loc>${origin}${p}</loc></url>`)
    .join("\n");
  return text(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>\n`,
    "application/xml",
  );
};

const routes: Record<string, Handler> = {
  "/": index,
  "/search": search,
  "/product": product,
  "/download": download,
  "/greet": greet,
  "/go": go,
  "/login": login,
  "/account": account,
  "/admin": admin,
  "/administrator": admin,
  "/error": error,
  "/legacy.php": legacy,
  "/backup": backupListing,
  "/backup/": backupListing,
  "/phpinfo.php": phpinfo,
  "/server-status": serverStatus,
  "/robots.txt": robots,
  "/sitemap.xml": sitemap,
  "/.well-known/wvs-verification.txt": verification,
  // P-30: /.well-known/security.txt is deliberately absent.
};

/** Applied to every response: version banners (P-17, P-18) and a CORS policy
 *  that trusts any origin with credentials (A-05). */
function weaken(req: Request, res: Response): Response {
  res.headers.set("server", "Apache/2.4.49 (Unix)");
  res.headers.set("x-powered-by", "PHP/5.6.40");
  const origin = req.headers.get("origin");
  if (origin) {
    res.headers.set("access-control-allow-origin", origin);
    res.headers.set("access-control-allow-credentials", "true");
  }
  return res;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // A-07: advertises dangerous methods.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "GET, HEAD, POST, PUT, DELETE, TRACE, OPTIONS" },
    });
  }
  const file = files[url.pathname];
  if (file) return file();
  const route = routes[url.pathname];
  return route ? route(req, url) : notFound(req);
}

Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: async (req) => weaken(req, await handle(req)),
});

console.log(`[vuln-lab] listening on :${PORT}`);
