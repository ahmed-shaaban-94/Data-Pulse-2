-- 0014_inventory.sql
--
-- Inventory & Stock Movement Ledger (009) — [GATED] schema + migration (T013).
--
-- Source-of-truth artifacts:
--   - specs/009-inventory-stock-ledger/data-model.md            §1 (stock_movements), §4 (stock_counts)
--   - specs/009-inventory-stock-ledger/research.md              R1-R8
--   - packages/db/src/schema/inventory/stock-movements.ts
--   - packages/db/__tests__/migration/0014-inventory.spec.ts    (round-trip test, Docker-gated)
--   - apps/api/test/inventory/schema/stock-movements-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates the Inventory source-of-truth domain, in dependency order:
--   1. stock_counts     — a recorded physical count (provenance for a variance
--                         correction movement). Created FIRST because
--                         stock_movements.stock_count_id references it.
--   2. stock_movements  — the append-only stock ledger. On-hand is the derived
--                         (compute-on-read) signed SUM of a key's movements
--                         (FR-003) — there is NO materialized balance table.
--
-- Quantity: NUMERIC(19,4) exact-decimal (no float), SIGNED — outbound negative,
--   inbound positive (FR-022). The on-hand SUM MAY go negative (allow-and-flag,
--   FR-024); there is no non-negative CHECK on movement quantity.
-- movement_type: TEXT + CHECK (no pgEnum precedent in repo; enum migrations are
--   costly) — inbound | outbound | adjustment | transfer_out | transfer_in |
--   count_correction (FR-002). Write-off is a reason-coded outbound.
-- Timestamps: TIMESTAMPTZ in UTC; occurred_at / received_at NOT NULL (§X).
--   received_at is the security clock; occurred_at may be backfilled.
--
-- Immutability (FR-001 / R7): movements are an append-only fact. NO `version`
--   column (allow-and-flag dissolves the read-compute-write race — nothing is
--   overwritten). Enforced at the RLS layer: each table gets SELECT + INSERT
--   policies ONLY — NO UPDATE, NO DELETE policy — so even a role holding
--   UPDATE/DELETE grants is denied under FORCE. (Unlike 008 `sales`, there is
--   no SaaS-owned mutable column here, so no UPDATE policy is needed at all.)
--
-- Dedup (R4 / FR-030/031): ONE movement-level unique index only — the backfill
--   provenance partial-unique (tenant_id, source_system, external_id) WHERE
--   both NOT NULL. Manual-movement dedup lives in the 001/005 Idempotency-Key
--   interceptor (idempotency_keys table), NOT a stock_movements index;
--   idempotency_key here is a LINEAGE-ONLY nullable column. A provenance-pair
--   CHECK keeps source_system/external_id all-or-nothing.
--
-- Product identity (FR-023 / R5): tenant_product_ref -> tenant_products is
--   NULLABLE — ad-hoc / unresolved references are provenance only, never
--   auto-created; a null-product movement rolls up to no product's on-hand.
--
-- Provenance only (FR-032/025): sale_id / sale_line_id / terminal_event_ref
--   reference the CAPTURED 008 sale fact. They are NEVER required and the
--   ledger does NOT depend on the gated 008 live loop (decoupling, SC-002).
--   These are intentionally NOT foreign keys — a movement may reference a sale
--   that is archived/erased later, and the backfill reads captured rows by
--   value, not by enforced relational integrity.
--
-- Cross-tenant integrity: a count_correction movement's stock_count_id carries
--   a composite FK (stock_count_id, tenant_id, store_id) ->
--   stock_counts (id, tenant_id, store_id) so a correction can never attach to
--   a count in a different tenant/store (defense-in-depth beneath RLS).
--
-- Pharmacy seam (FR-040/041): NO batch/expiry/serial column on the base
--   movement. A future nullable stock_lot_id / stock_serial_id FK is the only
--   addition needed later, leaving generic-retail movements valid (no rewrite).
--   Deliberately absent in v1.
--
-- RLS: ENABLE + FORCE on every table; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   migrations 0009/0010). NULL = tenant_id ⇒ NULL ⇒ row filtered ⇒
--   fail-closed (FR-050/060).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (T095 / §XIV)
-- ---------------------------------------------------------------------------
-- The two entities created here are BUSINESS-CLASS data: catalog references,
-- quantities, provenance ids, and bounded reason text only. They contain NO
-- PII and NO payment/tender data in v1. Retention INHERITS the 001
-- long-horizon, insert-only audit-retention posture for the immutable ledger.
-- Right-to-erasure is handled by TOMBSTONING any future PII field rather than
-- deleting a movement row. If a later slice admits a customer-reference field,
-- this RECLASSIFIES (PII-class) and re-triggers the §XIV review. The
-- 009-LIFECYCLE slice adds a guard test asserting no PII/payment-class field is
-- persisted in v1.
-- ---------------------------------------------------------------------------

