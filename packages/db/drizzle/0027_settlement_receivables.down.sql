-- 0027_settlement_receivables.down.sql
--
-- Rollback for 0027_settlement_receivables.sql. Drops the seven settlement
-- tables (with their policies, indexes, triggers, CHECK + FK constraints) in
-- reverse-dependency order — children/joins before the aggregates they
-- reference, and receivable before payer_account/sales.
--
-- 0027 only ADDS new tables; it does not alter any pre-existing table (sales,
-- payer-free 0026 artifacts, etc.), so dropping these tables fully reverses it —
-- no data restore is needed. Supports the UP -> DOWN -> UP round-trip the
-- migration test exercises (G3, HUMAN gate on a non-prod DB).

BEGIN;

-- Leaf/append-only children first.
DROP TABLE IF EXISTS reconciliation_result;
DROP TABLE IF EXISTS remittance;
DROP TABLE IF EXISTS claim_receivables;
DROP TABLE IF EXISTS payment_application;

-- Aggregates next (claim references payer_account; receivable references
-- payer_account + sales).
DROP TABLE IF EXISTS claim;
DROP TABLE IF EXISTS receivable;

-- Parent payer account last.
DROP TABLE IF EXISTS payer_account;

COMMIT;
