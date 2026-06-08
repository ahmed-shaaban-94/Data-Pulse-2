-- 0023_erpnext_product_reconciliation.sql
--
-- ERPNext Product-Master Reconciliation & Repair (021) — [GATED] schema +
-- migration (021-SCHEMA / T005).
--
-- Source-of-truth artifacts:
--   - specs/021-product-master-reconciliation-v1/data-model.md  §2 (entities + invariants), §4 (transitions)
--   - specs/021-product-master-reconciliation-v1/plan.md         (Constitution Check; the run->report->repair surface)
--   - packages/db/src/schema/catalog/erpnext-product-reconciliation.ts
--   - packages/db/__tests__/migration/0023-erpnext-product-reconciliation.spec.ts            (round-trip, Docker-gated)
--   - apps/api/test/catalog/erpnext-product-reconciliation/schema/erpnext-product-reconciliation-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates THREE tables — 021's OWN operational reconciliation state for
-- product/item-MAPPING divergence (the inverse of 017's stock reconciliation;
-- 021 : 013 :: 017 : 014/009). 021 READS (never mirrors) the 013 erpnext_item_map
-- mapping (0017), the 003 tenant_products catalog (0007-0011), the 008 sale facts
-- (0012), and the connector's ERPNext-item view (012 seam, stub-tolerant); it OWNS
-- the durable runs / mismatch reports / repair-attempt audit:
--
--   1. erpnext_product_reconciliation_run — one reconciliation execution (the US3
--      two-sided compare). TENANT-scoped, NOT store-scoped — a product↔Item
--      mapping is tenant-wide (the 013 no-store-axis precedent). NO `kind` column
--      (unlike 017's reserved kind='stock'): 021 has exactly one run kind, and the
--      US1 backlog is a LIVE READ-PROJECTION, not a run — a kind column would be
--      vacuous. `erpnext_view_status` records the connector-view availability so an
--      absent view is a *reported* condition, never a failed run (FR-007 / R3).
--   2. erpnext_product_reconciliation_result — one classified line of a run's
--      mismatch report, in 021's PRODUCT-MASTER vocabulary (data-model §2.2): match
--      / unmapped_dp2_product / suggestion_unconfirmed / unmapped_erpnext_item /
--      attribute_drift / sellable_state_divergence. result_state (open|repaired|
--      accepted) is 021's OWN orthogonal workflow status. Single-column run_id FK
--      to the run PK (017 advisor #1: id is UUIDv7 + RLS scopes both rows to one
--      tenant, so a composite FK buys nothing).
--   3. erpnext_product_reconciliation_repair_attempt — append-only audit of every
--      repair action (confirm / suggest_confirm / re_point) — all DRIVE 013's
--      EXISTING lifecycle (FR-010); 021 owns no new mapping write. target_ref_id is
--      POLYMORPHIC (a tenant_products.id for a backlog repair, or a result id for a
--      run repair), deliberately NO FK (the 0019/0020 polymorphic precedent).
--
-- WHY a new table family (NOT derive-on-read): a reconciliation RUN and a
--   persisted MISMATCH REPORT are first-class durable facts an operator returns to
--   — they cannot be derived; the repair-attempt is the immutable audit trail of
--   the repair workflow. But the US1 unmapped-product backlog is a LIVE
--   READ-PROJECTION over 003 ⟕ 013 — 021 reads it in place, never mirrors it
--   (READ-NOT-MIRROR-013 / FR-002), so it is NOT a table here (data-model §3).
--
-- Mutable tenant-owned resources: a run completes (running -> completed/failed); a
--   result transitions (open -> repaired/accepted) — so SELECT + INSERT + UPDATE
--   RLS policies on run + result. The repair_attempt is APPEND-ONLY: SELECT +
--   INSERT only (no UPDATE). NO DELETE policy anywhere — retention is a status, not
--   a row removal (§XIV). RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard (a
--   bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from 0009/0010,
--   also used by 0017/0019/0020/0021). NULL tenant => row filtered => fail-closed.
--
-- NO money / amount / valuation column, NO PII: these are BUSINESS-class
--   operational records (refs, provenance, mismatch classes, counts). The
--   `summary` / `detail` jsonb carry counts + operator-facing attribute values +
--   refs ONLY — never PII, never payment data (§XIV). The audit-of-record write
--   (FR-015) is a separate in-transaction INSERT INTO audit_events done by the 021
--   SERVICE/processor, NOT here — this migration is audit-agnostic.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: run scope (tenant), trigger/status/view-status, summary
-- counts; per-result mismatch class, originating refs (DP2 product ref + ERPNext
-- item ref) + provenance, result_state, detail (DP2 vs ERPNext attributes);
-- repair target ref + kind + outcome + resolved item-map ref + expected version.
-- NO PII, NO payment/tender data, NO money/valuation. Retention inherits the 001
-- long-horizon posture; runs/reports/attempts are retained (status, not deleted)
-- for the operability/audit surface. If a later slice admits a PII or money field,
-- this RECLASSIFIES and re-triggers §XIV.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. erpnext_product_reconciliation_run -----------------------------------------
CREATE TABLE IF NOT EXISTS erpnext_product_reconciliation_run (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- v1 emits 'on_demand'; 'scheduled' reserved (R7 / 021-SCHEDULED-RUNS).
  trigger             TEXT         NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'running',
  -- Records the connector-view availability so an absent view is a *reported*
  -- condition, never a failed run (FR-007 / R3).
  erpnext_view_status TEXT         NOT NULL DEFAULT 'unavailable',
  started_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  -- Counts by mismatch class — BUSINESS-class counts ONLY, never PII/money.
  summary             JSONB,
  -- The operator for an on-demand run; NULL for a scheduled run (a future arc).
  actor_user_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  correlation_id      UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_product_reconciliation_run_trigger_valid
    CHECK (trigger IN ('on_demand', 'scheduled')),
  CONSTRAINT erpnext_product_reconciliation_run_status_valid
    CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT erpnext_product_reconciliation_run_view_status_valid
    CHECK (erpnext_view_status IN ('available', 'unavailable', 'partial')),
  -- A terminal run carries finished_at; a running run does not.
  CONSTRAINT erpnext_product_reconciliation_run_finished_when_terminal
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Per-tenant run history (operator review, newest first).
CREATE INDEX IF NOT EXISTS idx_erpnext_product_reconciliation_run_tenant_time
  ON erpnext_product_reconciliation_run (tenant_id, started_at DESC);

-- 2. erpnext_product_reconciliation_result --------------------------------------
CREATE TABLE IF NOT EXISTS erpnext_product_reconciliation_result (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Single-column FK to the run PK (017 advisor #1). RLS scopes both rows to one tenant.
  run_id             UUID         NOT NULL REFERENCES erpnext_product_reconciliation_run(id) ON DELETE RESTRICT,
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- 021's product-master vocabulary ONLY (data-model §2.2). 021 owns this
  -- vocabulary; it does NOT invent a competing one where 013 named the case.
  mismatch_class     TEXT         NOT NULL,
  -- The DP2 product ref (NULL for an unmapped_erpnext_item line). POLYMORPHIC —
  -- kept FK-less per the 0019/0020 polymorphic precedent.
  tenant_product_id  UUID,
  -- The ERPNext item reference (NULL for an unmapped_dp2_product line). No FK
  -- (external, 012 O-6; the 013 erpnext_item_ref no-FK rationale).
  erpnext_item_ref   TEXT,
  source_system      TEXT,
  external_id        TEXT,
  -- 021's OWN orthogonal workflow status (distinct from the mismatch class).
  result_state       TEXT         NOT NULL DEFAULT 'open',
  -- Operator-facing values (DP2 vs ERPNext attributes, drift fields) — values
  -- allowed on the row, NEVER in metric labels.
  detail             JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_product_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'unmapped_dp2_product', 'suggestion_unconfirmed',
      'unmapped_erpnext_item', 'attribute_drift', 'sellable_state_divergence'
    )),
  CONSTRAINT erpnext_product_reconciliation_result_state_valid
    CHECK (result_state IN ('open', 'repaired', 'accepted'))
);

-- Per-run results scan (the mismatch report), filterable by class.
CREATE INDEX IF NOT EXISTS idx_erpnext_product_reconciliation_result_run
  ON erpnext_product_reconciliation_result (tenant_id, run_id, mismatch_class);

-- 3. erpnext_product_reconciliation_repair_attempt ------------------------------
CREATE TABLE IF NOT EXISTS erpnext_product_reconciliation_repair_attempt (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_kind           TEXT         NOT NULL,
  -- The tenant_products.id (backlog repair) OR a result id (run repair).
  -- POLYMORPHIC — deliberately NO FK (the 0019/0020 precedent).
  target_ref_id         UUID         NOT NULL,
  -- All DRIVE 013's existing lifecycle (FR-010); 021 owns no new mapping write.
  repair_kind           TEXT         NOT NULL,
  actor_user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  outcome               TEXT         NOT NULL,
  -- Echoed when the repair resolves to a confirmed-and-active 013 mapping
  -- (the idempotency echo, FR-011).
  resolved_item_map_id  UUID,
  -- The 013 `version` the confirm was issued against (provenance for a conflict).
  expected_version      INTEGER,
  correlation_id        UUID,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_product_reconciliation_repair_attempt_target_kind_valid
    CHECK (target_kind IN ('backlog_item', 'result')),
  CONSTRAINT erpnext_product_reconciliation_repair_attempt_repair_kind_valid
    CHECK (repair_kind IN ('confirm', 'suggest_confirm', 're_point')),
  CONSTRAINT erpnext_product_reconciliation_repair_attempt_outcome_valid
    CHECK (outcome IN ('mapped', 'still_unmapped', 'no_op_echo', 'conflict'))
);

-- Repair history for a target (audit lookup).
CREATE INDEX IF NOT EXISTS idx_erpnext_product_reconciliation_repair_attempt_target
  ON erpnext_product_reconciliation_repair_attempt (tenant_id, target_kind, target_ref_id);

-- RLS — ENABLE + FORCE, fail-closed empty-GUC CASE guard (0009/0010/0017/0019/0020).
ALTER TABLE erpnext_product_reconciliation_run             ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_product_reconciliation_run             FORCE  ROW LEVEL SECURITY;
ALTER TABLE erpnext_product_reconciliation_result          ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_product_reconciliation_result          FORCE  ROW LEVEL SECURITY;
ALTER TABLE erpnext_product_reconciliation_repair_attempt  ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_product_reconciliation_repair_attempt  FORCE  ROW LEVEL SECURITY;

-- run: SELECT + INSERT + UPDATE (running -> terminal). NO DELETE.
CREATE POLICY erpnext_product_reconciliation_run_tenant_read ON erpnext_product_reconciliation_run
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_product_reconciliation_run_tenant_insert ON erpnext_product_reconciliation_run
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_product_reconciliation_run_tenant_update ON erpnext_product_reconciliation_run
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- result: SELECT + INSERT + UPDATE (open -> repaired/accepted). NO DELETE.
CREATE POLICY erpnext_product_reconciliation_result_tenant_read ON erpnext_product_reconciliation_result
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_product_reconciliation_result_tenant_insert ON erpnext_product_reconciliation_result
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_product_reconciliation_result_tenant_update ON erpnext_product_reconciliation_result
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- repair_attempt: APPEND-ONLY — SELECT + INSERT only. NO UPDATE, NO DELETE.
CREATE POLICY erpnext_product_reconciliation_repair_attempt_tenant_read ON erpnext_product_reconciliation_repair_attempt
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_product_reconciliation_repair_attempt_tenant_insert ON erpnext_product_reconciliation_repair_attempt
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
