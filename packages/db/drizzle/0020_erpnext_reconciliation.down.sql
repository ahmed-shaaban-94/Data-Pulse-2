-- 0020_erpnext_reconciliation.down.sql
--
-- ERPNext Reconciliation & Repair (017) — rollback for 0020_erpnext_reconciliation.sql.
--
-- Drops the three tables created by 0020. DROP TABLE removes each table's
-- dependent policies + indexes; the explicit DROPs are kept (not relying on a
-- CASCADE of anything else) so the rollback is auditable, mirroring
-- 0019_erpnext_posting_status.down.sql / 0018_erpnext_warehouse_map.down.sql.
-- result -> run is the only intra-0020 FK, so drop result + repair_attempt
-- before run. Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0020-erpnext-reconciliation.spec.ts.

BEGIN;

DROP TABLE IF EXISTS erpnext_reconciliation_repair_attempt;
DROP TABLE IF EXISTS erpnext_reconciliation_result;
DROP TABLE IF EXISTS erpnext_reconciliation_run;

COMMIT;
