-- 0022_connector_health.down.sql
--
-- Connector Health and Connection-Status API (020) — rollback for
-- 0022_connector_health.sql.
--
-- DROP TABLE removes the table together with its policies, indexes, the
-- UNIQUE/CHECK constraints, and the FKs it owns (connector_registration_id ->
-- connector_registration, tenant_id -> tenants). No other table referenced
-- connector_health, so no dependent-object pre-step is needed.
--
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0022-connector-health.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

DROP TABLE IF EXISTS connector_health;

COMMIT;
