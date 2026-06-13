-- 0025_external_identity_links.sql
--
-- 029 DP-2 Provider-Neutral Identity Link (Draft D3). Realizes 028 §16 / the
-- DP-2 028 slice §13/PI-3: a provider-NEUTRAL identity link mapping
--   (provider_key, issuer, subject) -> user_id
-- so operator identity resolution is no longer welded to one provider. The
-- Clerk subject that `users.clerk_user_id` holds today becomes one row here
-- (provider_key='clerk'); `users.clerk_user_id` is RECLASSIFIED as a v1 bridge
-- column behind this link (retained, off the join path, NOT dropped — N-7/T8).
--
-- TENANT-SCOPING DECISION (the load-bearing one — read before assuming RLS):
-- This table is tenant-AGNOSTIC and carries NO tenant_id and NO RLS, deliberately
-- mirroring the `users` table (0000_initial), NOT the tenant-scoped `devices`
-- pattern (0001) the prompt cites as the simplification. Reasons:
--   1. A provider subject is a GLOBAL human identity, not a tenant. `user_id` FKs
--      `users(id)`, which is itself tenant-agnostic (no tenant_id, no table RLS,
--      app-layer gated). A user may hold memberships in multiple tenants.
--   2. The uniqueness invariants are GLOBAL: a provider subject maps to exactly
--      one user; one ACTIVE link per user. Neither is per-tenant.
--   3. The operator-context resolver reads this table BEFORE any tenant GUC
--      exists — it is the step that ESTABLISHES tenant context (the device row
--      carries the tenant). A FORCE-RLS tenant predicate would have nothing to
--      key on and would fail-closed-to-zero on every pre-context read, bricking
--      sign-in. The spec §5 qualifier "if/where tenant-scoping applies" sanctions
--      this; tenant-scoping does NOT apply.
-- Access is gated at the application layer (same posture as `users`): only the
-- trusted resolver / provisioning flows read or write links.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class. Carries `email`
-- (provider-asserted, informational — DP2 owns membership, not email truth) and
-- the opaque provider subject/issuer (identifiers, not secrets). NO money/amount.
-- NO recoverable secret (the provider's signing secret stays at the adapter; no
-- token is stored here). `email` is provider-asserted business contact, not the
-- §XIV SECRET class.
--
-- Migration safety (G3): additive (no ALTER of any existing table), idempotent
-- (IF NOT EXISTS throughout), reversible (0025_external_identity_links.down.sql).
-- Backfill is idempotent (ON CONFLICT DO NOTHING) and fail-closed: an existing
-- user with a non-null clerk_user_id that cannot be mapped is SURFACED for
-- reconciliation, never silently dropped — the link count must equal the count
-- of users with a non-null clerk_user_id afterwards (preserving mig 0001 ADR D4
-- "fail closed when a verified JWT has no local mapping").
--
-- DOES NOT touch users.clerk_user_id (its partial UNIQUE index + format CHECK
-- stay; reclassification to a bridge column is documentation + resolver re-point,
-- not a schema change — N-7/T8).

BEGIN;

-- =============================================================================
-- 1. external_identity_links — provider-neutral identity mapping (T1)
-- =============================================================================
CREATE TABLE IF NOT EXISTS external_identity_links (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which provider — 'clerk' in v1; the discriminator a future adapter selects
  -- on. Lives in the row + the adapter selection, NEVER in a business rule.
  provider_key      TEXT         NOT NULL,
  -- The provider's `iss` claim (the configured issuer for this provider).
  issuer            TEXT         NOT NULL,
  -- The provider's stable subject (`sub`) — the value clerk_user_id holds today.
  subject           TEXT         NOT NULL,
  -- The local user this external identity resolves to. users is tenant-agnostic.
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Provider-asserted email at link time (informational; DP2 owns membership).
  email             TEXT,
  -- Link status — drives disableIdentity / enableIdentity.
  status            TEXT         NOT NULL DEFAULT 'active',
  linked_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Last successful verifyIdentityToken for this link (nullable until first use).
  last_verified_at  TIMESTAMPTZ,
  -- When the link was disabled (nullable; set when status -> 'disabled').
  disabled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT external_identity_links_provider_key_non_empty
    CHECK (length(btrim(provider_key)) > 0),
  CONSTRAINT external_identity_links_issuer_non_empty
    CHECK (length(btrim(issuer)) > 0),
  CONSTRAINT external_identity_links_subject_non_empty
    CHECK (length(btrim(subject)) > 0),
  CONSTRAINT external_identity_links_email_non_empty
    CHECK (email IS NULL OR length(btrim(email)) > 0),
  CONSTRAINT external_identity_links_status_valid
    CHECK (status IN ('active', 'disabled')),
  -- A disabled link MUST carry disabled_at; an active link MUST NOT (keeps the
  -- status / disabled_at pair internally consistent).
  CONSTRAINT external_identity_links_disabled_at_consistent
    CHECK (
      (status = 'disabled' AND disabled_at IS NOT NULL)
      OR (status = 'active' AND disabled_at IS NULL)
    )
);

