-- 0007_catalog.sql
--
-- Catalog Foundation (003) Phase 2 — T330 implementation.
--
-- Source-of-truth artifacts:
--   - specs/003-catalog-foundation/data-model.md  §2-§13
--   - specs/003-catalog-foundation/tasks.md       §5.3 (T326-T331)
--   - specs/003-catalog-foundation/migration-test-plan.md  §5-§16
--   - packages/db/src/schema/catalog/*.ts         (Drizzle schemas authored by T320)
--   - packages/db/__tests__/migration/0001-catalog.spec.ts  (RED tests authored by T326-T329)
--
-- Naming note (migration-test-plan.md §5 / §16-R2): tasks.md §5.3 originally
-- proposed `0001_catalog.sql`, but slot 0001 is taken by
-- `0001_pos_operator_identity.sql` and slots 0002-0006 are also occupied.
-- The next free lex slot is 0007, used here. The companion rollback is
-- `0007_catalog.down.sql`.
--
-- Creates:
--   1. tenants.default_currency_code char(3) NOT NULL DEFAULT 'USD' (data-model.md §13).
--   2. Seven catalog tables in dependency order:
--      global_products, tenant_product_categories, tenant_products,
--      store_product_overrides, product_aliases, price_history, unknown_items.
--   3. CHECK constraints per data-model.md §2-§8 plus the three
--      non-negative money CHECKs per tasks.md §5.3 T329 / migration-test-plan §9.3.
--   4. Partial UNIQUE indexes per data-model.md §2-§8 (Q4 / Q7 / Q9).
--   5. Plain indexes incl. price_history timeline indexes with effective_from DESC.
--   6. Foreign keys per data-model.md §9 cascade table.
--      Notably: NO FK from tenant_products.source_global_product_id to
--      global_products (Q5 / data-model.md §3 — copy-on-adopt snapshot).
--   7. RLS enabled + FORCE on every catalog table; policies per data-model.md §10.
--   8. updated_at triggers reusing the global `set_updated_at()` function from 0000.
--
-- Reversibility is provided by `0007_catalog.down.sql`.

BEGIN;

-- =============================================================================
-- 1. tenants.default_currency_code (data-model.md §13 / R-2 / PQ-1)
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_currency_code CHAR(3) NOT NULL DEFAULT 'USD';

-- =============================================================================
-- 2. global_products (data-model.md §2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS global_products (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT         NOT NULL,
  description              TEXT,
  suggested_category       TEXT,
  suggested_tax_category   TEXT,
  default_price            NUMERIC(19,4),
  default_currency_code    CHAR(3),
  retired_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by               UUID         NOT NULL,
  CONSTRAINT global_products_name_length
    CHECK (length(name) BETWEEN 1 AND 500),
  CONSTRAINT global_products_currency_paired
    CHECK ((default_price IS NULL AND default_currency_code IS NULL)
        OR (default_price IS NOT NULL AND default_currency_code IS NOT NULL)),
  CONSTRAINT global_products_suggested_tax_category_format
    CHECK (suggested_tax_category IS NULL OR length(suggested_tax_category) BETWEEN 1 AND 50),
  -- T329: Q1 non-negative money CHECK per tasks.md §5.3 / migration-test-plan §9.3.
  CONSTRAINT global_products_default_price_non_negative
    CHECK (default_price IS NULL OR default_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_global_products_active
  ON global_products (id) WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_global_products_suggested_category
  ON global_products (suggested_category) WHERE retired_at IS NULL;

CREATE TRIGGER global_products_set_updated_at BEFORE UPDATE ON global_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- global_products is platform-scoped, not tenant-scoped (data-model.md §2 / §10).
-- RLS still enables FORCE so the platform-admin gate cannot be bypassed by a
-- table-owner connection.
ALTER TABLE global_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_products FORCE ROW LEVEL SECURITY;

CREATE POLICY global_products_read ON global_products
  FOR SELECT
  USING (true);

CREATE POLICY global_products_platform_write ON global_products
  FOR ALL
  USING (current_setting('app.current_role', true) = 'platform_admin')
  WITH CHECK (current_setting('app.current_role', true) = 'platform_admin');

-- =============================================================================
-- 3. tenant_product_categories (data-model.md §4)
--    Created before tenant_products so the category_id FK target exists.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_product_categories (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name         TEXT         NOT NULL,
  description  TEXT,
  retired_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by   UUID         NOT NULL,
  CONSTRAINT tenant_product_categories_name_length
    CHECK (length(name) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_tenant_product_categories_tenant_active
  ON tenant_product_categories (tenant_id) WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_tenant_product_categories_tenant_name"
  ON tenant_product_categories (tenant_id, name) WHERE retired_at IS NULL;

CREATE TRIGGER tenant_product_categories_set_updated_at BEFORE UPDATE ON tenant_product_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_product_categories FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_product_categories_tenant_isolation ON tenant_product_categories
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_product_categories_tenant_write ON tenant_product_categories
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 4. tenant_products (data-model.md §3)
--    Q5: source_global_product_id is uuid NULL with NO FK to global_products.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_products (
  id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                        TEXT          NOT NULL,
  description                 TEXT,
  category_id                 UUID          REFERENCES tenant_product_categories(id) ON DELETE SET NULL,
  default_price               NUMERIC(19,4),
  default_currency_code       CHAR(3),
  is_active                   BOOLEAN       NOT NULL DEFAULT true,
  tax_category                TEXT          NOT NULL,
  source_global_product_id    UUID,         -- Q5: NO FK to global_products (data-model.md §3).
  retired_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by                  UUID          NOT NULL,
  updated_by                  UUID          NOT NULL,
  correlation_id              UUID,
  CONSTRAINT tenant_products_name_length
    CHECK (length(name) BETWEEN 1 AND 500),
  CONSTRAINT tenant_products_currency_paired
    CHECK ((default_price IS NULL AND default_currency_code IS NULL)
        OR (default_price IS NOT NULL AND default_currency_code IS NOT NULL)),
  CONSTRAINT tenant_products_tax_category_length
    CHECK (length(tax_category) BETWEEN 1 AND 50),
  -- T329: Q1 non-negative money CHECK per tasks.md §5.3 / migration-test-plan §9.3.
  CONSTRAINT tenant_products_default_price_non_negative
    CHECK (default_price IS NULL OR default_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tenant_products_tenant_active
  ON tenant_products (tenant_id, id) WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_products_tenant_category
  ON tenant_products (tenant_id, category_id) WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_products_source_global
  ON tenant_products (source_global_product_id) WHERE source_global_product_id IS NOT NULL;

CREATE TRIGGER tenant_products_set_updated_at BEFORE UPDATE ON tenant_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_products FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_products_tenant_isolation ON tenant_products
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_products_tenant_write ON tenant_products
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 5. store_product_overrides (data-model.md §5)
-- =============================================================================

CREATE TABLE IF NOT EXISTS store_product_overrides (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID          NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  product_id      UUID          NOT NULL REFERENCES tenant_products(id) ON DELETE RESTRICT,
  price           NUMERIC(19,4),
  currency_code   CHAR(3),
  is_active       BOOLEAN,
  tax_category    TEXT,
  retired_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      UUID          NOT NULL,
  updated_by      UUID          NOT NULL,
  correlation_id  UUID,
  CONSTRAINT store_product_overrides_currency_paired
    CHECK ((price IS NULL AND currency_code IS NULL)
        OR (price IS NOT NULL AND currency_code IS NOT NULL)),
  CONSTRAINT store_product_overrides_tax_category_length
    CHECK (tax_category IS NULL OR length(tax_category) BETWEEN 1 AND 50),
  CONSTRAINT store_product_overrides_at_least_one_override
    CHECK (NOT (price IS NULL AND is_active IS NULL AND tax_category IS NULL)),
  -- T329: Q1 non-negative money CHECK per tasks.md §5.3 / migration-test-plan §9.3.
  CONSTRAINT store_product_overrides_price_non_negative
    CHECK (price IS NULL OR price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_store_product_overrides_store_active
  ON store_product_overrides (tenant_id, store_id) WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_store_product_overrides_product
  ON store_product_overrides (tenant_id, product_id) WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_store_product_overrides_product_store"
  ON store_product_overrides (tenant_id, store_id, product_id) WHERE retired_at IS NULL;

CREATE TRIGGER store_product_overrides_set_updated_at BEFORE UPDATE ON store_product_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE store_product_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_product_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY store_product_overrides_tenant_isolation ON store_product_overrides
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY store_product_overrides_store_read ON store_product_overrides
  FOR SELECT
  USING (
    store_id = current_setting('app.current_store', true)::uuid
    OR current_setting('app.current_store', true) = ''
  );

CREATE POLICY store_product_overrides_tenant_write ON store_product_overrides
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND store_id = current_setting('app.current_store', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND store_id = current_setting('app.current_store', true)::uuid
  );

-- =============================================================================
-- 6. product_aliases (data-model.md §6) — Q4: three partial UNIQUE indexes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_aliases (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id       UUID         NOT NULL REFERENCES tenant_products(id) ON DELETE RESTRICT,
  identifier_type  TEXT         NOT NULL,
  value            TEXT         NOT NULL,
  source_system    TEXT,
  store_id         UUID         REFERENCES stores(id) ON DELETE RESTRICT,
  retired_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by       UUID         NOT NULL,
  correlation_id   UUID,
  CONSTRAINT product_aliases_identifier_type_valid
    CHECK (identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')),
  CONSTRAINT product_aliases_value_length
    CHECK (length(value) BETWEEN 1 AND 200),
  CONSTRAINT product_aliases_source_system_required
    CHECK ((identifier_type = 'external_pos_id' AND source_system IS NOT NULL)
        OR (identifier_type <> 'external_pos_id' AND source_system IS NULL)),
  CONSTRAINT product_aliases_store_scope_consistency
    CHECK (store_id IS NULL OR identifier_type <> 'external_pos_id')
);

-- Q4 — three partial UNIQUE indexes (data-model.md §6).
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_product_aliases_tenant_wide"
  ON product_aliases (tenant_id, identifier_type, value)
  WHERE store_id IS NULL
    AND identifier_type <> 'external_pos_id'
    AND retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_product_aliases_external_pos_id"
  ON product_aliases (tenant_id, source_system, value)
  WHERE identifier_type = 'external_pos_id' AND retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_product_aliases_store_scoped"
  ON product_aliases (tenant_id, store_id, identifier_type, value)
  WHERE store_id IS NOT NULL AND retired_at IS NULL;

-- Lookup helpers.
CREATE INDEX IF NOT EXISTS idx_product_aliases_lookup
  ON product_aliases (tenant_id, identifier_type, value) WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_aliases_product
  ON product_aliases (tenant_id, product_id) WHERE retired_at IS NULL;

ALTER TABLE product_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_aliases FORCE ROW LEVEL SECURITY;

CREATE POLICY product_aliases_tenant_isolation ON product_aliases
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY product_aliases_tenant_write ON product_aliases
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 7. price_history (data-model.md §7) — append-only, no retired_at, no UPDATE/DELETE.
-- =============================================================================

CREATE TABLE IF NOT EXISTS price_history (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  product_id      UUID          NOT NULL REFERENCES tenant_products(id) ON DELETE RESTRICT,
  store_id        UUID          REFERENCES stores(id) ON DELETE RESTRICT,
  price           NUMERIC(19,4) NOT NULL,
  currency_code   CHAR(3)       NOT NULL,
  effective_from  TIMESTAMPTZ   NOT NULL,
  effective_to    TIMESTAMPTZ,
  changed_by      UUID          NOT NULL,
  correlation_id  UUID          NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT price_history_interval_order
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- T329: Q1 non-negative money CHECK; named to match the schema-shape test
  -- assertion (Wave 2 spec asserts `price_history_price_positive`).
  CONSTRAINT price_history_price_positive
    CHECK (price >= 0)
);

-- Q9 — open-interval enforcement: at most one open interval per scope.
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_price_history_tenant_open"
  ON price_history (tenant_id, product_id)
  WHERE store_id IS NULL AND effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_price_history_store_open"
  ON price_history (tenant_id, product_id, store_id)
  WHERE store_id IS NOT NULL AND effective_to IS NULL;

-- Timeline indexes per data-model.md §7 — effective_from DESC ordering.
CREATE INDEX IF NOT EXISTS idx_price_history_product_timeline
  ON price_history (tenant_id, product_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS idx_price_history_store_timeline
  ON price_history (tenant_id, product_id, store_id, effective_from DESC)
  WHERE store_id IS NOT NULL;

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history FORCE ROW LEVEL SECURITY;

CREATE POLICY price_history_tenant_isolation ON price_history
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY price_history_tenant_insert ON price_history
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Immutability: split into separate UPDATE and DELETE policies. Per data-model
-- §7 / Constitution §13, both USING and WITH CHECK evaluate to FALSE so no
-- session can mutate or delete a price_history row at the RLS layer.
CREATE POLICY price_history_no_update ON price_history
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY price_history_no_delete ON price_history
  FOR DELETE
  USING (false);

-- =============================================================================
-- 8. unknown_items (data-model.md §8) — Q10: manual resolution only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS unknown_items (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id              UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  identifier_type       TEXT         NOT NULL,
  value                 TEXT         NOT NULL,
  source_system         TEXT,
  encountered_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sale_context          JSONB,
  resolution_status     TEXT         NOT NULL DEFAULT 'pending',
  resolved_at           TIMESTAMPTZ,
  resolved_by           UUID,
  resolution_action     TEXT,
  resolved_product_id   UUID         REFERENCES tenant_products(id) ON DELETE SET NULL,
  correlation_id        UUID         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT unknown_items_identifier_type_valid
    CHECK (identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')),
  CONSTRAINT unknown_items_value_length
    CHECK (length(value) BETWEEN 1 AND 200),
  CONSTRAINT unknown_items_resolution_status_valid
    CHECK (resolution_status IN ('pending', 'resolved', 'dismissed')),
  CONSTRAINT unknown_items_resolution_action_valid
    CHECK (resolution_action IS NULL OR resolution_action IN ('linked', 'created', 'dismissed')),
  CONSTRAINT unknown_items_resolved_fields_consistent
    CHECK ((resolution_status = 'pending'
              AND resolved_at IS NULL
              AND resolved_by IS NULL
              AND resolution_action IS NULL)
        OR (resolution_status <> 'pending'
              AND resolved_at IS NOT NULL
              AND resolved_by IS NOT NULL
              AND resolution_action IS NOT NULL)),
  CONSTRAINT unknown_items_linked_product_present
    CHECK ((resolution_action IN ('linked', 'created') AND resolved_product_id IS NOT NULL)
        OR (resolution_action = 'dismissed' AND resolved_product_id IS NULL)
        OR resolution_action IS NULL),
  CONSTRAINT unknown_items_source_system_required
    CHECK ((identifier_type = 'external_pos_id' AND source_system IS NOT NULL)
        OR (identifier_type <> 'external_pos_id' AND source_system IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_unknown_items_pending
  ON unknown_items (tenant_id, store_id) WHERE resolution_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_unknown_items_lookup_value
  ON unknown_items (tenant_id, identifier_type, value) WHERE resolution_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_unknown_items_encountered_at
  ON unknown_items (tenant_id, encountered_at DESC);

ALTER TABLE unknown_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE unknown_items FORCE ROW LEVEL SECURITY;

CREATE POLICY unknown_items_tenant_isolation ON unknown_items
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY unknown_items_store_read ON unknown_items
  FOR SELECT
  USING (
    store_id = current_setting('app.current_store', true)::uuid
    OR current_setting('app.current_store', true) = ''
  );

CREATE POLICY unknown_items_insert ON unknown_items
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY unknown_items_resolve ON unknown_items
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

COMMIT;
