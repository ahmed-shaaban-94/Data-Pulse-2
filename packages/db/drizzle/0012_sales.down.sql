-- 0012_sales.down.sql
--
-- Sales / Transaction Capture (008) — rollback for 0012_sales.sql (T013).
--
-- Drops everything created by `0012_sales.sql` in REVERSE dependency order:
--   sale_refunds -> sale_voids -> sale_lines -> sales.
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- `packages/db/__tests__/migration/0012-sales.spec.ts`.
--
-- DROP TABLE removes the table's dependent policies + indexes; explicit
-- per-table drops are kept (not a single CASCADE) so the rollback is
-- auditable without relying on PostgreSQL cascade semantics, mirroring
-- `0007_catalog.down.sql`.

BEGIN;

DROP TABLE IF EXISTS sale_refunds;

DROP TABLE IF EXISTS sale_voids;

DROP TABLE IF EXISTS sale_lines;

DROP TABLE IF EXISTS sales;

COMMIT;
