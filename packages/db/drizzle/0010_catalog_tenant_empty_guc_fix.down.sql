-- 0010_catalog_tenant_empty_guc_fix.down.sql
--
-- Reverses 0010_catalog_tenant_empty_guc_fix.sql.
--
-- Restores every policy to its pre-0010 form:
--   - Group A (pure tenant-scoped, 0007-form): bare ::uuid cast, no CASE guard.
--   - Group B (store-scoped, 0009-form): store CASE guard preserved, tenant cast bare.
--
-- WARNING: Rolling back reintroduces SQLSTATE 22P02 (invalid_text_representation)
-- for all SELECT operations when 'app.current_tenant' GUC is unset. This is the
-- known defect tracked by finding RLS_UNSET_TENANT_GUC_CAST_ERROR in wave-status.md.

BEGIN;

-- =============================================================================
-- 1. tenant_product_categories — restore 0007 form
-- =============================================================================

DROP POLICY IF EXISTS tenant_product_categories_tenant_isolation ON tenant_product_categories;

CREATE POLICY tenant_product_categories_tenant_isolation
  ON tenant_product_categories
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_product_categories_tenant_write ON tenant_product_categories;

CREATE POLICY tenant_product_categories_tenant_write
  ON tenant_product_categories
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 2. tenant_products — restore 0007 form
-- =============================================================================

DROP POLICY IF EXISTS tenant_products_tenant_isolation ON tenant_products;

CREATE POLICY tenant_products_tenant_isolation
  ON tenant_products
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_products_tenant_write ON tenant_products;

CREATE POLICY tenant_products_tenant_write
  ON tenant_products
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 3. product_aliases — restore 0007 form
-- =============================================================================

DROP POLICY IF EXISTS product_aliases_tenant_isolation ON product_aliases;

CREATE POLICY product_aliases_tenant_isolation
  ON product_aliases
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS product_aliases_tenant_write ON product_aliases;

CREATE POLICY product_aliases_tenant_write
  ON product_aliases
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 4. price_history — restore 0007 form
-- =============================================================================

DROP POLICY IF EXISTS price_history_tenant_isolation ON price_history;

CREATE POLICY price_history_tenant_isolation
  ON price_history
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS price_history_tenant_insert ON price_history;

CREATE POLICY price_history_tenant_insert
  ON price_history
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 5. unknown_items INSERT + UPDATE — restore 0007 form
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_insert ON unknown_items;

CREATE POLICY unknown_items_insert
  ON unknown_items
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS unknown_items_resolve ON unknown_items;

CREATE POLICY unknown_items_resolve
  ON unknown_items
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- =============================================================================
-- 6. store_product_overrides — restore 0009 form (store CASE guard, bare tenant cast)
-- =============================================================================

DROP POLICY IF EXISTS store_product_overrides_select ON store_product_overrides;

CREATE POLICY store_product_overrides_select
  ON store_product_overrides
  FOR SELECT
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

DROP POLICY IF EXISTS store_product_overrides_tenant_write ON store_product_overrides;

CREATE POLICY store_product_overrides_tenant_write
  ON store_product_overrides
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

-- =============================================================================
-- 7. unknown_items_select — restore 0009 form (store CASE guard, bare tenant cast)
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_select ON unknown_items;

CREATE POLICY unknown_items_select
  ON unknown_items
  FOR SELECT
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

COMMIT;
