-- 0022_connector_health.sql
--
-- Connector Health and Connection-Status API (020) — [GATED] schema + migration
-- (020-FND). Gate PRE-APPROVED by the owner for the 020/021/025 wave.
--
-- Source-of-truth artifacts:
--   - specs/020-connector-health-and-connection-status-api/data-model.md   (Entity 1)
--   - specs/020-connector-health-and-connection-status-api/plan.md          (Constitution Check; LWW justification)
--   - packages/db/src/schema/connector-health.ts
--   - packages/db/__tests__/migration/0022-connector-health.spec.ts         (round-trip, Docker-gated)
--
-- Creates ONE table: `connector_health` — the current liveness READ-MODEL for
-- one connector instance. Exactly one row per 018 `connector_registration`
-- (created lazily on the first accepted heartbeat). Last-write-wins.
--
-- WHY a new table: the per-connector last-seen + self-reported telemetry cannot
-- be derived from existing tables; the liveness verdict is derived AT READ from
-- last_seen_at vs the server clock (no stored verdict), but last_seen_at itself
-- must be persisted. Mirrors the 0019/0020/0021 read-model precedent.
--
-- WHY no `version` column (LWW, plan.md Complexity Tracking): last_seen_at + the
-- self-reported fields are monotonic observational data; the only correct
-- convergence under concurrent heartbeats is "latest wins." There is no business
-- invariant two writers could violate, so an optimistic version column would add
-- contention to a fire-and-forget heartbeat for zero correctness benefit. §III
-- explicitly permits LWW when justified.
--
-- NO money/amount, NO PII, NO secret: connector_version / backlog_indicator /
-- erpnext_reachable are non-PII operational telemetry; the credential/secret
-- material stays in auth_tokens (018), referenced by FK, never copied here.
-- BUSINESS-class only (§XIV).
--
-- §IX: a read-model / observational projection, NOT a source of truth. The
-- identity source of truth is 018 connector_registration; ERPNext-reachability is
-- the connector's self-report (provenance), never a DP2-derived probe result —
-- DP2 makes NO outbound ERPNext HTTP anywhere in this feature.
--
-- §X: last_seen_at is the DP2 SERVER clock at the last accepted heartbeat (the
-- only field the verdict reads); source_clock_at is the connector-reported clock,
-- stored as provenance only and NEVER used for the verdict.
--
-- ON DELETE CASCADE on connector_registration_id: the health row is a derived
-- projection of a registration; if the registration is ever deleted the health
-- row goes with it. (018 registrations are logically DISABLED, not deleted, in
-- normal operation — disabled_at is the normal terminal state and the health row
-- is RETAINED + readable per FR-016; cascade delete is the edge path.)
--
-- RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   0009/0010, also used by 0017/0018/0019/0020/0021). NULL tenant => row
--   filtered => fail-closed. SELECT + INSERT + UPDATE (the heartbeat upsert is an
--   INSERT ... ON CONFLICT DO UPDATE). NO DELETE policy — a health row is removed
--   only via the registration FK cascade, never by the application layer.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: last-seen timestamp, self-reported connector version,
-- backlog indicator, ERPNext-reachability flag, connector-reported clock,
-- timestamps. NO PII, NO payment/tender data, NO money, NO secret/hash. Retention
-- inherits the 001 long-horizon posture; the health row is retained while its
-- registration exists. If a later slice admits a PII or secret field, this
-- RECLASSIFIES and re-triggers the §XIV review.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS connector_health (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- One health row per registration; cascades on registration delete.
  connector_registration_id   UUID         NOT NULL
                                           REFERENCES connector_registration(id) ON DELETE CASCADE,
  -- Server clock at the last accepted heartbeat; NULL => never_seen. The only
  -- field the liveness verdict reads (§X).
  last_seen_at                TIMESTAMPTZ,
  -- Self-reported connector software version.
  connector_version           TEXT,
  -- Self-reported lag / backlog (e.g. pending postings); non-negative.
  backlog_indicator           INTEGER,
  -- Self-reported ERPNext-reachability flag (NOT a DP2 probe result).
  erpnext_reachable           BOOLEAN,
  -- Connector-reported clock; provenance only, never used for the verdict (§X).
  source_clock_at             TIMESTAMPTZ,
  -- Server clock when the self-reported fields were last updated.
  reported_fields_at          TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- One health row per registration (the LWW upsert conflict target).
  CONSTRAINT uq_connector_health_registration UNIQUE (connector_registration_id),
  CONSTRAINT connector_health_version_len
    CHECK (connector_version IS NULL OR length(connector_version) <= 64),
  CONSTRAINT connector_health_backlog_non_negative
    CHECK (backlog_indicator IS NULL OR backlog_indicator >= 0)
);

-- Operator list lookup (per tenant, ordered by the registration join). The
-- UNIQUE on connector_registration_id already indexes the upsert conflict target.
CREATE INDEX IF NOT EXISTS idx_connector_health_tenant
  ON connector_health (tenant_id);

ALTER TABLE connector_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_health FORCE  ROW LEVEL SECURITY;

CREATE POLICY connector_health_tenant_read ON connector_health
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY connector_health_tenant_insert ON connector_health
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE supports the LWW heartbeat upsert (INSERT ... ON CONFLICT DO UPDATE).
-- NO DELETE policy — a health row is removed only via the registration FK cascade.
CREATE POLICY connector_health_tenant_update ON connector_health
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
