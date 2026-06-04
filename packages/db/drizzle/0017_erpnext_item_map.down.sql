-- 0017_erpnext_item_map.down.sql
--
-- Product Master from ERPNext (013) — rollback for 0017_erpnext_item_map.sql.
--
-- Drops the single table created by 0017. DROP TABLE removes the table's
-- dependent policies + indexes; the explicit DROP is kept (not relying on a
-- CASCADE of anything else) so the rollback is auditable, mirroring
-- 0014_inventory.down.sql / 0012_sales.down.sql. Supports the UP -> DOWN -> UP
-- round-trip exercised by packages/db/__tests__/migration/0017-erpnext-item-map.spec.ts.

BEGIN;

DROP TABLE IF EXISTS erpnext_item_map;

COMMIT;
