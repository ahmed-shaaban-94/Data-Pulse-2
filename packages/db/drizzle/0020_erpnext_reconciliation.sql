-- 0020_erpnext_reconciliation.sql
--
-- ERPNext Reconciliation & Repair (017) — [GATED] schema + migration (017-SCHEMA / T012).
--
-- Source-of-truth artifacts:
--   - specs/017-erpnext-reconciliation-and-repair/data-model.md  §2 (entities + invariants), §3 (transitions)
--   - specs/017-erpnext-reconciliation-and-repair/plan.md         (Constitution Check; the run->report->repair surface)
--   - packages/db/src/schema/catalog/erpnext-reconciliation.ts
--   - packages/db/__tests__/migration/0020-erpnext-reconciliation.spec.ts            (round-trip, Docker-gated)
--   - apps/api/test/catalog/erpnext-reconciliation/schema/erpnext-reconciliation-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates THREE tables — 017's OWN operational reconciliation state. 017 READS
-- (never mirrors) the 015 erpnext_posting_status dead-letters (0019), the 014
-- erpnext_warehouse_map mapping (0018), and the 009 stock_movements ledger (0014);
-- it OWNS the durable runs / mismatch reports / repair-attempt audit:
--
--   1. erpnext_reconciliation_run — one reconciliation execution. STOCK-ONLY in
--      v1 (data-model §2.1 / advisor #2): the posting dead-letter backlog (US1) is
--      a LIVE READ-PROJECTION over the 015 rows, NOT a run — a kind='posting' run
--      would never produce result rows, so it is not modeled. The CHECK reserves
--      room to add 'posting' later only if a posting-snapshot run is ever needed.
--   2. erpnext_reconciliation_result — one classified line of a run's mismatch
--      report, in 014's mismatch-class vocabulary ONLY (014 data-model §6.2,
--      finalized; the 015 posting categories live on the 015 rows, read in place,
--      never mirrored here — READ-NOT-MIRROR / R2). result_state (open|repaired|
--      accepted) is 017's OWN orthogonal workflow status. Single-column run_id FK
--      to the run PK (advisor #1: id is a UUIDv7 PK + RLS scopes both rows to one
--      tenant, so a composite (run_id, tenant_id) FK needing an extra unique buys
--      nothing).
--   3. erpnext_reconciliation_repair_attempt — append-only audit of every repair
--      action (re_post / re_map / re_sync / drain). A posting repair targets the
--      015 erpnext_posting_status.id; a stock repair targets a result id —
--      POLYMORPHIC target_ref_id, deliberately NO FK (the 0019 source_ref_id /
--      0018 erpnext_warehouse_ref / 013 erpnext_item_ref no-FK rationale).
--
-- WHY a new table family (NOT derive-on-read; 017-SIGNOFF-STATE, owner-authorized):
--   a reconciliation RUN and a persisted MISMATCH REPORT are first-class durable
--   facts an operator returns to — they cannot be derived; the repair-attempt is
--   the immutable audit trail of the repair workflow. But the posting backlog
--   itself lives in 015 — 017 reads it in place (a read-projection over
--   status='permanently_rejected'), never mirrors it (the 010 RESTRICT-vs-CASCADE
--   derived-projection drift trap). (data-model §2)
--
-- Mutable tenant-owned resources: a run completes (running -> completed/failed); a
--   result transitions (open -> repaired/accepted) — so SELECT + INSERT + UPDATE
--   RLS policies on run + result. The repair_attempt is APPEND-ONLY: SELECT +
--   INSERT only (no UPDATE). NO DELETE policy anywhere — retention is a status, not
--   a row removal (§XIV). RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard (a
--   bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from 0009/0010,
--   also used by 0017/0018/0019). NULL tenant => row filtered => fail-closed.
--
-- NO money / amount / valuation column, NO PII: these are BUSINESS-class
--   operational records (refs, provenance, mismatch classes, counts, qty values).
--   The `summary` / `detail` jsonb carry counts + operator-facing quantity values +
--   refs ONLY — never PII, never payment data (§XIV). The audit-of-record write
--   (FR-014) is a separate in-transaction INSERT INTO audit_events done by the
--   017 SERVICE/worker (US2/US3), NOT here — this migration is audit-agnostic.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: run scope (tenant/store), kind/trigger/status, summary
-- counts; per-result mismatch class, originating ref + provenance, result_state,
-- detail (DP2 vs ERPNext qty); repair target ref + kind + outcome + resolved
-- ERPNext document ref. NO PII, NO payment/tender data, NO money/valuation.
-- Retention inherits the 001 long-horizon posture; runs/reports/attempts are
-- retained (status, not deleted) for the operability/audit surface. If a later
-- slice admits a PII or money field, this RECLASSIFIES and re-triggers §XIV.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. erpnext_reconciliation_run -------------------------------------------------
CREATE TABLE IF NOT EXISTS erpnext_reconciliation_run (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- A stock run is always store-scoped (it needs the 014 mapping). Tenant-local
  -- FK, NOT a second RLS axis (the 0018/0019 precedent).
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  -- STOCK-ONLY in v1 (data-model §2.1): the posting backlog is a read-projection,
  -- not a run. The CHECK reserves room for a future 'posting' snapshot run.
  kind            TEXT         NOT NULL DEFAULT 'stock',
  trigger         TEXT         NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'running',
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  -- Counts by mismatch class — BUSINESS-class counts ONLY, never PII/money.
  summary         JSONB,
  -- The operator for an on-demand run; NULL for a scheduled run (a future arc).
  actor_user_id   UUID         REFERENCES users(id) ON DELETE SET NULL,
  correlation_id  UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_reconciliation_run_kind_valid
    CHECK (kind IN ('stock')),
  CONSTRAINT erpnext_reconciliation_run_trigger_valid
    CHECK (trigger IN ('on_demand', 'scheduled')),
  CONSTRAINT erpnext_reconciliation_run_status_valid
    CHECK (status IN ('running', 'completed', 'failed')),
  -- A terminal run carries finished_at; a running run does not.
  CONSTRAINT erpnext_reconciliation_run_finished_when_terminal
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Per-tenant run history (operator review, newest first).
CREATE INDEX IF NOT EXISTS idx_erpnext_reconciliation_run_tenant_time
  ON erpnext_reconciliation_run (tenant_id, started_at DESC);

-- 2. erpnext_reconciliation_result ----------------------------------------------
CREATE TABLE IF NOT EXISTS erpnext_reconciliation_result (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Single-column FK to the run PK (advisor #1). RLS scopes both rows to one tenant.
  run_id          UUID         NOT NULL REFERENCES erpnext_reconciliation_run(id) ON DELETE RESTRICT,
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- 014's mismatch-class vocabulary ONLY (014 data-model §6.2, finalized). The
  -- 015 posting categories are NOT here — posting dead-letters are read in place
  -- on the 015 rows, never mirrored as 017 results (READ-NOT-MIRROR / R2).
  mismatch_class  TEXT         NOT NULL,
  -- The originating ref for a stock line (the product ref); NULL for an aggregate
  -- line. POLYMORPHIC — deliberately NO FK (the 0019 source_ref_id rationale).
  source_ref_id   UUID,
  source_system   TEXT,
  external_id     TEXT,
  -- 017's OWN orthogonal workflow status (distinct from the mismatch class).
  result_state    TEXT         NOT NULL DEFAULT 'open',
  -- Operator-facing values (DP2 vs ERPNext qty etc.) — qty/refs, NEVER PII/money.
  detail          JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_reconciliation_result_class_valid
    CHECK (mismatch_class IN (
      'match', 'quantity_divergence', 'unmapped_store', 'unmapped_item',
      'dp2_only', 'erpnext_only', 'negative_balance_flagged'
    )),
  CONSTRAINT erpnext_reconciliation_result_state_valid
    CHECK (result_state IN ('open', 'repaired', 'accepted'))
);

-- Per-run results scan (the mismatch report), filterable by class.
CREATE INDEX IF NOT EXISTS idx_erpnext_reconciliation_result_run
  ON erpnext_reconciliation_result (tenant_id, run_id, mismatch_class);

-- 3. erpnext_reconciliation_repair_attempt --------------------------------------
CREATE TABLE IF NOT EXISTS erpnext_reconciliation_repair_attempt (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_kind           TEXT         NOT NULL,
  -- The 015 erpnext_posting_status.id (posting repair) OR a result id (stock).
  -- POLYMORPHIC — deliberately NO FK (the 0019 source_ref_id rationale).
  target_ref_id         UUID         NOT NULL,
  repair_kind           TEXT         NOT NULL,
  actor_user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  outcome               TEXT         NOT NULL,
  -- Echoed when a posting repair resolves to a posted document (O-3).
  resolved_document_ref TEXT,
  correlation_id        UUID,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT erpnext_reconciliation_repair_attempt_target_kind_valid
    CHECK (target_kind IN ('posting', 'stock')),
  CONSTRAINT erpnext_reconciliation_repair_attempt_repair_kind_valid
    CHECK (repair_kind IN ('re_post', 're_map', 're_sync', 'drain')),
  CONSTRAINT erpnext_reconciliation_repair_attempt_outcome_valid
    CHECK (outcome IN ('eligible_again', 'still_failing', 'no_op_echo'))
);

-- Repair history for a target (audit lookup).
CREATE INDEX IF NOT EXISTS idx_erpnext_reconciliation_repair_attempt_target
  ON erpnext_reconciliation_repair_attempt (tenant_id, target_kind, target_ref_id);

-- RLS — ENABLE + FORCE, fail-closed empty-GUC CASE guard (0009/0010/0017/0018/0019).
ALTER TABLE erpnext_reconciliation_run             ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_reconciliation_run             FORCE  ROW LEVEL SECURITY;
ALTER TABLE erpnext_reconciliation_result          ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_reconciliation_result          FORCE  ROW LEVEL SECURITY;
ALTER TABLE erpnext_reconciliation_repair_attempt  ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_reconciliation_repair_attempt  FORCE  ROW LEVEL SECURITY;

-- run: SELECT + INSERT + UPDATE (running -> terminal). NO DELETE.
CREATE POLICY erpnext_reconciliation_run_tenant_read ON erpnext_reconciliation_run
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_reconciliation_run_tenant_insert ON erpnext_reconciliation_run
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_reconciliation_run_tenant_update ON erpnext_reconciliation_run
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- result: SELECT + INSERT + UPDATE (open -> repaired/accepted). NO DELETE.
CREATE POLICY erpnext_reconciliation_result_tenant_read ON erpnext_reconciliation_result
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_reconciliation_result_tenant_insert ON erpnext_reconciliation_result
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_reconciliation_result_tenant_update ON erpnext_reconciliation_result
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- repair_attempt: APPEND-ONLY — SELECT + INSERT only. NO UPDATE, NO DELETE.
CREATE POLICY erpnext_reconciliation_repair_attempt_tenant_read ON erpnext_reconciliation_repair_attempt
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY erpnext_reconciliation_repair_attempt_tenant_insert ON erpnext_reconciliation_repair_attempt
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
