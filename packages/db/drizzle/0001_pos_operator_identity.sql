-- 0001_pos_operator_identity.sql
--
-- POS-Pulse 004 Backend Wave 1 — PR-3 schema-only.
--
-- Adds the schema needed for POS operator sign-in / sign-out:
--   1. `users.clerk_user_id` — stable Clerk subject mapping (nullable, partial UNIQUE).
--   2. `devices` table — per-terminal trust factor (hashed token, tenant + store scope, revocation).
--   3. `auth_tokens` scope-aware CHECK — only `pos_operator` may have both
--      `user_id` and `device_id` populated; every other scope keeps the
--      existing "exactly one of user_id / device_id" invariant.
--   4. `auth_tokens.device_id` FK → `devices(id)` (the FR-POS-SEAM-1 reservation).
--
-- This migration does NOT add any endpoint, controller, service, guard, or
-- contract. Implementation lands in PR-5 / PR-6.
--
-- Reversibility is provided by 0001_pos_operator_identity.down.sql.

BEGIN;

-- =============================================================================
-- 1. users.clerk_user_id — stable Clerk subject mapping
-- =============================================================================
--
-- Wave 1 fails closed when a verified Clerk JWT has no local mapping
-- (ADR 0001 D4). Column is nullable so existing dashboard / argon2id
-- users coexist; provisioning of the mapping is a separate flow with its
-- own audit trail.
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT;

ALTER TABLE users
  ADD CONSTRAINT users_clerk_user_id_format
  CHECK (clerk_user_id IS NULL OR clerk_user_id <> '');

-- Partial UNIQUE — only enforced when set. Lets legacy users keep NULL.
CREATE UNIQUE INDEX IF NOT EXISTS users_clerk_user_id_uidx
  ON users (clerk_user_id)
  WHERE clerk_user_id IS NOT NULL;

-- =============================================================================
-- 2. devices — per-terminal trust factor
-- =============================================================================
--
-- ADR 0001 D7: device trust is orthogonal to human identity. POS sign-in
-- requires both a verified Clerk JWT and a validated device token. Device
-- tokens are stored as SHA-256 hashes only — never plaintext.
CREATE TABLE IF NOT EXISTS devices (
  id           UUID PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id     UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  label        TEXT,
  token_hash   BYTEA        NOT NULL UNIQUE,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT devices_label_not_empty CHECK (label IS NULL OR label <> '')
);

-- Active-token lookup for sign-in path: hash + revocation.
CREATE INDEX IF NOT EXISTS devices_active_idx
  ON devices (tenant_id, store_id) WHERE revoked_at IS NULL;

-- updated_at trigger — same pattern as every other table carrying updated_at.
CREATE TRIGGER devices_set_updated_at BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS on devices: tenant-scoped, FORCE so the table-owner connection in CI
-- still goes through policy. Same predicate shape as stores / memberships.
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_tenant_isolation ON devices
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- =============================================================================
-- 3. auth_tokens — scope-aware principal CHECK
-- =============================================================================
--
-- ADR 0001 D9: the `pos_operator` scope is the *only* scope permitted to
-- carry both `user_id` and `device_id`. Every other scope keeps the
-- existing exactly-one invariant. We replace the constraint (Postgres
-- can't alter a CHECK in place) and use a fresh name so a future grep for
-- "principal_xor" doesn't return a stale, no-longer-XOR predicate.
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_principal_xor;

ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_principal_by_scope CHECK (
  (scope = 'pos_operator' AND user_id IS NOT NULL AND device_id IS NOT NULL)
  OR
  (scope <> 'pos_operator'
     AND (user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1)
);

-- =============================================================================
-- 4. auth_tokens.device_id → devices(id)  (FR-POS-SEAM-1 reservation)
-- =============================================================================
--
-- Until now `device_id` was a reserved column with no FK. Closing the seam
-- now that `devices` exists. Simple FK (not composite) — matches the
-- table's existing pattern (`user_id` and `store_id` are simple FKs too);
-- tenant consistency for `pos_operator` rows is enforced at the
-- application layer.
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_device_fk
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT;

COMMIT;
