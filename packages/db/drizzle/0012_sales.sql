-- 0012_sales.sql
--
-- Sales / Transaction Capture (008) — [GATED] schema + migration (T013).
--
-- Source-of-truth artifacts:
--   - specs/008-sales-transaction-capture/data-model.md   §1-§4
--   - specs/008-sales-transaction-capture/gate-money-temporal.md (gates A/B/C/D)
--   - packages/db/src/schema/sales/{sales,sale-lines,sale-terminal-events}.ts
--   - packages/db/__tests__/migration/0012-sales.spec.ts  (RED round-trip test)
--
-- Creates the FIRST sale fact the SaaS owns, in dependency order:
--   1. sales            — immutable sale header (one per (tenant, source, external)).
--   2. sale_lines       — per-line frozen snapshot (child of sales).
--   3. sale_voids       — append-only void terminal event (references sales).
--   4. sale_refunds     — append-only refund terminal event (references sales).
--
-- Money: numeric(19,4) + char(3) ISO currency (gate A.1/A.6), paired-currency
--   + non-negative CHECK (mirror 0007 catalog money discipline). No float.
-- Timestamps: TIMESTAMPTZ in UTC; gate-B nullability (occurred_at/received_at
--   NOT NULL; processed_at/source_clock_at nullable). business_date is DATE
--   (store-tz derived, FR-023).
-- Immutability: NO `version` column (gate D.1 / FR-070). NO tender/payment
--   columns (gate A.5 — deferred to 010).
-- Dedup: UNIQUE (tenant_id, source_system, external_id) on sales and on each
--   terminal-event table (FR-050/013).
--
-- Append-only enforcement at the RLS layer (CodeRabbit #421 review):
--   - sale_lines / sale_voids / sale_refunds are TRULY immutable once written:
--     each gets a SELECT policy + an INSERT-only write policy. NO UPDATE/DELETE
--     policy exists, so even a role holding UPDATE/DELETE grants is denied by
--     RLS (FORCE), preserving the append-only contract.
--   - sales is immutable EXCEPT for the SaaS-owned processed_at + mismatch_flag,
--     which the off-request worker sets (FR-071). It therefore gets SELECT +
--     INSERT + UPDATE policies (NO DELETE). The columns the UPDATE may touch are
--     constrained at the service layer (FR-061 mass-assignment ban); RLS here
--     enforces tenant scope on the update, not column-level immutability.
--
-- Cross-tenant integrity (CodeRabbit #421 review): each child carries a
--   composite FK (sale_id, tenant_id, store_id) -> sales(id, tenant_id, store_id)
--   so a child row can never reference a sale in a different tenant/store. This
--   is defense-in-depth beneath the per-table RLS (which already filters each
--   table by its own tenant_id).
--
-- RLS: ENABLE + FORCE on every table; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from
--   migrations 0009/0010). NULL = tenant_id evaluates to NULL → row filtered
--   → fail-closed (FR-060).
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (T075 / SI-012 / gate D.3, §XIV)
-- ---------------------------------------------------------------------------
-- The four entities created here are BUSINESS-CLASS data: catalog references,
-- quantities, and POS-reported totals only. They contain NO PII and NO
-- payment/tender data in v1 (tender is deferred per gate A.5). Retention
-- INHERITS the 001 long-horizon, insert-only audit-retention posture for the
-- immutable fact. Right-to-erasure is handled by TOMBSTONING any future PII
-- field rather than deleting the fact row. If a later slice admits a
-- customer-reference or tender field, this RECLASSIFIES (PII/payment-class)
-- and re-triggers SI-012. A guard test
-- (apps/api/test/catalog/sales/lifecycle/classification.spec.ts, slice
-- 008-LIFECYCLE) will assert no PII/payment-class field is persisted in v1.
--
-- Lock duration: all four are CREATE TABLE on NEW relations (no ALTER on a
-- populated table, no rewrite), so the migration takes only brief catalog
-- locks and does not block concurrent traffic. Reversible via
-- `0012_sales.down.sql`.

BEGIN;

-- =============================================================================
-- 1. sales (data-model.md §1)
-- =============================================================================

CREATE TABLE IF NOT EXISTS sales (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id         UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  currency_code    CHAR(3)      NOT NULL,
  pos_total        NUMERIC(19,4) NOT NULL,
  occurred_at      TIMESTAMPTZ  NOT NULL,
  received_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  business_date    DATE         NOT NULL,
  processed_at     TIMESTAMPTZ,
  source_clock_at  TIMESTAMPTZ,
  source_system    TEXT         NOT NULL,
  external_id      TEXT         NOT NULL,
  payload_hash     TEXT         NOT NULL,
  mismatch_flag    BOOLEAN,
  created_by       UUID         NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT sales_currency_code_format
    CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sales_pos_total_non_negative
    CHECK (pos_total >= 0),
  -- Backs the composite FK from every child table (id is already the PK; this
  -- adds the (id, tenant_id, store_id) tuple the children reference).
  CONSTRAINT uq_sales_id_tenant_store
    UNIQUE (id, tenant_id, store_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tenant_source_external
  ON sales (tenant_id, source_system, external_id);

CREATE INDEX IF NOT EXISTS idx_sales_tenant_store
  ON sales (tenant_id, store_id);

CREATE INDEX IF NOT EXISTS idx_sales_business_date
  ON sales (tenant_id, business_date);

CREATE INDEX IF NOT EXISTS idx_sales_unprocessed
  ON sales (tenant_id) WHERE processed_at IS NULL;

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;

CREATE POLICY sales_tenant_read ON sales
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sales_tenant_insert ON sales
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- sales is immutable EXCEPT processed_at + mismatch_flag (SaaS-owned, FR-071,
-- set off-request by the worker). UPDATE is tenant-scoped here; column-level
-- immutability is enforced at the service boundary. NO DELETE policy exists.
CREATE POLICY sales_tenant_update ON sales
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 2. sale_lines (data-model.md §2) — frozen snapshot, INSERT-only
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_lines (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             UUID          NOT NULL,
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id            UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  line_name           TEXT          NOT NULL,
  unit_price          NUMERIC(19,4) NOT NULL,
  currency_code       CHAR(3)       NOT NULL,
  quantity            NUMERIC(19,6) NOT NULL,
  line_amount         NUMERIC(19,4) NOT NULL,
  tax_amount          NUMERIC(19,4),
  unit                TEXT          NOT NULL,
  -- Soft lineage only (FR-003); NULL for ad-hoc lines (FR-004). NO FK to
  -- tenant_products — the line is a frozen snapshot, never a live read.
  tenant_product_ref  UUID,
  CONSTRAINT sale_lines_currency_code_format
    CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_lines_unit_price_non_negative
    CHECK (unit_price >= 0),
  CONSTRAINT sale_lines_line_amount_non_negative
    CHECK (line_amount >= 0),
  CONSTRAINT sale_lines_quantity_non_negative
    CHECK (quantity >= 0),
  CONSTRAINT sale_lines_tax_amount_non_negative
    CHECK (tax_amount IS NULL OR tax_amount >= 0),
  -- Composite FK: a line can only attach to a sale in the SAME tenant + store.
  CONSTRAINT fk_sale_lines_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sale_lines_sale
  ON sale_lines (sale_id);

CREATE INDEX IF NOT EXISTS idx_sale_lines_tenant_store
  ON sale_lines (tenant_id, store_id);

ALTER TABLE sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_lines_tenant_read ON sale_lines
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: frozen snapshot, no UPDATE/DELETE policy (append-only contract).
CREATE POLICY sale_lines_tenant_insert ON sale_lines
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. sale_voids (data-model.md §3) — append-only terminal event, INSERT-only
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_voids (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        UUID         NOT NULL,
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id       UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  voided_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  source_system  TEXT         NOT NULL,
  external_id    TEXT         NOT NULL,
  payload_hash   TEXT         NOT NULL,
  created_by     UUID         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_sale_voids_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_voids_tenant_source_external
  ON sale_voids (tenant_id, source_system, external_id);

CREATE INDEX IF NOT EXISTS idx_sale_voids_sale
  ON sale_voids (sale_id);

CREATE INDEX IF NOT EXISTS idx_sale_voids_tenant_store
  ON sale_voids (tenant_id, store_id);

ALTER TABLE sale_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_voids FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_voids_tenant_read ON sale_voids
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_voids_tenant_insert ON sale_voids
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4. sale_refunds (data-model.md §4) — append-only terminal event, INSERT-only
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_refunds (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            UUID          NOT NULL,
  tenant_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id           UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  refunded_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  pos_refund_amount  NUMERIC(19,4) NOT NULL,
  currency_code      CHAR(3)       NOT NULL,
  source_system      TEXT          NOT NULL,
  external_id        TEXT          NOT NULL,
  payload_hash       TEXT          NOT NULL,
  created_by         UUID          NOT NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT sale_refunds_currency_code_format
    CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT sale_refunds_pos_refund_amount_non_negative
    CHECK (pos_refund_amount >= 0),
  CONSTRAINT fk_sale_refunds_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_refunds_tenant_source_external
  ON sale_refunds (tenant_id, source_system, external_id);

CREATE INDEX IF NOT EXISTS idx_sale_refunds_sale
  ON sale_refunds (sale_id);

CREATE INDEX IF NOT EXISTS idx_sale_refunds_tenant_store
  ON sale_refunds (tenant_id, store_id);

ALTER TABLE sale_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_refunds FORCE ROW LEVEL SECURITY;

CREATE POLICY sale_refunds_tenant_read ON sale_refunds
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_refunds_tenant_insert ON sale_refunds
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
