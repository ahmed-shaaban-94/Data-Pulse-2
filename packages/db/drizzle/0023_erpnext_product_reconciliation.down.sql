-- 0023_erpnext_product_reconciliation.down.sql
--
-- ERPNext Product-Master Reconciliation & Repair (021) — rollback for
-- 0023_erpnext_product_reconciliation.sql.
--
-- Drops the three tables created by 0023. DROP TABLE removes each table's
-- dependent policies + indexes; the explicit DROPs are kept (not relying on a
-- CASCADE of anything else) so the rollback is auditable, mirroring
-- 0020_erpnext_reconciliation.down.sql. result -> run is the only intra-0023 FK,
-- so drop result + repair_attempt before run. Supports the UP -> DOWN -> UP
-- round-trip exercised by
-- packages/db/__tests__/migration/0023-erpnext-product-reconciliation.spec.ts.

BEGIN;

DROP TABLE IF EXISTS erpnext_product_reconciliation_repair_attempt;
DROP TABLE IF EXISTS erpnext_product_reconciliation_result;
DROP TABLE IF EXISTS erpnext_product_reconciliation_run;

COMMIT;
