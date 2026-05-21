-- 0008_catalog_store_read_isolation.down.sql
--
-- Reverses 0008_catalog_store_read_isolation.sql by:
--   1. Dropping the new combined `<table>_select` policies on
--      `store_product_overrides` and `unknown_items`.
--   2. Restoring the original two split PERMISSIVE SELECT policies on
--      each table verbatim from 0007_catalog.sql.
--
-- After this down migration, the database is in the same state as after
-- running 0007_catalog.sql alone — including the cross-store read leak
-- the up migration corrects. This round-trip support is required by the
-- T327 up -> down -> up test in `0001-catalog.spec.ts`.
--
-- `IF EXISTS` is used throughout so partial re-applies are safe.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — restore original split SELECT policies
-- =============================================================================

DROP POLICY IF EXISTS store_product_overrides_select
  ON store_product_overrides;

CREATE POLICY store_product_overrides_tenant_isolation
  ON store_product_overrides
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY store_product_overrides_store_read
  ON store_product_overrides
  FOR SELECT
  USING (
    store_id = current_setting('app.current_store', true)::uuid
    OR current_setting('app.current_store', true) = ''
  );

-- =============================================================================
-- 2. unknown_items — restore original split SELECT policies
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_select ON unknown_items;

CREATE POLICY unknown_items_tenant_isolation
  ON unknown_items
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY unknown_items_store_read
  ON unknown_items
  FOR SELECT
  USING (
    store_id = current_setting('app.current_store', true)::uuid
    OR current_setting('app.current_store', true) = ''
  );

COMMIT;
