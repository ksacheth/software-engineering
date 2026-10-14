# juice-shop

[OWASP Juice Shop](https://owasp.org/www-project-juice-shop/), the test fixture
named in the SRS, deployed as a second scan target next to vuln-lab. Juice
Shop is an Angular single-page app, which makes it a coverage test rather than
a detection test.

What a scan sees: on 14 October 2026 a STANDARD scan crawled 9 URLs and
reported 5 findings (missing CSP and Referrer-Policy, a version banner, an
email address, a technology fingerprint). The app's routes live after `#`
(`/#/login`, `/#/search`), and the crawler drops the fragment when it
canonicalises a URL, so every route collapses into `/`. Endpoints that only
fire on interaction, such as product search, are never discovered, and
unlinked exposures like `/ftp` and `/metrics` are not on A-09's probe list.
Most of the shop's challenges also need a login or exploitation, which are
out of scope by design. For a target that suits the crawler, see
[mutillidae](../mutillidae/README.md).

The scanner refuses loopback and private addresses, so the shop runs on the
Oracle VPS as `http://juice.sacheth.tech` behind a DNS-only (not proxied) A
record. `apps/worker/scripts/juice-shop-e2e.ts` targets a local container with
mock crawl records; this deployment is for real scans through the dashboard.

Juice Shop is deliberately insecure. It is bound to `127.0.0.1` behind nginx
and capped at 512 MB. Stop the container when you are not testing.

## Deploy

```bash
ssh oracle 'docker run -d --name juice-shop --restart unless-stopped --memory 512m \
  -p 127.0.0.1:3001:3000 bkimminich/juice-shop'
scp nginx.conf oracle:/tmp/juice.sacheth.tech
ssh oracle 'sudo mv /tmp/juice.sacheth.tech /etc/nginx/sites-available/ &&
  sudo ln -sf /etc/nginx/sites-available/juice.sacheth.tech /etc/nginx/sites-enabled/ &&
  sudo mkdir -p /var/www/juice-shop && sudo nginx -t && sudo systemctl reload nginx'
```

DNS, in Cloudflare: an `A` record `juice` pointing at the VPS, proxy status
**DNS only**.

## Verify ownership

Add the target in the dashboard. Either method works.

DNS TXT: in Cloudflare, add a `TXT` record named `_wvs-verification.juice` whose
content is the token.

Well-known file: nginx serves `/.well-known/wvs-verification.txt` from the VPS,
without touching the container:

```bash
ssh oracle 'echo "<token>" | sudo tee /var/www/juice-shop/wvs-verification.txt'
```

## Start and stop

```bash
ssh oracle 'docker stop juice-shop'
ssh oracle 'docker start juice-shop'
```

The container is currently stopped with its restart policy set to `no`, so it
stays down across reboots. The VPS has under 1 GB of memory, so run Juice Shop
or Mutillidae, not both.

Stopping the container leaves nginx returning 502 for the host, which is
harmless. Remove the DNS record too if the shop is retired.
