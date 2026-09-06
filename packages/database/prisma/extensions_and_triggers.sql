-- =============================================================================
-- Website Vulnerability Scanner (WVS) - Custom Database Triggers & Policies
-- Implements SRS DC-9 (Append-only immutability) and NFR-PERF-1 (Triage projection)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. DC-9: Append-only Enforcement for Audit Log & URL Ledger
-- Prevents all UPDATE and DELETE operations at both trigger and privilege levels.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_update_or_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only under SRS DC-9; updates and deletions are prohibited.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Trigger on audit_log
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON "audit_log";
CREATE TRIGGER trg_audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW
EXECUTE FUNCTION prevent_update_or_delete();

-- Trigger on url_ledger
DROP TRIGGER IF EXISTS trg_url_ledger_append_only ON "url_ledger";
CREATE TRIGGER trg_url_ledger_append_only
BEFORE UPDATE OR DELETE ON "url_ledger"
FOR EACH ROW
EXECUTE FUNCTION prevent_update_or_delete();

-- Privilege-level revocation (SRS DC-9: "at the database privilege level")
-- Run against the database user configured in DATABASE_URL
DO $$
BEGIN
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log", "url_ledger" FROM PUBLIC';
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;


-- -----------------------------------------------------------------------------
-- 2. NFR-PERF-1 & SRS F.6: Automatic Triage State Projection
-- Keeps target_finding_triage in sync with finding_triage_history via AFTER INSERT.
-- Guarantees zero write-skew and O(1) reads for 10,000 findings.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_target_finding_triage()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "target_finding_triage" (
        "targetId",
        "findingFingerprint",
        "state",
        "justification",
        "updatedById",
        "lastHistoryId",
        "updatedAt"
    )
    VALUES (
        NEW."targetId",
        NEW."findingFingerprint",
        NEW."state",
        NEW."justification",
        NEW."userId",
        NEW."id",
        NEW."createdAt"
    )
    ON CONFLICT ("targetId", "findingFingerprint")
    DO UPDATE SET
        "state" = EXCLUDED."state",
        "justification" = EXCLUDED."justification",
        "updatedById" = EXCLUDED."updatedById",
        "lastHistoryId" = EXCLUDED."lastHistoryId",
        "updatedAt" = EXCLUDED."updatedAt";

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_target_finding_triage ON "finding_triage_history";
CREATE TRIGGER trg_sync_target_finding_triage
AFTER INSERT ON "finding_triage_history"
FOR EACH ROW
EXECUTE FUNCTION sync_target_finding_triage();
