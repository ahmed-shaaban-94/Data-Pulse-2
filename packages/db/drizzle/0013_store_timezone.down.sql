-- 0013_store_timezone.down.sql
--
-- Rollback for 0013_store_timezone.sql (008 US2 / FR-023).
--
-- Drops the `stores.timezone` column added by the UP migration. Supports the
-- UP -> DOWN -> UP round-trip exercised by
-- `packages/db/__tests__/migration/0013-store-timezone.spec.ts`.

BEGIN;

ALTER TABLE stores DROP COLUMN timezone;

COMMIT;
