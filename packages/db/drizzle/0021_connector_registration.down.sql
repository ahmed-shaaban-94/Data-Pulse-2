-- 0021_connector_registration.down.sql
--
-- Connector Boundary Hardening (018) — rollback for 0021_connector_registration.sql.
--
-- Restores auth_tokens to its pre-0021 shape BEFORE dropping the table, so the
-- connector_registration_id FK is gone before its target is removed (otherwise
-- the DROP TABLE would error on the dependent FK). Order:
--   1. drop the scope-enum CHECK;
--   2. drop the at-most-one-active partial-unique index;
--   3. drop the connector_registration_id column (removes the FK with it);
--   4. drop connector_registration (DROP TABLE removes its policies + indexes).
-- Supports the UP -> DOWN -> UP round-trip exercised by
-- packages/db/__tests__/migration/0021-connector-registration.spec.ts and the
-- full-chain down in packages/db/__tests__/cli/migrate.spec.ts.

BEGIN;

ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_scope_valid;

DROP INDEX IF EXISTS uq_auth_tokens_active_connector_credential;

ALTER TABLE auth_tokens DROP COLUMN IF EXISTS connector_registration_id;

DROP TABLE IF EXISTS connector_registration;

COMMIT;
