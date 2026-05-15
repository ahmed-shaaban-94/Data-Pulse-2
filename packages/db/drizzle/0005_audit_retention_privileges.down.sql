-- 0005_audit_retention_privileges.down.sql
--
-- Reverses 0005_audit_retention_privileges.sql.
-- Revokes privileges from and drops the audit_retention_worker role.

BEGIN;

REVOKE UPDATE (retention_marked_at) ON audit_events FROM audit_retention_worker;
REVOKE SELECT ON audit_events FROM audit_retention_worker;
REVOKE USAGE ON SCHEMA public FROM audit_retention_worker;

DROP ROLE IF EXISTS audit_retention_worker;

COMMIT;
