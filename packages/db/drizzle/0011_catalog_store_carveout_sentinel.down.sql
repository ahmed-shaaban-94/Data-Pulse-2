-- 0011_catalog_store_carveout_sentinel.down.sql
--
-- Reverses 0011_catalog_store_carveout_sentinel.sql.
--
-- Restores every policy to its pre-0011 (0010-form) body:
--   - Three-way sentinel CASE guard removed; original 0009/0010 two-way
--     WHEN '' form restored.
--   - Tenant-axis CASE guard (from 0010) is preserved in all three policies.
--
-- WARNING: Rolling back reintroduces the RLS_STORE_ABSENT_READ_LEAK defect:
-- a session with no app.current_store GUC set will again see all rows for the
-- active tenant instead of 0 rows.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — restore 0010 SELECT form
-- =============================================================================

DROP POLICY IF EXISTS store_product_overrides_select ON store_product_overrides;

CREATE POLICY store_product_overrides_select
  ON store_product_overrides
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

-- =============================================================================
-- 2. store_product_overrides — restore 0010 write form
-- =============================================================================

DROP POLICY IF EXISTS store_product_overrides_tenant_write ON store_product_overrides;

CREATE POLICY store_product_overrides_tenant_write
  ON store_product_overrides
  FOR ALL
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

-- =============================================================================
-- 3. unknown_items_select — restore 0010 form
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_select ON unknown_items;

CREATE POLICY unknown_items_select
  ON unknown_items
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
    AND CASE
      WHEN current_setting('app.current_store', true) = ''
        THEN TRUE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

COMMIT;
