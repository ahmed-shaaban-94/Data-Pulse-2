-- 0016_inventory_unit_guard.sql
--
-- 009 follow-up (issue #465, part A) — DB-layer established-unit guard (FR-022).
--
-- Closes a latent concurrency gap in the app-layer `assertUnitMatchesEstablished`
-- check (apps/api/src/inventory/inventory.service.ts + the worker mirror in
-- apps/worker/src/inventory/backfill.processor.ts): under READ COMMITTED, two
-- concurrent FIRST movements for the same (store_id, tenant_product_ref) in
-- DIFFERENT stocking units can both observe "no established unit" and both
-- commit, leaving divergent units — which FR-022 forbids. The app check stays as
-- the friendly pre-DB 400; THIS migration is the hard, path-independent backstop
-- (it fires on ANY insert from ANY code path — api, worker, future — so it is
-- immune to a write path forgetting the check; cf. the 009 F-06 mirror gap).
--
-- MECHANISM: an EXCLUDE constraint, NOT a plain UNIQUE. A product legitimately
-- has MANY movements in the SAME unit, so the invariant is "at most ONE DISTINCT
-- stocking_unit per (store, product)" — which UNIQUE cannot express but an
-- exclusion constraint states directly: reject any new row that shares
-- (store_id, tenant_product_ref) with an existing row but has a DIFFERENT
-- stocking_unit. Verified on postgres:16-alpine: same-unit rows accepted,
-- divergent-unit row rejected with SQLSTATE 23P01 (exclusion_violation). Needs
-- btree_gist for the `=` operator class on uuid/text within a GiST index (first
-- use of the extension in this repo; available in the contrib bundle on the
-- managed PG image). Partial — WHERE tenant_product_ref IS NOT NULL — so ad-hoc
-- (NULL-product) movements are unconstrained (they roll up to no product, R5).
--
-- SELF-GUARDING: the constraint cannot be added over data that already violates
-- it. Rather than fail with an opaque 23P01 at deploy, a DO block first counts
-- divergent (store, product) groups and RAISEs an actionable exception if any
-- exist (this would mean the race already fired in production — resolve the data
-- + decide "which unit wins" before re-running). On clean data (the expected
-- case — the race is rare) the guard is a silent no-op and the constraint lands.
-- Whole migration is one transaction: a failed guard rolls back, no partial DDL.
--
-- DATA-LIFECYCLE: no new column, no new entity, no PII/payment — a constraint
-- only. The 0014 §XIV business-class classification is unchanged.

BEGIN;

-- btree_gist provides the `=` (equality) GiST operator classes that an EXCLUDE
-- constraint mixing `=` and `<>` predicates requires on uuid/text columns.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Self-guard: abort with an actionable message if existing data already has a
-- (store, product) group spanning more than one stocking unit. CREATE CONSTRAINT
-- over such data would otherwise fail with a bare 23P01.
DO $$
DECLARE
  divergent_groups bigint;
BEGIN
  SELECT count(*) INTO divergent_groups
  FROM (
    SELECT store_id, tenant_product_ref
    FROM stock_movements
    WHERE tenant_product_ref IS NOT NULL
    GROUP BY store_id, tenant_product_ref
    HAVING count(DISTINCT stocking_unit) > 1
  ) AS d;

  IF divergent_groups > 0 THEN
    RAISE EXCEPTION
      'Cannot add the established-unit guard: % (store, product) group(s) already span more than one stocking_unit (FR-022 violated by a prior concurrency race). Resolve the divergent movements (decide which unit is canonical) before applying 0016.',
      divergent_groups
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- The established-unit guard: at most ONE distinct stocking_unit per
-- (store_id, tenant_product_ref). Equal store + equal product + UNEQUAL unit =
-- a conflict → rejected (23P01). Same store+product+unit = fine (the common
-- case: many movements share a unit). Skips ad-hoc NULL-product movements.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_one_unit_per_product
  EXCLUDE USING gist (
    store_id WITH =,
    tenant_product_ref WITH =,
    stocking_unit WITH <>
  )
  WHERE (tenant_product_ref IS NOT NULL);

COMMIT;
