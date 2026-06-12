-- 0026_sale_sync_status.down.sql
--
-- Rollback for 0026_sale_sync_status.sql. Removes the dead-letter quarantine
-- table (with its policies, indexes, trigger, CHECK constraints) and the
-- server-authoritative `sync_status` column + its CHECK + partial index from
-- `sales`. The backfill UPDATE (processed → 'synced') wrote only into the
-- dropped column, so dropping the column fully reverses it — no data restore is
-- needed. The pre-existing `sales` columns (processed_at, mismatch_flag, the L2
-- dedup) are untouched by the UP migration and so untouched here.
--
-- Supports the UP -> DOWN -> UP round-trip the migration test exercises (G3,
-- HUMAN gate on a non-prod DB).

BEGIN;

DROP TABLE IF EXISTS sale_sync_deadletters;

DROP INDEX IF EXISTS idx_sales_needs_repair;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_sync_status_valid;

ALTER TABLE sales DROP COLUMN IF EXISTS sync_status;

COMMIT;
