-- F.8 administration (ADR-0009).
--
-- Suspension is an administrator's indefinite block on sign-in. It is its own
-- column rather than a far-future lockedUntil, because a lockout follows failed
-- sign-ins and expires on its own; overloading it would let the next expiry
-- rule quietly lift a suspension nobody lifted.
ALTER TABLE "user" ADD COLUMN "suspendedAt" TIMESTAMPTZ(3);

-- Account administration is an administrative event, and F.8 wants one audit
-- record for each. ADMIN_ROLE_GRANTED is the first administrator being created
-- outside the application, from the deployment host.
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_ROLE_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_USER_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_USER_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'ADMIN_USER_UNSUSPENDED';
