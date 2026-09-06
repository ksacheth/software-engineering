-- =============================================================================
-- Website Vulnerability Scanner (WVS) - Role Bootstrap Script
-- =============================================================================
-- Run as database cluster administrator (postgres / wvs_owner).
-- Configures the least-privilege runtime application role (wvs_app).
--
-- Can accept custom password via configuration:
--   psql -U postgres -d wvs -c "SET app.password = 'your_secret';" -f scripts/bootstrap-roles.sql
-- =============================================================================

DO $$
DECLARE
    app_pwd text := coalesce(nullif(current_setting('app.password', true), ''), 'CHANGE_ME_IN_PRODUCTION');
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_app') THEN
        EXECUTE format('CREATE ROLE wvs_app WITH LOGIN PASSWORD %L', app_pwd);
    ELSE
        EXECUTE format('ALTER ROLE wvs_app WITH LOGIN PASSWORD %L', app_pwd);
    END IF;
END $$;

-- Database connection and schema usage
GRANT CONNECT ON DATABASE wvs TO wvs_app;
GRANT USAGE ON SCHEMA public TO wvs_app;

-- Standard DML grants for application operational tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wvs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wvs_app;

-- Ensure future tables created by migrations inherit standard DML
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wvs_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT USAGE, SELECT ON SEQUENCES TO wvs_app;

-- -----------------------------------------------------------------------------
-- SRS DC-9 Privilege Enforcement:
-- 1. Immutable audit stores: wvs_app CANNOT mutate or truncate
-- 2. Triage projection: wvs_app has SELECT only; writes must flow through
--    SECURITY DEFINER trigger on finding_triage_history
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log", "url_ledger", "finding_triage_history" FROM wvs_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE "target_finding_triage" FROM wvs_app;
