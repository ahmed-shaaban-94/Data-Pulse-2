-- 0017_erpnext_item_map.sql
--
-- Product Master from ERPNext (013) — [GATED] schema + migration (013-SCHEMA / T012).
--
-- Source-of-truth artifacts:
--   - specs/013-product-master-from-erpnext/data-model.md   §2 (entity), §3 (confirmed-only), §4 (concurrency), §5 (RLS)
--   - specs/013-product-master-from-erpnext/spec.md         §5 (the §IX mapping/reconciliation split)
--   - packages/db/src/schema/catalog/erpnext-item-map.ts
--   - packages/db/__tests__/migration/0017-erpnext-item-map.spec.ts          (round-trip, Docker-gated)
--   - apps/api/test/catalog/erpnext-item-map/schema/erpnext-item-map-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates ONE table: `erpnext_item_map` — the product-master identity mapping
-- linking a DP2 `tenant_products` row to an ERPNext Item reference, so a future
-- sale posting (015) resolves each sale line to a real Item (posting decision
-- §1; "fails-to-DLQ if not"). It is a MAPPING/RECONCILIATION layer, NOT a
-- catalog-authority handover (OQ-1, §IX): `tenant_products` stays authoritative
-- for the retail product; ERPNext owns accounting Item identity only.
--
-- erpnext_item_ref: TEXT, NO FK — ERPNext is external, reached only via the
--   connector (012 O-6 version-independence). Mirrors the 003
--   `source_global_product_id` no-FK rationale: never couple a DP2 row's
--   lifecycle to an out-of-DP2 catalogue. The ERPNext major is UNCONFIRMED
--   (assumption A-1); the reference is a DP2-terms string, version-independent.
--
-- 1:1 (OQ-2): a PARTIAL unique index (tenant_id, tenant_product_id) WHERE
--   retired_at IS NULL — at most ONE active mapping per tenant product. Retired
--   rows accumulate as history (re-point is append-only: retire old + new row,
--   never an in-place identity rewrite). Mirrors 003 `WHERE retired_at IS NULL`
--   partial uniques.
--
-- Confirmed-only invariant (OQ-7 / data-model §3): `state` is
--   'suggested' | 'confirmed'. A CHECK pairs state='confirmed' with
--   confirmed_by/confirmed_at NOT NULL (and state='suggested' with both NULL),
--   so the posting path can NEVER resolve an unconfirmed match ("no silent
--   auto-trust"). v1 suggest is MANUAL-ONLY (suggestion_source='manual';
--   barcode|item_code kept in the enum for a future ERPNext item-search op —
--   finding AUTO_MATCH_NO_SOURCE; no such op exists in 012 today).
--
-- Concurrency (§III): `version` is the optimistic-concurrency token — a
--   DELIBERATE, justified divergence from the 003 catalog tables'
--   last-write-wins. A confirmation is a trust action; the confirm/retire API
--   uses `... WHERE id = $1 AND version = $2`, incrementing version; a stale
--   version is a 409. version >= 1 (CHECK).
--
-- Mutable tenant-owned resource: unlike the insert-only 009 ledger, this table
--   transitions suggested -> confirmed -> retired, so it gets SELECT + INSERT +
--   UPDATE RLS policies (the confirm/retire/re-point writes are UPDATEs/INSERTs;
--   mirrors the 0012 `sales` mutable-table pattern). NO DELETE policy — rows are
--   soft-deleted via retired_at, never hard-deleted by the app.
--
-- NO UOM, price, price-list, or store_id column (OQ-3/OQ-4 resolved as
--   no-column; tenant-wide identity — data-model §1/§6). UOM is a connector/015
--   concern; DP2 amounts stay authoritative (no ERPNext repricing).
--
-- RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   migrations 0009/0010). NULL tenant ⇒ row filtered ⇒ fail-closed.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: catalog references (tenant_product_id, erpnext_item_ref),
-- mapping state, actor ids, correlation id. NO PII, NO payment/tender data.
-- Retention inherits the 001 long-horizon posture; soft-delete (retired_at) is
-- the default, hard-delete is a privileged audited platform op. If a later
-- slice admits a PII field, this RECLASSIFIES and re-triggers the §XIV review.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS erpnext_item_map (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id)         ON DELETE RESTRICT,
  tenant_product_id   UUID         NOT NULL REFERENCES tenant_products(id) ON DELETE RESTRICT,
  -- ERPNext Item reference in DP2 terms. NO FK (external / version-independent).
  erpnext_item_ref    TEXT         NOT NULL,
  state               TEXT         NOT NULL DEFAULT 'suggested',
  suggestion_source   TEXT         NOT NULL,
  suggested_by        UUID,
  suggested_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  confirmed_by        UUID,
  confirmed_at        TIMESTAMPTZ,
  version             INTEGER      NOT NULL DEFAULT 1,
  retired_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id      UUID,
  CONSTRAINT erpnext_item_map_state_valid
    CHECK (state IN ('suggested', 'confirmed')),
  CONSTRAINT erpnext_item_map_suggestion_source_valid
    CHECK (suggestion_source IN ('barcode', 'item_code', 'manual')),
  CONSTRAINT erpnext_item_map_item_ref_length
    CHECK (length(erpnext_item_ref) BETWEEN 1 AND 140),
  -- Confirmed-only invariant: confirmed <=> confirm provenance present.
  CONSTRAINT erpnext_item_map_confirmed_paired
    CHECK (
      (state = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
      OR
      (state = 'suggested' AND confirmed_by IS NULL AND confirmed_at IS NULL)
    ),
  CONSTRAINT erpnext_item_map_version_positive
    CHECK (version >= 1)
);

-- OQ-2 1:1 — at most one ACTIVE mapping per (tenant, product). Retired rows
-- accumulate as history, so the uniqueness is partial on the active set.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_erpnext_item_map_active"
  ON erpnext_item_map (tenant_id, tenant_product_id)
  WHERE retired_at IS NULL;

-- Tenant-Admin review queue: suggestions awaiting confirmation.
CREATE INDEX IF NOT EXISTS idx_erpnext_item_map_unconfirmed
  ON erpnext_item_map (tenant_id, state)
  WHERE state = 'suggested' AND retired_at IS NULL;

-- Reverse lookup — which product(s) point at an ERPNext Item (reconciliation).
CREATE INDEX IF NOT EXISTS idx_erpnext_item_map_item_ref
  ON erpnext_item_map (tenant_id, erpnext_item_ref)
  WHERE retired_at IS NULL;

ALTER TABLE erpnext_item_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_item_map FORCE ROW LEVEL SECURITY;

CREATE POLICY erpnext_item_map_tenant_read ON erpnext_item_map
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY erpnext_item_map_tenant_insert ON erpnext_item_map
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- Mutable (suggested -> confirmed -> retired). UPDATE is tenant-scoped; the
-- optimistic-version check + column-level immutability are enforced at the
-- service boundary. NO DELETE policy — soft-delete via retired_at only.
CREATE POLICY erpnext_item_map_tenant_update ON erpnext_item_map
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
