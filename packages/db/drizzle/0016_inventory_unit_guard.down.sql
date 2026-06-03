-- 0016_inventory_unit_guard.down.sql
--
-- Rollback for 0016: drop the established-unit EXCLUDE constraint. The
-- btree_gist extension is intentionally LEFT INSTALLED — dropping a shared
-- extension other objects may come to depend on is riskier than the harmless
-- residue of an unused extension, and CREATE EXTENSION IF NOT EXISTS on re-up
-- is idempotent. (Same conservatism as not dropping shared roles in 0005.)

BEGIN;

ALTER TABLE stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_one_unit_per_product;

COMMIT;
