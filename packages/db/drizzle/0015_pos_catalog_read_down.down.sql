-- 0015_pos_catalog_read_down.down.sql
--
-- POS Catalogue Read-Down Sync (010) — rollback for 0015_pos_catalog_read_down.sql (T013).
--
-- Drops everything created by `0015_pos_catalog_read_down.sql` in REVERSE
-- dependency order: the three population triggers + their functions FIRST (they
-- reference catalog_change_log), then the table (DROP TABLE removes its
-- dependent policies + index). Explicit per-object drops are kept (not a single
-- CASCADE) so the rollback is auditable without relying on cascade semantics,
-- mirroring 0014_inventory.down.sql. Supports the UP -> DOWN -> UP round-trip
-- exercised by packages/db/__tests__/migration/0015-pos-catalog-read-down.spec.ts.
--
-- The triggers READ NEW/OLD on the three 003 source tables only and INSERT into
-- catalog_change_log; dropping them restores the exact pre-0015 write behavior
-- of tenant_products / store_product_overrides / product_aliases (no 003 column
-- semantics were ever altered — additive only).

BEGIN;

DROP TRIGGER IF EXISTS catalog_change_log_product_aliases ON product_aliases;
DROP FUNCTION IF EXISTS catalog_change_log_from_product_aliases();

DROP TRIGGER IF EXISTS catalog_change_log_store_overrides ON store_product_overrides;
DROP FUNCTION IF EXISTS catalog_change_log_from_store_overrides();

DROP TRIGGER IF EXISTS catalog_change_log_tenant_products ON tenant_products;
DROP FUNCTION IF EXISTS catalog_change_log_from_tenant_products();

DROP TABLE IF EXISTS catalog_change_log;

COMMIT;
