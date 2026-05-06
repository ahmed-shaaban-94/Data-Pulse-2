-- 0001_pos_operator_identity.down.sql
--
-- Reverses 0001_pos_operator_identity.sql. Issued in reverse dependency
-- order:
--   1. Drop the FK from auth_tokens.device_id (so devices can be dropped).
--   2. Delete `pos_operator`-scope rows from auth_tokens — required because
--      the original XOR CHECK (re-added in step 3) forbids rows where both
--      `user_id` and `device_id` are populated. This is a destructive
--      rollback step: any active POS operator session tokens are invalidated.
--      Reviewers rolling back PR-3 in production should expect this and plan
--      the rollback in a maintenance window.
--   3. Restore the original auth_tokens XOR CHECK (so the table's invariants
--      match 0000_initial again).
--   4. Drop the devices table (with its RLS, policy, trigger, and indexes).
--   5. Drop users.clerk_user_id index, CHECK, and column.
--
-- All drops are IF EXISTS so a partial-failure rerun is safe.

BEGIN;

-- =============================================================================
-- 1. auth_tokens.device_id FK
-- =============================================================================
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_device_fk;

-- =============================================================================
-- 2. Destructive cleanup: pos_operator rows would violate the restored XOR
-- =============================================================================
DELETE FROM auth_tokens WHERE scope = 'pos_operator';

-- =============================================================================
-- 3. auth_tokens — restore the original XOR CHECK
-- =============================================================================
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_principal_by_scope;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_principal_xor
  CHECK ((user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1);

-- =============================================================================
-- 4. devices
-- =============================================================================
-- DROP TABLE cascades the trigger, policy, and table-owned indexes.
DROP TABLE IF EXISTS devices;

-- =============================================================================
-- 5. users.clerk_user_id
-- =============================================================================
DROP INDEX IF EXISTS users_clerk_user_id_uidx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_clerk_user_id_format;
ALTER TABLE users DROP COLUMN IF EXISTS clerk_user_id;

COMMIT;
