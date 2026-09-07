# Target ownership verification protocol (F.2)

How a user proves administrative control of a target before any scan is
permitted (C.2). Two methods; a target uses one.

## Token

A CSPRNG value generated server-side at target registration and stored in
`Target.verificationToken`. Never derived from the target id, the organisation
id, or any other guessable input: the token is the proof, so predictability
defeats the control.

## Method: DNS_TXT

The user publishes a TXT record:

```
_wvs-verification.<host>    TXT    "<token>"
```

The value is the bare token. A dedicated `_`-prefixed subdomain is used rather
than the apex so the record cannot collide with SPF, DKIM, DMARC or any other
apex TXT record, and so verification does not have to parse a list of unrelated
strings.

Verification resolves TXT records at that name and succeeds if any value equals
the token exactly.

## Method: WELL_KNOWN

The user serves the bare token at:

```
https://<origin>/.well-known/wvs-verification.txt
```

Verification issues a GET and succeeds if the response body, trimmed, equals the
token. This is an outbound request to a user-supplied origin and therefore
passes the same address checks as any scan request, via `packages/scope-rules`.

WELL_KNOWN exists because controlling an application does not imply controlling
its DNS zone.

## Address refusal

Both at registration and again at verification, the origin's A and AAAA records
are resolved and refused if any address is private, loopback, link-local
(including the cloud metadata address) or matches the administrator blocklist.
The refusal names the triggering rule.

Registration's check is fast feedback. Verification's check is the security
boundary, because DNS can change between the two and because verification is the
moment addresses are committed to `Target.verifiedIpRanges`.

## On success

- `verificationStatus` becomes `VERIFIED`
- `verifiedAt` is set to now
- `verificationExpiresAt` is set to now + 90 days
- `verifiedIpRanges` is set to the resolved addresses as `/32` and `/128` CIDR
  strings (see ADR 0004)

Expiry is evaluated at read time from `verificationExpiresAt`; no job writes
`EXPIRED`. A target is scannable only when the status is `VERIFIED`, the expiry
is in the future, and `verifiedIpRanges` is non-empty.
