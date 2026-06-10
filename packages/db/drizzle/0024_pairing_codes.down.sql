-- 0024_pairing_codes.down.sql
--
-- Rollback for 0024_pairing_codes.sql. DROP TABLE removes the table together with
-- its policies, indexes, trigger, and CHECK constraints. No shared-table change
-- was made by the UP migration, so there is nothing else to restore.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0024-pairing-codes.spec.ts.

BEGIN;

DROP TABLE IF EXISTS pairing_codes;

COMMIT;
