-- 0013_store_timezone.sql
--
-- Store timezone (008 US2 / FR-023) — [GATED] schema + migration.
--
-- Source-of-truth artifacts:
--   - specs/008-sales-transaction-capture/spec.md  FR-020..024 (temporal)
--   - specs/008-sales-transaction-capture/data-model.md  §1 (business_date)
--
-- WHY
-- ---
-- US2 derives a sale's `business_date` from the STORE's timezone (FR-023), not
-- the client clock. The store timezone was previously unmodeled; the capture
-- path computed `business_date` in UTC as an interim. This column makes the
-- store-local derivation possible.
--
-- BACKFILL / BEHAVIOR
-- -------------------
-- NOT NULL DEFAULT 'UTC' backfills every existing store to 'UTC', which
-- reproduces the prior UTC-derived `business_date` EXACTLY — no behavior change
-- until an operator sets a non-UTC zone. There is no app write path that sets a
-- non-default value in this slice: populating a store's real IANA zone belongs
-- to a future store-management surface, which also owns IANA-name validation.
-- The column is therefore plain TEXT here (no CHECK) — the only values it can
-- hold in v1 are the 'UTC' default.
--
-- DATA CLASS (SI-012 / §XIV)
-- --------------------------
-- `timezone` is an operational configuration attribute (an IANA zone name), not
-- PII or payment data. It inherits the `stores` table's existing retention.
--
-- LOCK NOTE
-- ---------
-- ADD COLUMN ... DEFAULT (non-volatile constant) is metadata-only on
-- PostgreSQL 11+ — it does NOT rewrite the table, so the ACCESS EXCLUSIVE lock
-- is held only briefly. Safe for an online deploy on a large `stores` table.

BEGIN;

ALTER TABLE stores
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

COMMIT;
