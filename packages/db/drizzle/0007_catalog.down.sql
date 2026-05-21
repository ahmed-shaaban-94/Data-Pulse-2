-- 0007_catalog.down.sql
--
-- Catalog Foundation (003) Phase 2 — T330 rollback.
--
-- Drops everything created by `0007_catalog.sql` in reverse dependency order
-- and removes the `tenants.default_currency_code` column added by the up
-- migration. Supports the UP -> DOWN -> UP round-trip exercised by T327.
--
-- Reverse order: unknown_items -> price_history -> product_aliases ->
-- store_product_overrides -> tenant_products -> tenant_product_categories ->
-- global_products. Then drop tenants.default_currency_code.
--
-- DROP TABLE ... CASCADE would also remove dependent policies / indexes /
-- triggers, but explicit drops are kept here so the rollback is auditable
-- without relying on PostgreSQL cascade semantics.

BEGIN;

-- =============================================================================
-- 8. unknown_items
-- =============================================================================

DROP TABLE IF EXISTS unknown_items;

-- =============================================================================
-- 7. price_history
-- =============================================================================

DROP TABLE IF EXISTS price_history;

-- =============================================================================
-- 6. product_aliases
-- =============================================================================

DROP TABLE IF EXISTS product_aliases;

-- =============================================================================
-- 5. store_product_overrides
-- =============================================================================

DROP TABLE IF EXISTS store_product_overrides;

-- =============================================================================
-- 4. tenant_products
-- =============================================================================

DROP TABLE IF EXISTS tenant_products;

-- =============================================================================
-- 3. tenant_product_categories
-- =============================================================================

DROP TABLE IF EXISTS tenant_product_categories;

-- =============================================================================
-- 2. global_products
-- =============================================================================

DROP TABLE IF EXISTS global_products;

-- =============================================================================
-- 1. tenants.default_currency_code (data-model.md §13 — added by UP)
-- =============================================================================

ALTER TABLE tenants
  DROP COLUMN IF EXISTS default_currency_code;

COMMIT;
