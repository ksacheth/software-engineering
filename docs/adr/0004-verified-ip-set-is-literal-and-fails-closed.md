# The verified IP set holds literal addresses and fails closed

`Target.verifiedIpRanges` records the addresses a target's origin resolved to at
the moment ownership was verified. It is the sole input to the Scope Guard's
DNS-rebinding check, so its exact meaning is a contract between F.2 (target
verification) and F.8 (the guard), owned by different people.

Entries are the **literal** resolved addresses written as `/32` and `/128` CIDR
strings. CIDR because the guard needs one parseable format; literal rather than
widened to the containing netblock because widening would authorise every other
tenant sharing a CDN or cloud host.

An **empty array means the target is not scannable**. The check fails closed. If
empty meant "skip", then any path that registered a target without populating
the field would silently disable rebinding protection, and nothing would fail
visibly until someone went looking.

When a target's addresses legitimately change — CDN reassignment, failover,
autoscaling — the scan is **refused** and the user must re-verify. The rejected
alternative was re-resolving and updating the set automatically, which is
convenient and also means a DNS rebinding attack updates the allowlist on the
attacker's behalf, defeating the control entirely.
