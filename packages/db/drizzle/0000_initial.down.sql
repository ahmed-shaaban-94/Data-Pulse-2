-- 0000_initial.down.sql
--
-- Reverses 0000_initial.sql. Applied by `pnpm migrate:down` in the runner
-- slice. Drops are issued in reverse dependency order:
--   1. Tables that hold composite FKs first (store_access, memberships).
--   2. Tables those FKs target (stores, roles).
--   3. Remaining tenant-owned + cross-cutting tables.
--   4. Catalog tables (users, tenants).
--   5. Helper function and extension.
--
-- All drops are IF EXISTS so a partial-failure rerun is safe.

BEGIN;

-- =============================================================================
-- 1. Cross-cutting + auth-flow tables (no inbound composite FKs)
-- =============================================================================
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS auth_tokens;
DROP TABLE IF EXISTS sessions;

-- =============================================================================
-- 2. Children with composite FKs
-- =============================================================================
DROP TABLE IF EXISTS store_access;
DROP TABLE IF EXISTS memberships;

-- =============================================================================
-- 3. Composite-FK targets
-- =============================================================================
DROP TABLE IF EXISTS stores;

-- =============================================================================
-- 4. Catalog tables
-- =============================================================================
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS users;

-- =============================================================================
-- 5. Helper function
-- =============================================================================
DROP FUNCTION IF EXISTS set_updated_at();

-- =============================================================================
-- 6. Extension
-- =============================================================================
-- citext is left in place; other databases on the same cluster may rely on
-- it. Uncomment the next line if you want a true full reversal:
-- DROP EXTENSION IF EXISTS citext;

COMMIT;
