-- 0005_audit_retention_privileges.sql
--
-- T311 — audit-retention DB privilege hardening.
--
-- Creates a dedicated `audit_retention_worker` Postgres role and grants it
-- the minimum privileges required to run the retention sweep:
--
--   SELECT on audit_events   — needed for the WHERE predicate row scan
--   UPDATE (retention_marked_at) on audit_events — column-scoped grant;
--     the role may only write this one lifecycle-marker column.  Attempting
--     UPDATE on any other column (action, metadata, occurred_at, tenant_id,
--     store_id, …) fails with "permission denied for table audit_events".
--
-- No DELETE on audit_events is granted to any role here.  Audit-row deletion
-- remains outside the scope of this foundation (Constitution §XIII).
--
-- The role is created as NOLOGIN here.  Production environments set the
-- password and LOGIN attribute externally (via secrets management); the
-- test helper promotes the role to LOGIN for the invariant test.
--
-- Reversal: 0005_audit_retention_privileges.down.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'audit_retention_worker'
  ) THEN
    CREATE ROLE audit_retention_worker NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO audit_retention_worker;

-- SELECT is required so that the WHERE clause in the CTE-based UPDATE can
-- scan rows.  Without it the retention_marked_at column-grant alone would
-- fail with "permission denied for table" when the query touches other
-- columns in the predicate.
GRANT SELECT ON audit_events TO audit_retention_worker;

-- Column-scoped UPDATE: only the lifecycle-marker column may be written.
-- The Postgres engine rejects any UPDATE that touches a non-listed column
-- at the privilege-check stage, before RLS evaluation.
GRANT UPDATE (retention_marked_at) ON audit_events TO audit_retention_worker;

COMMIT;
