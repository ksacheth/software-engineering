# Better Auth over hand-rolled JWT and TOTP

The work-split specification assigned F.1 as NestJS with hand-issued JWTs,
bcrypt password hashing, and TOTP built on `speakeasy` and `qrcode`. We built it
on Express (running on Bun) with Better Auth instead: opaque session cookies
backed by a `session` table, Better Auth's default scrypt hashing, and its
`twoFactor` plugin for TOTP secrets, QR provisioning and backup codes.

Hand-rolling was a real alternative and would have demonstrated the primitives
directly, which has some value in an academic project. We traded that for a
maintained implementation because the surface we needed — TOTP enrolment and
challenge, backup codes, lockout counters, organisation membership, session
revocation — is large, security-critical, and easy to get subtly wrong. Server
sessions also revoke immediately, which stateless JWTs cannot without a
denylist that reintroduces the state JWTs were meant to avoid.

The specification documents should be read as superseded on this point.
