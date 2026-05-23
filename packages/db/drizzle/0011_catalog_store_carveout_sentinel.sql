-- 0011_catalog_store_carveout_sentinel.sql
--
-- Catalog Foundation (003) — Sentinel-based store GUC disambiguation.
--
-- Background / Finding: RLS_STORE_ABSENT_READ_LEAK
-- -------------------------------------------------
-- PostgreSQL's `current_setting('app.current_store', true)` returns the empty
-- string '' for BOTH:
--   (a) sessions where the GUC has NEVER been set (i.e., cold pool / absent),
--   (b) sessions where the GUC has been explicitly set to '' by the application
--       to signal a "tenant-owner cross-store read" carve-out.
--
-- The 0009 / 0010 store-axis CASE guard used `WHEN '' THEN TRUE` as the
-- carve-out branch. Because '' is indistinguishable from "never set", this
-- caused case (a) to also resolve to TRUE — leaking all store rows to any
-- session that never configured the store GUC.
--
-- Fix — Sentinel value '*'
-- ------------------------
-- Callers who intend the cross-store carve-out MUST now set:
--
--   SELECT set_config('app.current_store', '*', true)
--
-- The three store-axis CASE guards are replaced with a three-way branch:
--
--   CASE
--     WHEN current_setting('app.current_store', true) = '*'
--       THEN TRUE                          -- explicit carve-out (tenant-owner)
--     WHEN current_setting('app.current_store', true) = ''
--       THEN FALSE                         -- never-set → fail-closed
--     ELSE
--       store_id = current_setting('app.current_store', true)::uuid
--   END
--
-- The tenant-axis CASE guard from 0010 is PRESERVED unchanged in all three
-- policies.
--
-- WITH CHECK clarification for store_product_overrides_tenant_write
-- -----------------------------------------------------------------
-- The USING clause gets the three-way guard above (tenant-owners can read
-- cross-store, callers-without-store-GUC are fail-closed).
-- The WITH CHECK clause intentionally differs:
--   WHEN '*' THEN FALSE                    -- carve-out read is allowed; cross-store WRITE is not
--   WHEN '' THEN FALSE                     -- never-set is fail-closed (same as 0010)
-- A '*' sentinel in WITH CHECK is excluded because tenant-owner cross-store
-- reads are permitted but writes must always be store-scoped.
--
-- Migration layering
-- ------------------
-- 0007 — catalog tables created, bare ::uuid cast policies
-- 0008 — store-axis SELECT policies added (split tenant+store policies)
-- 0009 — store-axis CASE guard ('' → TRUE carve-out, fixes ''::uuid cast error)
-- 0010 — tenant-axis CASE guard ('' → NULL fail-closed, fixes tenant cast error)
-- 0011 (this file) — sentinel '*' distinguishes carve-out from absent GUC
--
-- Reversibility
-- -------------
-- 0011_catalog_store_carveout_sentinel.down.sql restores the exact 0010-form
-- bodies, preserving the up → down → up round-trip invariant.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — SELECT policy
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
      WHEN current_setting('app.current_store', true) = '*'
        THEN TRUE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

-- =============================================================================
-- 2. store_product_overrides — write policy (FOR ALL)
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
      WHEN current_setting('app.current_store', true) = '*'
        THEN TRUE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
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
      WHEN current_setting('app.current_store', true) = '*'
        THEN FALSE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

-- =============================================================================
-- 3. unknown_items — SELECT policy
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
      WHEN current_setting('app.current_store', true) = '*'
        THEN TRUE
      WHEN current_setting('app.current_store', true) = ''
        THEN FALSE
      ELSE
        store_id = current_setting('app.current_store', true)::uuid
    END
  );

COMMIT;
