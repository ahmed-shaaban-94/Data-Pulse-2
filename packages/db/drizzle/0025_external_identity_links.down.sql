-- 0025_external_identity_links.down.sql
--
-- Rollback for 0025_external_identity_links.sql. DROP TABLE removes the table
-- together with its indexes, trigger, and CHECK constraints. The UP migration
-- made NO change to any existing table (users.clerk_user_id was deliberately
-- left untouched — N-7), so there is nothing else to restore; the backfilled
-- link rows are discarded with the table.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0025-external-identity-links.spec.ts.

BEGIN;

DROP TABLE IF EXISTS external_identity_links;

COMMIT;
