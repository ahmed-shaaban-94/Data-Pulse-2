-- 0009_catalog_store_empty_guc_fix.down.sql
--
-- Reverses 0009_catalog_store_empty_guc_fix.sql by restoring:
--   1. The 0008 combined SELECT policy bodies on `store_product_overrides`
--      and `unknown_items` verbatim — including the original OR expression
--      with the empty-string cast defect.
--   2. The 0007 FOR ALL write policy on `store_product_overrides` verbatim —
--      including the direct current_store::uuid cast.
--
-- This preserves the up → down → up round-trip invariant: applying 0009
-- after down-0009 returns to the same fixed state.
--
-- `IF EXISTS` is used throughout so partial re-applies are safe.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — restore 0008 SELECT policy and 0007 write
--    policy (both with cast defects) verbatim.
-- =============================================================================

-- 1a. Restore 0008 combined SELECT policy (with OR cast defect).
DROP POLICY IF EXISTS store_product_overrides_select ON store_product_overrides;

CREATE POLICY store_product_overrides_select
  ON store_product_overrides
  FOR SELECT
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND (
      store_id = current_setting('app.current_store', true)::uuid
      OR current_setting('app.current_store', true) = ''
    )
  );

-- 1b. Restore 0007 FOR ALL write policy (with direct current_store cast).
DROP POLICY IF EXISTS store_product_overrides_tenant_write ON store_product_overrides;

CREATE POLICY store_product_overrides_tenant_write
  ON store_product_overrides
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
-- 2. unknown_items — restore 0008 SELECT policy (with OR cast defect) verbatim.
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_select ON unknown_items;

CREATE POLICY unknown_items_select
  ON unknown_items
  FOR SELECT
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    AND (
      store_id = current_setting('app.current_store', true)::uuid
      OR current_setting('app.current_store', true) = ''
    )
  );

COMMIT;
