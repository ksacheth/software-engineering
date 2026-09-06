-- =============================================================================
-- Website Vulnerability Scanner (WVS) - Role Bootstrap Script (SRS DC-9)
-- Must be executed by superuser/cluster admin (e.g. postgres) during setup.
-- =============================================================================

-- 1. Create runtime application role (wvs_app) with restricted privileges
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_app') THEN
        CREATE ROLE wvs_app WITH LOGIN PASSWORD 'wvs_app_secure_password';
    END IF;
END $$;

-- 2. Grant basic connection & schema usage
GRANT CONNECT ON DATABASE wvs TO wvs_app;
GRANT USAGE ON SCHEMA public TO wvs_app;

-- 3. Grant standard DML on all normal tables and sequences
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wvs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wvs_app;

-- Ensure future tables created by migrations also inherit this baseline
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wvs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wvs_app;

-- 4. SRS DC-9: Strictly enforce append-only at the database privilege level
-- Revoke UPDATE, DELETE, and TRUNCATE on audit and history tables
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log", "url_ledger", "finding_triage_history" FROM wvs_app;

-- Ensure wvs_app cannot alter triggers or drop tables
ALTER TABLE "audit_log" OWNER TO postgres;
ALTER TABLE "url_ledger" OWNER TO postgres;
ALTER TABLE "finding_triage_history" OWNER TO postgres;
