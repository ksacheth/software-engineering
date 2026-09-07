# Address and blocklist matching lives in one shared package

F.2 must refuse targets resolving to private, loopback, link-local or
cloud-metadata addresses at registration and verification. F.8's Scope Guard
must refuse the same addresses on every outbound request during a scan. These
are owned by different people, and a second implementation would drift.

The matching logic lives in `packages/scope-rules`: a pure package with no
network access, no database access and no framework dependency, exporting
address classification and blocklist matching over an already-resolved IP.
F.2 imports it; the Scope Guard imports it.

Code ownership sits with F.2 because F.2 needs it first. Test cases are
contributed by whoever owns the Scope Guard, since the interesting cases are
bypasses rather than happy paths: IPv4-mapped IPv6 (`::ffff:127.0.0.1`), IPv6
loopback and unique-local, all of RFC1918, `169.254.0.0/16` including the cloud
metadata address, and hostnames that resolve to any of the above.

The rejected alternative was for the Scope Guard to call F.2's API per request.
That puts a network round trip and a possible partition inside a safety kernel
that runs thousands of times per scan.
