# Database Retention and Maintenance Policy

This document defines data retention, privileged purge operations, and audit trail lifecycles in accordance with **SRS DC-9**, **SRS F.6**, **SRS C.4**, and **SRS C.7**.

---

## 1. Retention Windows

| Table | Retention Window | Purge Mechanism | Compliance Clause |
| :--- | :--- | :--- | :--- |
| `url_ledger` | **90 Days** (default) | Privileged batch purge script (`scripts/purge-retention.ts`) | SRS C.4, C.7 |
| `finding_evidence` | **90 Days** (default) | Soft-purge / payload nullification (`isPurged = true`) | SRS F.6 |
| `audit_log` | **Indefinite** | Never purged via routine maintenance | SRS DC-9 |
| `finding_triage_history` | **Indefinite** | Never purged; retained as immutable compliance record | SRS DC-9 |

---

## 2. Privileged Purge Operation (`url_ledger` & `finding_evidence`)

Because `url_ledger` is protected by `trg_url_ledger_append_only`, standard `DELETE` statements are prohibited by design.

Routine automated pruning is executed through the privileged maintenance script:
```bash
bun run --cwd packages/database purge:retention -- --retention-days 90
```

### Safety & Audit Invariants:
1. **Cluster Administrator Required:** The script connects via `MIGRATION_DATABASE_URL` as `postgres` / `wvs_owner`. The runtime `wvs_app` role cannot perform this operation.
2. **Transaction Isolation:** The operation runs within a single serial transaction:
   - Records an immutable `EVIDENCE_PURGED` entry in `audit_log` with the cutoff timestamp and job metadata.
   - Disables `trg_url_ledger_append_only` inside the transaction.
   - Deletes records where `timestamp < NOW() - INTERVAL '90 days'`.
   - Re-enables `trg_url_ledger_append_only`.
   - Updates `finding_evidence` records beyond `expiresAt`, setting payloads to `NULL` and `isPurged = true`.
   - Commits transaction.

---

## 3. Triage History Persistence and Target Deletion Lifecycle

- `finding_triage_history` retains records linked by scalar identifiers (`targetId`, `findingFingerprint`, `userId`).
- When a `target` is deleted, its live operational data (e.g. `scan_job`, `crawled_page`, `target_finding_triage` projection) is cascade-deleted.
- The historical audit trail in `finding_triage_history` survives intact under DC-9.
- **Target Re-Registration Semantics:** If an organization deletes a target and subsequently re-registers the same origin URL, a new `targetId` is generated. Historical triage entries from the prior target lifecycle remain archived under the previous `targetId` and are not automatically carried forward. This prevents cross-tenant or re-registration state contamination while guaranteeing non-repudiation for prior scan audits.
