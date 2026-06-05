-- 0019_erpnext_posting_status.down.sql
--
-- POS Sale Posting to ERPNext (015) — rollback for 0019_erpnext_posting_status.sql.
--
-- Drops the single table created by 0019. DROP TABLE removes the table's
-- dependent policies + indexes; the explicit DROP is kept (not relying on a
-- CASCADE of anything else) so the rollback is auditable, mirroring
-- 0018_erpnext_warehouse_map.down.sql / 0017_erpnext_item_map.down.sql. Supports
-- the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0019-erpnext-posting-status.spec.ts.

BEGIN;

DROP TABLE IF EXISTS erpnext_posting_status;

COMMIT;
