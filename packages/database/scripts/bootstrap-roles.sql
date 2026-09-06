-- =============================================================================
-- Website Vulnerability Scanner (WVS) - Role Bootstrap Script
-- =============================================================================
-- Run as database cluster administrator (postgres / wvs_owner).
-- Configures the least-privilege runtime application role (wvs_app)
-- and dedicated trigger security definer role (wvs_projection).
-- =============================================================================

-- 1. Create wvs_app login role if it does not already exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_app') THEN
        CREATE ROLE wvs_app WITH LOGIN PASSWORD 'CHANGE_ME_VIA_BOOTSTRAP_TS';
    END IF;
END $$;

-- 2. Create wvs_projection NOLOGIN role for least-privilege SECURITY DEFINER triggers
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_projection') THEN
        CREATE ROLE wvs_projection NOLOGIN;
    END IF;
END $$;

-- 3. Database connection and schema usage (parameterized to current database)
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO wvs_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO wvs_app;
GRANT USAGE ON SCHEMA public TO wvs_projection;

-- 4. Standard DML grants for application operational tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wvs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wvs_app;

-- 5. Pin default privileges to current executing role (e.g. postgres / wvs_owner)
DO $$
BEGIN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wvs_app', current_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wvs_app', current_user);
END $$;

-- 6. SRS DC-9 Privilege Enforcement:
-- Immutable audit stores: wvs_app CANNOT mutate or truncate
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log", "url_ledger", "finding_triage_history" FROM wvs_app;

-- Triage projection: wvs_app has SELECT only
REVOKE INSERT, UPDATE, DELETE ON TABLE "target_finding_triage" FROM wvs_app;

-- 7. Grant least-privilege execution rights to wvs_projection for trigger-maintained projection
GRANT SELECT, INSERT, UPDATE ON "target_finding_triage" TO wvs_projection;
ALTER FUNCTION sync_target_finding_triage() OWNER TO wvs_projection;
REVOKE EXECUTE ON FUNCTION sync_target_finding_triage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_target_finding_triage() TO wvs_app;
