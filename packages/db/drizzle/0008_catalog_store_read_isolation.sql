-- 0008_catalog_store_read_isolation.sql
--
-- Catalog Foundation (003) — RLS cross-store read isolation hotfix.
--
-- Background
-- ----------
-- 0007_catalog.sql declared two PERMISSIVE SELECT policies on each of
-- `store_product_overrides` and `unknown_items`:
--
--   <table>_tenant_isolation  FOR SELECT  USING tenant_id = current tenant
--   <table>_store_read        FOR SELECT  USING store_id = current_store
--                                                OR current_store = ''
--
-- PostgreSQL combines PERMISSIVE policies for the same command with OR
-- (https://www.postgresql.org/docs/current/sql-createpolicy.html). The
-- tenant_isolation policy alone evaluates TRUE for every row of the
-- active tenant regardless of `store_id`. The store_read policy is
-- therefore additive only — it cannot remove visibility that
-- tenant_isolation already grants. A runtime principal with
-- `app.current_tenant = Tenant A` and `app.current_store = Store X`
-- could SELECT rows belonging to Tenant A / Store Y. This is a
-- cross-store data leak inside a tenant.
--
-- Proven RED by:
--   packages/db/__tests__/migration/catalog-rls-store-read.spec.ts
--
-- Writes were NOT affected — `<table>_tenant_write` is FOR ALL with
-- `tenant_id AND store_id` in both USING and WITH CHECK and continues
-- to block cross-store writes.
--
-- Fix
-- ----
-- Replace the two split SELECT policies with ONE combined SELECT policy
-- per table:
--
--   tenant_id = current_setting('app.current_tenant', true)::uuid
--   AND (
--     store_id = current_setting('app.current_store', true)::uuid
--     OR current_setting('app.current_store', true) = ''
--   )
--
-- This preserves the tenant-owner cross-store-by-empty-string carve-out
-- (RLS matrix §4.3) while denying cross-store reads when a specific
-- store is set.
--
-- Reversibility is provided by `0008_catalog_store_read_isolation.down.sql`
-- which restores the original two-policy split verbatim, so the up -> down
-- -> up round-trip (exercised by T327 in 0001-catalog.spec.ts) lands on
-- the same final state regardless of which side of the round-trip the
-- intermediate snapshot is taken on.

BEGIN;

-- =============================================================================
-- 1. store_product_overrides — replace split SELECT policies with one combined
-- =============================================================================

-- Drop the two old SELECT policies. `IF EXISTS` so this migration is also
-- safe to apply against a database that already has 0008 partly applied,
-- and so the down-migration can be re-run idempotently after a failure.
DROP POLICY IF EXISTS store_product_overrides_tenant_isolation
  ON store_product_overrides;

DROP POLICY IF EXISTS store_product_overrides_store_read
  ON store_product_overrides;

-- Create the single combined SELECT policy. Tenant scope is the AND
-- gate; store scope keeps the empty-string-means-all-stores carve-out
-- for tenant owners.
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

-- =============================================================================
-- 2. unknown_items — same split-policy defect, same fix
-- =============================================================================

DROP POLICY IF EXISTS unknown_items_tenant_isolation ON unknown_items;
DROP POLICY IF EXISTS unknown_items_store_read       ON unknown_items;

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
