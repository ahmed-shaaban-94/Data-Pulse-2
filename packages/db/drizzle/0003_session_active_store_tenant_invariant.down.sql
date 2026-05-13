-- Down migration for 0003_session_active_store_tenant_invariant.sql
-- Removes the I-4 trigger. Data is left as-is (repaired rows stay repaired).
DROP TRIGGER IF EXISTS sessions_active_store_tenant_check ON sessions;
DROP FUNCTION IF EXISTS sessions_check_active_store_tenant();
