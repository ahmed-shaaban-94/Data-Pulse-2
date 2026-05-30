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
-- RLS: ENABLE + FORCE on every table; fail-closed tenant policy keyed on
--   current_setting('app.current_tenant', true)::uuid (FR-060).
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
-- 008-LIFECYCLE) asserts no PII/payment-class field is persisted in v1.
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
    CHECK (pos_total >= 0)
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

CREATE POLICY sales_tenant_write ON sales
  FOR ALL
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 2. sale_lines (data-model.md §2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_lines (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id             UUID          NOT NULL REFERENCES sales(id)   ON DELETE RESTRICT,
  tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id            UUID          NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  line_name           TEXT          NOT NULL,
  unit_price          NUMERIC(19,4) NOT NULL,
  currency_code       CHAR(3)       NOT NULL,
  quantity            NUMERIC(19,6) NOT NULL,
  line_amount         NUMERIC(19,4) NOT NULL,
  tax_amount          NUMERIC(19,4),
  unit                TEXT          NOT NULL,
  -- Soft lineage only (FR-003); NULL for ad-hoc lines (FR-004). NO FK — the
  -- line is a frozen snapshot, never a live read of the tenant product.
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
    CHECK (tax_amount IS NULL OR tax_amount >= 0)
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

CREATE POLICY sale_lines_tenant_write ON sale_lines
  FOR ALL
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 3. sale_voids (data-model.md §3) — append-only terminal event
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_voids (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        UUID         NOT NULL REFERENCES sales(id)   ON DELETE RESTRICT,
  tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id       UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  voided_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  source_system  TEXT         NOT NULL,
  external_id    TEXT         NOT NULL,
  payload_hash   TEXT         NOT NULL,
  created_by     UUID         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
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

CREATE POLICY sale_voids_tenant_write ON sale_voids
  FOR ALL
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- =============================================================================
-- 4. sale_refunds (data-model.md §4) — append-only terminal event
-- =============================================================================

CREATE TABLE IF NOT EXISTS sale_refunds (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            UUID          NOT NULL REFERENCES sales(id)   ON DELETE RESTRICT,
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
    CHECK (pos_refund_amount >= 0)
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

CREATE POLICY sale_refunds_tenant_write ON sale_refunds
  FOR ALL
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
