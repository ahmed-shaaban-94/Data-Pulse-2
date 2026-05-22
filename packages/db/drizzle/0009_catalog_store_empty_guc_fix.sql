-- 0009_catalog_store_empty_guc_fix.sql
--
-- Catalog Foundation (003) — Safe empty-string GUC handling in store SELECT policies.
--
-- Background
-- ----------
-- 0008_catalog_store_read_isolation.sql introduced a combined SELECT policy
-- on `store_product_overrides` and `unknown_items` with this OR clause:
--
--   store_id = current_setting('app.current_store', true)::uuid
--   OR current_setting('app.current_store', true) = ''
--
-- Intent: when `app.current_store` is the empty string `''`, the second branch
-- fires to allow tenant-owner cross-store reads (rls-test-matrix.md §4.3).
--
-- Defect A — OR does not short-circuit errors:
-- When `app.current_store = ''`, evaluating `''::uuid` raises
-- `invalid input syntax for type uuid: ""` before the right-side rescue
-- branch is reached. The empty-string carve-out is structurally unreachable.
--
-- Defect B — FOR ALL USING clause on SELECT:
-- `store_product_overrides_tenant_write` (FOR ALL, from 0007_catalog.sql) also
-- casts `current_setting('app.current_store', true)::uuid` in its USING clause.
-- PostgreSQL evaluates FOR ALL USING clauses for SELECT operations, so this
-- policy also throws when `app.current_store = ''`. `unknown_items` does not
-- have an equivalent FOR ALL write policy with a store cast, so it is not
-- affected by Defect B.
--
-- A secondary hazard: once `set_config('app.current_store', '', true)` is
-- called on a pooled connection, later transactions on that connection see
-- `current_setting('app.current_store', true) = ''` even after COMMIT because
-- the GUC's existence is session-scoped. The cast error therefore propagates
-- to adjacent tests that never set the GUC themselves.
--
-- Fix
-- ----
-- Replace every OR-based store cast expression with a CASE expression that
-- guards the ::uuid cast:
--
--   CASE
--     WHEN current_setting('app.current_store', true) = ''
--       THEN TRUE                          -- carve-out: all stores visible
--     ELSE
--       store_id = current_setting('app.current_store', true)::uuid
--   END                                   -- store-scoped or NULL (fail-closed)
--
-- Three policies require this fix:
--   1. store_product_overrides_select     (introduced by 0008)
--   2. store_product_overrides_tenant_write (FOR ALL, introduced by 0007)
--   3. unknown_items_select               (introduced by 0008)
--
-- Semantic contract (rls-test-matrix.md §4.3 / §4.9):
--   GUC = ''          → CASE branch 1 → TRUE → all tenant stores visible
--   GUC = real UUID   → CASE branch 2 → store_id equality → store-scoped
--   GUC unset (NULL)  → '' = NULL is NULL → CASE branch 2 → NULL → fail-closed
--
-- The fail-closed behaviour for unset GUC (0 rows) is preserved exactly as
-- specified in rls-test-matrix.md §4.9.
--
-- Reversibility
-- -------------
-- `0009_catalog_store_empty_guc_fix.down.sql` restores the 0008 combined
-- SELECT policy bodies and the 0007 write policy body verbatim — including
-- the cast defects — preserving the up → down → up round-trip invariant.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — fix SELECT policy (from 0008) and FOR ALL write
--    policy (from 0007) — both cast current_store::uuid unsafely.
-- =============================================================================

-- 1a. Replace 0008 combined SELECT policy with safe CASE form.
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

-- 1b. Replace 0007 FOR ALL write policy with safe CASE form.
--     The write policy's USING clause is evaluated on SELECT too (FOR ALL
--     applies to all commands). Its WITH CHECK clause only fires on
--     INSERT/UPDATE, but is patched here for consistency.
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
-- 2. unknown_items — fix SELECT policy (from 0008). The write policies for
--    unknown_items only cast current_tenant, not current_store, so they are
--    not affected.
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
