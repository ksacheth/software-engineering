# vuln-lab

A deliberately weak website for scanning end to end. The scanner refuses
loopback and private addresses, so the lab has to run on a public host with a
DNS-only (not proxied) A record. It runs on the Oracle VPS as
`http://vuln-lab.sacheth.tech`.

The weaknesses are imitations: no file is read, no query runs and no template
is evaluated. Stop the container when you are not testing.

## Detector map

| Detector | Where |
|---|---|
| P-01, P-03..P-06, A-06 | Every HTML page sends no security headers |
| P-07, P-08, P-09 | `PHPSESSID` cookie with no flags |
| P-10 | `lab_theme` cookie scoped to `Domain=sacheth.tech` |
| P-17 | `Server: Apache/2.4.49`, `X-Powered-By: PHP/5.6.40` |
| P-18 | Same headers, `/static/js/jquery-1.12.4.min.js`, `generator` WordPress 4.7 |
| P-20 | `/error` (Python traceback on a 500), `/legacy.php` (PHP fatal), `/product?id='` |
| P-21 | `/.git/HEAD`, `/.git/config`, `/.svn/wc.db`, `/.hg/requires` |
| P-22 | `/.env`, `/web.config`, `/wp-config.php`, `/application.yml`, `/appsettings.json`, `/docker-compose.yml`, `/.npmrc` |
| P-23 | `/backup/` |
| P-24 | `/config.php.bak`, `/backup/db.sql.old`, `/index.php~` |
| P-26 | `code.jquery.com` script without `integrity` |
| P-27 | AWS key and `api_key` on `/`, `/keys/deploy_key` |
| P-28 | Contact address on `/` |
| P-29 | `/login`, `/account` with no `Cache-Control` |
| P-30 | No `/.well-known/security.txt` |
| P-31 | `/login` password field without `autocomplete` |
| A-01 | `/search?q=` echoed raw |
| A-02, A-03 | `/product?id=` |
| A-04 | `/go?url=` |
| A-05 | Any `Origin` is reflected with credentials |
| A-07 | `OPTIONS` advertises PUT, DELETE, TRACE |
| A-09, A-13 | `/admin`, `/administrator`, `/.git/config`, `/.env`, `/backup`, `/backup.zip`, `/config.php.bak`, `/phpinfo.php`, `/server-status` |
| A-10 | `/login` POST form without a CSRF token |
| A-11 | `/download?file=` |
| A-12 | `/greet?name=` |

Not covered: P-02, P-25, A-14 and P-11..P-16 need an HTTPS origin; A-08 never
reaches the lab because nginx routes an unknown `Host` to the default site.

## Deploy

```bash
scp server.ts Dockerfile nginx.conf oracle:vuln-lab/
ssh oracle 'cd ~/vuln-lab && docker build -t vuln-lab . && docker rm -f vuln-lab;
  docker run -d --name vuln-lab --restart unless-stopped --memory 96m --read-only \
    -p 127.0.0.1:8090:8090 -v "$HOME/vuln-lab/data:/data:ro" vuln-lab'
```

nginx: `nginx.conf` goes in `/etc/nginx/sites-available/` and is linked from
`sites-enabled/`.

## Verify ownership

Add the target in the dashboard with the "well-known file" method, then put the
token on the VPS. The lab serves it at `/.well-known/wvs-verification.txt`:

```bash
ssh oracle 'echo "<token>" > ~/vuln-lab/data/wvs-verification.txt'
```
