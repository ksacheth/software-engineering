# Append-only audit stores carry no foreign keys

`audit_log`, `url_ledger` and `finding_triage_history` store `userId`,
`targetId` and `scanJobId` as plain scalar columns with no foreign key
constraint. This looks like an oversight. It is deliberate.

DC-9 requires these tables to be append-only, enforced by `BEFORE UPDATE OR
DELETE` triggers and by privilege revocation on the `wvs_app` role. Referential
actions execute as ordinary UPDATE and DELETE statements and fire those
triggers. While the foreign keys existed, `ON DELETE CASCADE` from `target` and
`ON DELETE SET NULL` from `user` both raised the append-only exception, which
made deleting any user with triage history or any target that had been scanned
impossible — breaking F.1 account deletion, F.2 target deletion, and C.7.

Removing the constraints restores those deletions and keeps the audit trail
intact after the thing it audits is gone, which is what an audit trail is for.
The cost is that orphaned identifiers are possible and integrity is enforced in
application code and tests rather than by the database. Retention is handled by
the privileged purge procedure documented in
`packages/database/docs/retention-and-maintenance.md`, not by cascade.