-- =============================================================================
-- 2. Uniqueness + single-active-link guard (T2)
-- =============================================================================
--
-- (provider_key, issuer, subject) resolves to EXACTLY ONE row (and thus one
-- user_id) — the durable join key (spec §5). The table shape permits MULTIPLE
-- rows per user_id (a future scheduled dual-link migration needs no reshape,
-- only a relaxation of the partial-unique below — 028 OQ-7).
CREATE UNIQUE INDEX IF NOT EXISTS external_identity_links_provider_subject_uidx
  ON external_identity_links (provider_key, issuer, subject);

-- SINGLE ACTIVE LINK PER user_id in v1 (D3-LOCAL). Partial-unique on the ACTIVE
-- link only — disabled rows do not count, so a re-link after disable is allowed,
-- and the shape already supports future multi-active dual-link by relaxing this.
CREATE UNIQUE INDEX IF NOT EXISTS external_identity_links_one_active_per_user_uidx
  ON external_identity_links (user_id)
  WHERE status = 'active';

-- Resolution-join acceleration. The v1 resolver joins on (provider_key, subject)
-- for the single active link (issuer is single-valued in v1; see the resolver's
-- note on why issuer is stored + unique but not the runtime join key — it avoids
-- a backfill-issuer-vs-adapter-issuer drift that would fail-closed every
-- operator). This partial index serves that lookup.
CREATE INDEX IF NOT EXISTS external_identity_links_active_lookup_idx
  ON external_identity_links (provider_key, subject)
  WHERE status = 'active';

-- updated_at trigger — same pattern as every other table carrying updated_at.
-- DROP-then-CREATE (Postgres 16 has no CREATE TRIGGER IF NOT EXISTS) so the
-- whole UP is genuinely re-runnable / idempotent (G3).
DROP TRIGGER IF EXISTS external_identity_links_set_updated_at
  ON external_identity_links;
CREATE TRIGGER external_identity_links_set_updated_at
  BEFORE UPDATE ON external_identity_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- NO RLS: tenant-agnostic, mirrors `users` (see header). Deliberately NOT
-- ENABLE/FORCE ROW LEVEL SECURITY.

-- =============================================================================
-- 3. Backfill from existing users.clerk_user_id (T7) [G3]
-- =============================================================================
--
-- One ACTIVE 'clerk' link per user with a non-null clerk_user_id.
--   provider_key = 'clerk'
--   issuer       = the configured Clerk issuer. ONE source of truth: this SQL
--                  literal MUST match the adapter's configured issuer
--                  (clerkVerifierFactory / IdentityProviderPort). To keep that
--                  contract drift-proof the resolver join keys on
--                  (provider_key, subject) NOT issuer, so a v1 issuer-string
--                  mismatch can never fail-close an operator. issuer is stored +
--                  unique for forward-compat (multi-issuer dual-link).
--   subject      = clerk_user_id
-- Idempotent: ON CONFLICT (provider_key, issuer, subject) DO NOTHING — a re-run
-- (or re-apply after a partial failure) inserts nothing new.
-- Fail-closed + surfaced: this INSERT…SELECT maps EVERY user with a non-null
-- clerk_user_id. The migration test asserts COUNT(links) == COUNT(users WHERE
-- clerk_user_id IS NOT NULL); any unmappable subject is therefore detectable
-- (count divergence) for operator reconciliation, never silently dropped.
INSERT INTO external_identity_links
  (provider_key, issuer, subject, user_id, email, status)
SELECT
  'clerk' AS provider_key,
  'https://clerk.dp2.local' AS issuer,
  u.clerk_user_id AS subject,
  u.id AS user_id,
  u.email AS email,
  'active' AS status
FROM users u
WHERE u.clerk_user_id IS NOT NULL
ON CONFLICT (provider_key, issuer, subject) DO NOTHING;

COMMIT;
