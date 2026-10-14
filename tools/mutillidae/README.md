# mutillidae

[OWASP Mutillidae II](https://github.com/webpwnized/mutillidae), a deliberately
vulnerable PHP and MySQL site, deployed as a second scan target next to
vuln-lab. Its pages are server-rendered and linked from an ordinary menu
(`index.php?page=...`, 125 of them from the home page), which should suit the
crawler better than Juice Shop, whose `#/` routes all collapse into `/`. No
scan of it has been run yet, so treat that as expected rather than measured.

The scanner refuses loopback and private addresses, so Mutillidae runs on the
Oracle VPS as `http://mutillidae.sacheth.tech` behind a DNS-only (not proxied)
A record. Of the upstream compose file's five containers only the web app and
its database run here; the LDAP pages fail without the directory server.

Mutillidae is deliberately insecure. Both containers are capped at 256 MB and
the web app is bound to `127.0.0.1` behind nginx. Stop them when you are not
testing.

## Deploy

```bash
ssh oracle 'docker network create mutillidae-net
  docker run -d --name mutillidae-db --network mutillidae-net --network-alias database \
    --restart unless-stopped --memory 256m webpwnized/mutillidae:database-2.12.7
  docker run -d --name mutillidae-www --network mutillidae-net \
    --restart unless-stopped --memory 256m -p 127.0.0.1:3002:80 webpwnized/mutillidae:www-2.12.7'
scp nginx.conf oracle:/tmp/mutillidae.sacheth.tech
ssh oracle 'sudo mv /tmp/mutillidae.sacheth.tech /etc/nginx/sites-available/ &&
  sudo ln -sf /etc/nginx/sites-available/mutillidae.sacheth.tech /etc/nginx/sites-enabled/ &&
  sudo mkdir -p /var/www/mutillidae && sudo nginx -t && sudo systemctl reload nginx'
```

Then create the database once. Most pages show errors until this runs:

```bash
curl -s http://mutillidae.sacheth.tech/set-up-database.php >/dev/null
```

DNS, in Cloudflare: an `A` record `mutillidae` pointing at the VPS, proxy
status **DNS only**.

## Verify ownership

Register the target with the "well-known file" method. It is a plain HTTP
fetch, so no DNS cache can get in the way:

```bash
ssh oracle 'echo "<token>" | sudo tee /var/www/mutillidae/wvs-verification.txt'
```

## Start and stop

```bash
ssh oracle 'docker stop mutillidae-www mutillidae-db'
ssh oracle 'docker start mutillidae-db mutillidae-www'
```

The VPS has under 1 GB of memory, so run Mutillidae or Juice Shop, not both.
