-- 0000_initial.sql
--
-- Initial schema for Data-Pulse-2 foundation.
-- Source of truth for the physical model.
--
-- This file is the source of truth — TypeScript schema files in
-- packages/db/src/schema/ are derivative and used only for query
-- type-safety.
--
-- Order follows data-model.md §15:
--   1. Extension (citext)
--   2. Catalog: users, tenants, roles, permissions, role_permissions
--   3. Composite-unique parents: stores
--   4. Children: memberships, store_access
--   5. Auth: sessions, auth_tokens, invitations
--   6. Cross-cutting: audit_events, idempotency_keys
--   7. Triggers (updated_at)
--   8. RLS policies
--
-- Each step is wrapped in IF NOT EXISTS where Postgres allows so this file
-- is safe to apply against a database where a previous run partially
-- succeeded. Full reversibility is provided by 0000_initial.down.sql.

BEGIN;

-- =============================================================================
-- 1. Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS citext;

-- =============================================================================
-- 2. Helper functions
-- =============================================================================

-- Generic updated_at trigger function. Attached to every table carrying
-- `updated_at`.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 3. Catalog tables (no tenant scoping)
-- =============================================================================

-- users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY,
  email               CITEXT       NOT NULL,
  email_verified_at   TIMESTAMPTZ,
  password_hash       TEXT,
  display_name        TEXT,
  is_platform_admin   BOOLEAN      NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT users_email_not_empty CHECK (email <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_uidx
  ON users (lower(email))
  WHERE deleted_at IS NULL;

-- tenants ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY,
  slug        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  status      TEXT         NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT tenants_status_valid CHECK (status IN ('active','suspended','pending'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_active_uidx
  ON tenants (lower(slug))
  WHERE deleted_at IS NULL;

-- roles -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id            UUID PRIMARY KEY,
  tenant_id     UUID         REFERENCES tenants(id) ON DELETE RESTRICT,
  code          TEXT         NOT NULL,
  name          TEXT         NOT NULL,
  is_built_in   BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT roles_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$')
);

-- (tenant_id, code) UNIQUE — uses PG15+ NULLS NOT DISTINCT so platform-scope
-- roles (tenant_id IS NULL) collide on duplicate codes the same way
-- tenant-scoped rows do. No reserved-UUID sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_code_uidx
  ON roles (tenant_id, code) NULLS NOT DISTINCT;

-- (tenant_id, id) UNIQUE — composite-FK target for memberships.role_id.
ALTER TABLE roles ADD CONSTRAINT roles_tenant_id_uk UNIQUE (tenant_id, id);

-- permissions (forward-compat empty in v1) ------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id           UUID PRIMARY KEY,
  code         TEXT         NOT NULL UNIQUE,
  description  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- role_permissions (forward-compat empty in v1) -------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        UUID         NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  UUID         NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

-- =============================================================================
-- 4. Tenant-owned tables (composite-unique parents)
-- =============================================================================

-- stores ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id          UUID PRIMARY KEY,
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code        TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS stores_tenant_code_uidx
  ON stores (tenant_id, lower(code))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS stores_tenant_idx ON stores (tenant_id);

-- (tenant_id, id) UNIQUE — composite-FK target for store_access.
ALTER TABLE stores ADD CONSTRAINT stores_tenant_id_uk UNIQUE (tenant_id, id);

-- =============================================================================
-- 5. Tenant-owned tables (children with composite FKs)
-- =============================================================================

-- memberships -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id             UUID         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  role_id             UUID         NOT NULL,
  store_access_kind   TEXT         NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT memberships_store_access_kind_valid CHECK (store_access_kind IN ('all','specific')),
  -- composite FK ensures the chosen role belongs to the same tenant
  CONSTRAINT memberships_role_tenant_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES roles (tenant_id, id) ON DELETE RESTRICT
);

-- I-2: one active membership per (tenant, user).
CREATE UNIQUE INDEX IF NOT EXISTS memberships_tenant_user_active_uidx
  ON memberships (tenant_id, user_id)
  WHERE deleted_at IS NULL;

-- (tenant_id, id) UNIQUE — composite-FK target for store_access.
ALTER TABLE memberships ADD CONSTRAINT memberships_tenant_id_uk UNIQUE (tenant_id, id);

-- store_access ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_access (
  membership_id  UUID         NOT NULL,
  store_id       UUID         NOT NULL,
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, store_id),
  -- I-3: store_access tenant matches its membership's tenant.
  CONSTRAINT store_access_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  -- I-3: store_access tenant matches its store's tenant.
  CONSTRAINT store_access_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT
);

-- =============================================================================
-- 6. Auth-flow tables
-- =============================================================================

