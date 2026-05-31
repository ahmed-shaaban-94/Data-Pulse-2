-- 0014_inventory.down.sql
--
-- Inventory & Stock Movement Ledger (009) — rollback for 0014_inventory.sql (T013).
--
-- Drops everything created by `0014_inventory.sql` in REVERSE dependency order:
--   stock_movements -> stock_counts
-- (stock_movements carries the composite FK into stock_counts, so it drops
-- first.) Supports the UP -> DOWN -> UP round-trip exercised by
-- `packages/db/__tests__/migration/0014-inventory.spec.ts`.
--
-- DROP TABLE removes the table's dependent policies + indexes; explicit
-- per-table drops are kept (not a single CASCADE) so the rollback is auditable
-- without relying on PostgreSQL cascade semantics, mirroring
-- `0012_sales.down.sql`.

BEGIN;

DROP TABLE IF EXISTS stock_movements;

DROP TABLE IF EXISTS stock_counts;

COMMIT;
