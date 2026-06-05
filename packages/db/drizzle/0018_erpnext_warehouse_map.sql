-- 0018_erpnext_warehouse_map.sql
--
-- Branch Inventory Reconciliation & Warehouse Mapping (014) — [GATED] schema +
-- migration (014-SCHEMA / T012).
--
-- Source-of-truth artifacts:
--   - specs/014-branch-inventory-reconciliation-and-warehouse-mapping/data-model.md  §2 (entity), §3 (purpose grain), §4 (concurrency), §5 (RLS)
--   - specs/014-branch-inventory-reconciliation-and-warehouse-mapping/plan.md         (OQ-1/2/3 locks; the §IX split)
--   - packages/db/src/schema/catalog/erpnext-warehouse-map.ts
--   - packages/db/__tests__/migration/0018-erpnext-warehouse-map.spec.ts             (round-trip, Docker-gated)
--   - apps/api/test/catalog/erpnext-warehouse-map/schema/erpnext-warehouse-map-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates ONE table: `erpnext_warehouse_map` — the store↔ERPNext-Warehouse
-- mapping linking a DP2 `stores` row to an ERPNext Warehouse reference, so
-- ERPNext can VALUE the same physical stock the store holds and the
-- reconciliation (017) + future posting (015) target the right warehouse. It
-- is a PURE MAPPING table, NOT a stock-authority handover (OQ-1, §IX, the
-- SIGNED stock-impact decision): DP2's 009 ledger stays the OPERATIONAL on-hand
-- authority; ERPNext owns VALUATION; read-down is rejected.
--
-- erpnext_warehouse_ref: TEXT, NO FK — ERPNext is external, reached only via
--   the connector (012 O-6 version-independence). Mirrors the 013
--   `erpnext_item_ref` / 003 `source_global_product_id` no-FK rationale: never
--   couple a DP2 row's lifecycle to an out-of-DP2 catalogue. The ERPNext major
--   is UNCONFIRMED (assumption A-1); the reference is a DP2-terms string,
--   version-independent.
--
-- OQ-2 forward-compat (the `purpose` grain): a PARTIAL unique index
--   (tenant_id, store_id, PURPOSE) WHERE retired_at IS NULL — at most ONE active
--   mapping per (store, purpose). v1 ONLY ever writes `purpose='stock'`, so it
--   behaves strictly 1:1 per store; the `purpose` enum reserves 'returns' for
--   the owner's future expired/returns warehouse, which can coexist WITHOUT a
--   breaking migration. Retired rows accumulate as history (re-point is
--   append-only: retire old + new row, never an in-place identity rewrite).
--   Mirrors the 003/013 `WHERE retired_at IS NULL` partial uniques.
--
-- Concurrency (§III): `version` is the optimistic-concurrency token — a
--   DELIBERATE, justified divergence from the 003 catalog tables'
--   last-write-wins. A warehouse re-point is an explicit, low-volume admin
--   trust action; the retire/update API uses `... WHERE id = $1 AND version =
--   $2`, incrementing version; a stale version is a 409. version >= 1 (CHECK).
--
-- Mutable tenant-owned resource: unlike the insert-only 009 ledger, this table
--   transitions set -> updated -> retired, so it gets SELECT + INSERT + UPDATE
--   RLS policies (the retire/re-point writes are UPDATEs/INSERTs; mirrors the
--   0017 erpnext_item_map mutable-table pattern). NO DELETE policy — rows are
--   soft-deleted via retired_at, never hard-deleted by the app.
--
-- NO Bin-quantity / valuation / cost / on-hand column (OQ-1): a standing DP2
--   copy of ERPNext stock is exactly the read-down look-alike the signed
--   decision rejects; Bin quantities are fetched on-demand by 017, never stored
--   here. Valuation/cost is ERPNext's authority; on-hand is computed-on-read
--   from 009. This table is mapping only.
--
-- RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   migrations 0009/0010, also used by 013's 0017). NULL tenant => row filtered
--   => fail-closed.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: store reference (store_id), ERPNext Warehouse reference
-- (erpnext_warehouse_ref), purpose, actor id, correlation id. NO PII, NO
-- payment/tender data, NO stock quantity. Retention inherits the 001
-- long-horizon posture; soft-delete (retired_at) is the default, hard-delete is
-- a privileged audited platform op. If a later slice admits a PII field, this
-- RECLASSIFIES and re-triggers the §XIV review.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS erpnext_warehouse_map (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id               UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- OQ-2 forward-compat discriminator. v1 only ever writes 'stock'.
  purpose                TEXT         NOT NULL DEFAULT 'stock',
  -- ERPNext Warehouse reference in DP2 terms. NO FK (external / version-independent).
  erpnext_warehouse_ref  TEXT         NOT NULL,
  set_by                 UUID,
  set_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  version                INTEGER      NOT NULL DEFAULT 1,
  retired_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id         UUID,
  CONSTRAINT erpnext_warehouse_map_purpose_valid
    CHECK (purpose IN ('stock', 'returns')),
  CONSTRAINT erpnext_warehouse_map_ref_length
    CHECK (length(erpnext_warehouse_ref) BETWEEN 1 AND 180),
  CONSTRAINT erpnext_warehouse_map_version_positive
    CHECK (version >= 1)
);

-- OQ-2 forward-compat 1:1 — at most one ACTIVE mapping per (tenant, store,
-- purpose). v1 only writes 'stock' => strict 1:1 per store; a future 'returns'
-- row coexists without a breaking migration. Retired rows accumulate as
-- history, so the uniqueness is partial on the active set.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_erpnext_warehouse_map_active"
  ON erpnext_warehouse_map (tenant_id, store_id, purpose)
  WHERE retired_at IS NULL;

-- Reverse lookup — which store(s) point at an ERPNext Warehouse (reconciliation/audit).
CREATE INDEX IF NOT EXISTS idx_erpnext_warehouse_map_ref
  ON erpnext_warehouse_map (tenant_id, erpnext_warehouse_ref)
  WHERE retired_at IS NULL;

ALTER TABLE erpnext_warehouse_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_warehouse_map FORCE ROW LEVEL SECURITY;

CREATE POLICY erpnext_warehouse_map_tenant_read ON erpnext_warehouse_map
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY erpnext_warehouse_map_tenant_insert ON erpnext_warehouse_map
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- Mutable (set -> updated -> retired). UPDATE is tenant-scoped; the
-- optimistic-version check + column-level immutability are enforced at the
-- service boundary. NO DELETE policy — soft-delete via retired_at only.
CREATE POLICY erpnext_warehouse_map_tenant_update ON erpnext_warehouse_map
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