-- sessions --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                    UUID PRIMARY KEY,
  user_id               UUID         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  active_tenant_id      UUID         REFERENCES tenants(id) ON DELETE SET NULL,
  active_store_id       UUID         REFERENCES stores(id)  ON DELETE SET NULL,
  issued_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  absolute_expires_at   TIMESTAMPTZ  NOT NULL,
  revoked_at            TIMESTAMPTZ,
  user_agent            TEXT,
  ip_at_issue           TEXT,
  -- I-4: an active store implies an active tenant.
  CONSTRAINT sessions_active_store_implies_tenant
    CHECK (active_store_id IS NULL OR active_tenant_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON sessions (absolute_expires_at) WHERE revoked_at IS NULL;

-- auth_tokens -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_tokens (
  id           UUID PRIMARY KEY,
  token_hash   BYTEA        NOT NULL UNIQUE,
  tenant_id    UUID         REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id      UUID         REFERENCES users(id)   ON DELETE RESTRICT,
  device_id    UUID,
  store_id     UUID         REFERENCES stores(id)  ON DELETE RESTRICT,
  scope        TEXT         NOT NULL,
  issued_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT auth_tokens_principal_xor
    CHECK ((user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1)
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_active_idx
  ON auth_tokens (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_tokens_tenant_idx
  ON auth_tokens (tenant_id);

-- invitations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS invitations (
  id                   UUID PRIMARY KEY,
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email                CITEXT       NOT NULL,
  role_id              UUID         NOT NULL REFERENCES roles(id)   ON DELETE RESTRICT,
  store_access_kind    TEXT         NOT NULL,
  invited_store_ids    UUID[]       NOT NULL DEFAULT '{}'::uuid[],
  invited_by_user_id   UUID         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  token_hash           BYTEA        NOT NULL UNIQUE,
  status               TEXT         NOT NULL DEFAULT 'pending',
  expires_at           TIMESTAMPTZ  NOT NULL,
  accepted_by_user_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
  accepted_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,
  CONSTRAINT invitations_status_valid       CHECK (status IN ('pending','accepted','expired','revoked')),
  CONSTRAINT invitations_kind_valid         CHECK (store_access_kind IN ('all','specific'))
);

CREATE INDEX IF NOT EXISTS invitations_tenant_status_idx
  ON invitations (tenant_id, status) WHERE deleted_at IS NULL;

-- =============================================================================
-- 7. Cross-cutting tables
-- =============================================================================

-- audit_events ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY,
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actor_user_id   UUID         REFERENCES users(id)   ON DELETE SET NULL,
  actor_label     TEXT,
  tenant_id       UUID         REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID         REFERENCES stores(id)  ON DELETE SET NULL,
  action          TEXT         NOT NULL,
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  request_id      UUID
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_time_idx
  ON audit_events (action, occurred_at DESC);

-- idempotency_keys (POS-future seam) ------------------------------------
-- Uses a synthetic UUID primary key. The idempotency-scope uniqueness lives
-- in a separate index that uses PG15+ NULLS NOT DISTINCT so a NULL store_id
-- still participates in uniqueness (a composite PK that includes a nullable
-- column treats NULLs as distinct — every "no store" row would collide).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id               UUID PRIMARY KEY,
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id         UUID,
  client_id        TEXT         NOT NULL,
  key              TEXT         NOT NULL,
  request_hash     BYTEA        NOT NULL,
  response_status  INT          NOT NULL,
  response_body    JSONB        NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_scope_uidx
  ON idempotency_keys (tenant_id, store_id, client_id, key) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
  ON idempotency_keys (expires_at);

-- =============================================================================
-- 8. updated_at triggers
-- =============================================================================
CREATE TRIGGER users_set_updated_at         BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tenants_set_updated_at       BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stores_set_updated_at        BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at         BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_set_updated_at   BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invitations_set_updated_at   BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 9. Row-Level Security
-- =============================================================================
--
-- Pattern (data-model.md §14):
--   tenant_id = current_setting('app.current_tenant', true)::uuid
--   OR current_setting('app.is_platform_admin', true) = 'true'
--
-- `current_setting(name, true)` returns NULL when the GUC is unset, which
-- ensures policies fail closed. We also FORCE RLS so the table-owner
-- connection (typical in CI / Testcontainers) does not bypass policies.

-- Defense-in-depth: every policy uses USING (visibility on read/delete and
-- on the pre-update view of UPDATEs) AND WITH CHECK (validation of new rows
-- on INSERT and the post-update view of UPDATEs). Same predicate on both so
-- a writer with the wrong tenant can neither read other-tenant rows nor
-- write rows under another tenant.

-- tenants ---------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (
    id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- stores ----------------------------------------------------------------
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_tenant_isolation ON stores
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- memberships -----------------------------------------------------------
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- store_access ----------------------------------------------------------
ALTER TABLE store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_access FORCE ROW LEVEL SECURITY;
CREATE POLICY store_access_tenant_isolation ON store_access
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- roles -----------------------------------------------------------------
-- Platform-scope roles (tenant_id IS NULL) are visible to everyone; tenant
-- roles follow the standard isolation rule. Writes to platform rows still
-- require platform-admin (so a tenant context cannot create a NULL-tenant
-- role).
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant_isolation ON roles
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    (tenant_id IS NOT NULL
       AND tenant_id = current_setting('app.current_tenant', true)::uuid)
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- auth_tokens -----------------------------------------------------------
-- Tenant-scoped tokens follow standard isolation; platform-scoped tokens
-- (tenant_id IS NULL) require platform admin.
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_tokens_tenant_isolation ON auth_tokens
  USING (
    (tenant_id IS NOT NULL
       AND tenant_id = current_setting('app.current_tenant', true)::uuid)
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    (tenant_id IS NOT NULL
       AND tenant_id = current_setting('app.current_tenant', true)::uuid)
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- invitations -----------------------------------------------------------
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant_isolation ON invitations
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- audit_events ----------------------------------------------------------
-- Rows with tenant_id IS NULL are platform-scoped and require platform admin.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (
    (tenant_id IS NOT NULL
       AND tenant_id = current_setting('app.current_tenant', true)::uuid)
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    (tenant_id IS NOT NULL
       AND tenant_id = current_setting('app.current_tenant', true)::uuid)
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- idempotency_keys ------------------------------------------------------
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- users, permissions, role_permissions, sessions: NO RLS (per data-model §1, §7, §8, §9).

COMMIT;
