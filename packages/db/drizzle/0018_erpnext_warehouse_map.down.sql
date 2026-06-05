-- 0018_erpnext_warehouse_map.down.sql
--
-- Branch Inventory Reconciliation & Warehouse Mapping (014) — rollback for
-- 0018_erpnext_warehouse_map.sql.
--
-- Drops the single table created by 0018. DROP TABLE removes the table's
-- dependent policies + indexes; the explicit DROP is kept (not relying on a
-- CASCADE of anything else) so the rollback is auditable, mirroring
-- 0017_erpnext_item_map.down.sql / 0014_inventory.down.sql. Supports the
-- UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0018-erpnext-warehouse-map.spec.ts.

BEGIN;

DROP TABLE IF EXISTS erpnext_warehouse_map;

COMMIT;
