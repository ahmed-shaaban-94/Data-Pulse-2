-- 0010_catalog_tenant_empty_guc_fix.sql
--
-- Catalog Foundation (003) — Safe empty-string GUC handling in tenant SELECT policies.
--
-- Background
-- ----------
-- 0007_catalog.sql introduced tenant-scoped RLS policies on every catalog table
-- with bare `current_setting('app.current_tenant', true)::uuid` casts.
--
-- Defect — the same root cause as Defect A in 0009:
-- `current_setting('app.current_tenant', true)` returns '' (empty string) when
-- the GUC has never been set in the session (not NULL). The bare cast `''::uuid`
-- raises `invalid input syntax for type uuid: ""` (SQLSTATE 22P02) before the
-- policy body evaluates. This was observed in CI on PR #285 (commit 30751989)
-- for five `it.todo` test cases in T343:
--
--   §3.3  tenant_product_categories  unset-tenant SELECT
--   §4.5  store_product_overrides    no-tenant, store-set SELECT
--   §5.3  product_aliases            unset-tenant SELECT
--   §6.5  price_history              unset-tenant SELECT
--   §7.6  unknown_items              unset-tenant SELECT
--
-- Finding: RLS_UNSET_TENANT_GUC_CAST_ERROR (wave-status.md, medium severity)
--
-- The §2.3 (tenant_products, no-GUC pool) case was already passing because its
-- cold-pool path bypassed the set_config GUC bleed that exposed the cast error
-- in the four `withRawClient` cases.
--
-- Fix
-- ----
-- Replace every bare `current_setting('app.current_tenant', true)::uuid`
-- expression with a CASE guard:
--
--   CASE
--     WHEN current_setting('app.current_tenant', true) = ''
--       THEN NULL                     -- fail-closed: NULL = tenant_id → NULL → filtered
--     ELSE
--       current_setting('app.current_tenant', true)::uuid
--   END
--
-- NULL = any_value evaluates to NULL (not TRUE) under standard SQL semantics,
-- so a NULL result from the CASE causes the row to be filtered — preserving the
-- matrix §2.3/§3.3/§5.3/§6.5/§7.6 contract of "0 rows" without throwing.
--
-- Note: there is no tenant-axis carve-out (unlike the store axis where '' means
-- "tenant-owner cross-store read"). THEN NULL is correct — no THEN TRUE branch.
--
-- Policies updated
-- ----------------
-- The following policies are classified into two groups based on their
-- pre-existing form:
--
-- Group A — 0007-form only (pure tenant-scoped policies, not touched by 0008/0009):
--   1. tenant_product_categories_tenant_isolation (SELECT USING)
--   2. tenant_product_categories_tenant_write     (FOR ALL USING + WITH CHECK)
--   3. tenant_products_tenant_isolation           (SELECT USING)
--   4. tenant_products_tenant_write               (FOR ALL USING + WITH CHECK)
--   5. product_aliases_tenant_isolation           (SELECT USING)
--   6. product_aliases_tenant_write               (FOR ALL USING + WITH CHECK)
--   7. price_history_tenant_isolation             (SELECT USING)
--   8. price_history_tenant_insert                (INSERT WITH CHECK)
--   9. unknown_items_insert                       (INSERT WITH CHECK)
--  10. unknown_items_resolve                      (UPDATE USING + WITH CHECK)
--
-- Group B — 0009-form (store-scoped policies — store CASE guard already present,
--           only the tenant cast is bare; preserve the store CASE guard):
--  11. store_product_overrides_select             (SELECT USING)
--  12. store_product_overrides_tenant_write       (FOR ALL USING + WITH CHECK)
--  13. unknown_items_select                       (SELECT USING)
--
-- Reversibility
-- -------------
-- `0010_catalog_tenant_empty_guc_fix.down.sql` restores:
--   - Group A policies: 0007 exact form (bare cast)
--   - Group B policies: 0009 exact form (store CASE guard, bare tenant cast)
-- This preserves the up → down → up round-trip invariant.

BEGIN;

-- =============================================================================
-- 1. tenant_product_categories — SELECT isolation + write policy
-- =============================================================================

DROP POLICY IF EXISTS tenant_product_categories_tenant_isolation ON tenant_product_categories;

CREATE POLICY tenant_product_categories_tenant_isolation
  ON tenant_product_categories
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

DROP POLICY IF EXISTS tenant_product_categories_tenant_write ON tenant_product_categories;

CREATE POLICY tenant_product_categories_tenant_write
  ON tenant_product_categories
  FOR ALL
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

-- =============================================================================
-- 2. tenant_products — SELECT isolation + write policy
-- =============================================================================

DROP POLICY IF EXISTS tenant_products_tenant_isolation ON tenant_products;

CREATE POLICY tenant_products_tenant_isolation
  ON tenant_products
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

DROP POLICY IF EXISTS tenant_products_tenant_write ON tenant_products;

CREATE POLICY tenant_products_tenant_write
  ON tenant_products
  FOR ALL
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

-- =============================================================================
-- 3. product_aliases — SELECT isolation + write policy
-- =============================================================================

DROP POLICY IF EXISTS product_aliases_tenant_isolation ON product_aliases;

CREATE POLICY product_aliases_tenant_isolation
  ON product_aliases
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

DROP POLICY IF EXISTS product_aliases_tenant_write ON product_aliases;

CREATE POLICY product_aliases_tenant_write
  ON product_aliases
  FOR ALL
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

-- =============================================================================
-- 4. price_history — SELECT isolation + insert policy
--    Note: price_history has no UPDATE/DELETE USING clause because it is
--    immutable — the FOR ALL write policy uses USING = FALSE. That policy
--    does not cast current_tenant, so it is not affected by this fix.
-- =============================================================================

DROP POLICY IF EXISTS price_history_tenant_isolation ON price_history;

CREATE POLICY price_history_tenant_isolation
  ON price_history
  FOR SELECT
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

DROP POLICY IF EXISTS price_history_tenant_insert ON price_history;

CREATE POLICY price_history_tenant_insert
  ON price_history
  FOR INSERT
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

-- =============================================================================
-- 5. unknown_items — INSERT + UPDATE policies (Group A)
--    Note: unknown_items_select is Group B — handled below.
--    The SELECT policy was replaced by 0008 and patched by 0009.
--    The INSERT and UPDATE policies cast current_tenant only (no store cast)
--    and are in their 0007 form.
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_insert ON unknown_items;

CREATE POLICY unknown_items_insert
  ON unknown_items
  FOR INSERT
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

DROP POLICY IF EXISTS unknown_items_resolve ON unknown_items;

CREATE POLICY unknown_items_resolve
  ON unknown_items
  FOR UPDATE
  USING (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  )
  WITH CHECK (
    tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = ''
        THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END
  );

-- =============================================================================
-- 6. store_product_overrides — Group B policies (preserve 0009 store CASE guard)
--
--    Both policies already have the store-axis CASE guard from 0009. This step
--    adds the tenant-axis CASE guard while keeping the store guard intact.
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
-- 7. unknown_items_select — Group B (preserve 0009 store CASE guard)
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
