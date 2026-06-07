-- 0021_connector_registration.sql
--
-- Connector Boundary Hardening (018) — [GATED] schema + migration (018-SCHEMA).
-- Gate OWNER-APPROVED 2026-06-06. Preflight discipline (R3) applied: the
-- scope-enum CHECK below ships because a repo-wide scan confirmed every existing
-- auth_tokens scope literal is within the six-member set; the connector-token
-- CONSISTENCY CHECK is DEFERRED (see the auth_tokens section).
--
-- Source-of-truth artifacts:
--   - specs/018-connector-boundary-hardening/data-model.md   (Entity 1, Entity 2)
--   - specs/018-connector-boundary-hardening/research.md      (R1 identity model, R2 rotation, R3 CHECKs)
--   - packages/db/src/schema/connector_registration.ts
--   - packages/db/src/schema/auth_tokens.ts                   (the additive FK column)
--   - packages/db/__tests__/migration/0021-connector-registration.spec.ts            (round-trip, Docker-gated)
--   - apps/api/test/connector/schema/connector-registration-schema-shape.spec.ts     (Docker-free shape test)
--
-- Creates ONE table — connector_registration — the stable, operator-facing
-- identity of one ERPNext connector deployment for one tenant (Approach A / R1).
-- Credentials stay in auth_tokens, linked by a new nullable
-- connector_registration_id FK. Rotating the secret swaps the auth_tokens row,
-- NOT this identity row. Rejected alternatives: all-on-auth_tokens (identity
-- dies with the token) and a full registry subsystem (YAGNI). (research R1)
--
-- NO money/amount column, NO PII, NO secret: connector_registration holds an
-- operator display name, the ERPNext site label/ref (NOT a secret), and the
-- environment token. BUSINESS-class only (§XIV). The raw connector secret is
-- never stored — only its hash, in auth_tokens.token_hash (the existing path).
--
-- RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   0009/0010, also used by 0017/0018/0019/0020). NULL tenant => row filtered
--   => fail-closed. SELECT + INSERT + UPDATE (active -> disabled is an UPDATE;
--   FR-014). NO DELETE policy — disable is logical, rows retained for audit.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: connector display name, ERPNext site ref, environment,
-- the acting/disabling admin user ids, timestamps. NO PII, NO payment/tender
-- data, NO money, NO secret/hash. Retention inherits the 001 long-horizon
-- posture; a disabled registration is retained (status, not deleted) for the
-- operability/audit surface. If a later slice admits a PII or secret field,
-- this RECLASSIFIES and re-triggers the §XIV review.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. connector_registration -----------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_registration (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Operator-facing label. Non-empty after trimming (no whitespace-only names).
  display_name      TEXT         NOT NULL,
  -- The ERPNext site label/ref the operator registers — NOT a secret.
  erpnext_site_ref  TEXT         NOT NULL,
  -- Canonical wire tokens (the request DTO and this CHECK agree on these).
  environment       TEXT         NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- The acting admin who registered the connector.
  created_by        UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Logical disable (FR-014); NULL while active. disabled_by is the acting admin.
  disabled_at       TIMESTAMPTZ,
  disabled_by       UUID         REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT connector_registration_display_name_non_empty
    CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT connector_registration_environment_valid
    CHECK (environment IN ('dev', 'staging', 'pilot', 'prod')),
  -- A tenant cannot register the same ERPNext site twice in the same
  -- environment (FR-005a, clarify Q1).
  CONSTRAINT uq_connector_registration_tenant_env_site
    UNIQUE (tenant_id, environment, erpnext_site_ref)
);

ALTER TABLE connector_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_registration FORCE  ROW LEVEL SECURITY;

CREATE POLICY connector_registration_tenant_read ON connector_registration
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY connector_registration_tenant_insert ON connector_registration
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE supports the active -> disabled logical transition (FR-014). NO DELETE.
CREATE POLICY connector_registration_tenant_update ON connector_registration
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- 2. auth_tokens — additive link to the connector identity ----------------------
-- The ONLY shared-table change: a *link*, not connector metadata. NULL for
-- non-connector scopes; carried for a connector credential so the identity
-- survives rotation (R1).
ALTER TABLE auth_tokens
  ADD COLUMN IF NOT EXISTS connector_registration_id UUID
    REFERENCES connector_registration(id) ON DELETE RESTRICT;

-- Scope enum (R3, preflight-clean): pin auth_tokens.scope to the known set,
-- closing the free-TEXT gap 018 targets. SHIPPED because a repo-wide preflight
-- confirmed every existing scope literal is within this set.
ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_scope_valid
    CHECK (scope IN (
      'dashboard_api', 'pos', 'pos_operator',
      'connector', 'password_reset', 'email_verify'
    ));

-- At-most-one-active connector credential per registration (FR-010). The
-- predicate is IMMUTABLE — scope + revoked_at only. Expiry is DELIBERATELY NOT
-- in the predicate: now() is STABLE, not IMMUTABLE, and a partial-index
-- predicate referencing it is rejected by Postgres. Expiry is enforced at the
-- guard + lifecycle maintenance (research R2; the 009 EXCLUDE-constraint
-- precedent, migration 0016).
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_tokens_active_connector_credential
  ON auth_tokens (connector_registration_id)
  WHERE scope = 'connector' AND revoked_at IS NULL;

-- DEFERRED (R3): the connector-token CONSISTENCY CHECK
--   (scope='connector') = (connector_registration_id IS NOT NULL)
-- is NOT added here. A legacy unlinked connector token (scope='connector',
-- connector_registration_id NULL) MAY exist in a live/staging env (owner-
-- confirmed 2026-06-06), and the CHECK would reject it. This is the R3
-- "defer if not safe" path: the FK + partial-unique ship now; the consistency
-- CHECK becomes a named follow-up PENDING a live backfill that links every
-- pre-existing connector token to a registration. The US4 guard enforces the
-- linkage requirement at runtime INDEPENDENTLY of this DB CHECK
-- (GUARD-TIGHTENING-IS-BREAKING-FOR-LEGACY-TOKENS).

COMMIT;