BEGIN;

-- ===========================================================================
-- 1. stock_counts (data-model.md §4) — created first (movements FK it)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS stock_counts (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id                  UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- Nullable per R5 (ad-hoc product).
  tenant_product_ref        UUID          REFERENCES tenant_products(id) ON DELETE RESTRICT,
  counted_quantity          NUMERIC(19,4) NOT NULL,
  derived_on_hand_at_count  NUMERIC(19,4) NOT NULL,
  stocking_unit             TEXT          NOT NULL,
  counted_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by                UUID          NOT NULL,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Backs the composite FK from stock_movements.stock_count_id.
  CONSTRAINT uq_stock_counts_id_tenant_store
    UNIQUE (id, tenant_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_tenant_store_product
  ON stock_counts (tenant_id, store_id, tenant_product_ref);

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_counts_tenant_read ON stock_counts
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: append-only fact, no UPDATE/DELETE policy.
CREATE POLICY stock_counts_tenant_insert ON stock_counts
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- ===========================================================================
-- 2. stock_movements (data-model.md §1) — the append-only ledger
-- ===========================================================================
CREATE TABLE IF NOT EXISTS stock_movements (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id            UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  movement_type       TEXT          NOT NULL,
  -- SIGNED exact-decimal quantity in the stocking unit (FR-022); MAY be
  -- negative; the on-hand SUM MAY go negative (allow-and-flag, FR-024).
  quantity            NUMERIC(19,4) NOT NULL,
  stocking_unit       TEXT          NOT NULL,
  -- Nullable per R5 (ad-hoc / unresolved product); never auto-created (FR-023).
  tenant_product_ref  UUID          REFERENCES tenant_products(id) ON DELETE RESTRICT,
  reason              TEXT,
  occurred_at         TIMESTAMPTZ   NOT NULL,
  received_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- LINEAGE ONLY — manual dedup lives in the interceptor, NOT here (R4/FR-030).
  idempotency_key     TEXT,
  -- Backfill / external-origin provenance + dedup pair (R4/FR-031).
  source_system       TEXT,
  external_id         TEXT,
  -- Provenance only — CAPTURED 008 sale fact (FR-032/025). NOT foreign keys.
  sale_id             UUID,
  sale_line_id        UUID,
  terminal_event_ref  UUID,
  transfer_group_id   UUID,
  stock_count_id      UUID,
  created_by          UUID          NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_type_allowed
    CHECK (movement_type IN ('inbound','outbound','adjustment','transfer_out','transfer_in','count_correction')),
  -- Provenance pair is all-or-nothing (a half-pair cannot dedup).
  CONSTRAINT stock_movements_provenance_pair
    CHECK ((source_system IS NULL) = (external_id IS NULL)),
  -- Cross-tenant integrity: a count_correction's count must be in the SAME
  -- tenant + store (composite FK into stock_counts).
  CONSTRAINT fk_stock_movements_count_tenant_store
    FOREIGN KEY (stock_count_id, tenant_id, store_id)
    REFERENCES stock_counts (id, tenant_id, store_id) ON DELETE RESTRICT
);

-- ONE movement-level dedup index (FR-031): backfill provenance. Partial —
-- manual movements (NULL provenance) are not deduped here (interceptor handles
-- them). There is intentionally NO (tenant_id, store_id, idempotency_key) index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_tenant_source_external
  ON stock_movements (tenant_id, source_system, external_id)
  WHERE source_system IS NOT NULL AND external_id IS NOT NULL;

-- Backs the compute-on-read on-hand SUM over (tenant, store, product).
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_store_product
  ON stock_movements (tenant_id, store_id, tenant_product_ref);

CREATE INDEX IF NOT EXISTS idx_stock_movements_transfer_group
  ON stock_movements (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;

CREATE POLICY stock_movements_tenant_read ON stock_movements
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: append-only ledger, no UPDATE/DELETE policy (FR-001). Even a
-- role with UPDATE/DELETE grants is denied under FORCE.
CREATE POLICY stock_movements_tenant_insert ON stock_movements
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
