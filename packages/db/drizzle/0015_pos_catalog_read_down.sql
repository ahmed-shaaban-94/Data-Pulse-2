-- 0015_pos_catalog_read_down.sql
--
-- POS Catalogue Read-Down Sync (010) — [GATED] schema + migration (T013).
--
-- Source-of-truth artifacts:
--   - specs/010-pos-catalog-read-down-sync/data-model.md   §2 (cursor), §3 (change-log)
--   - specs/010-pos-catalog-read-down-sync/research.md     R1 (delta mechanism), R9 (fan-out)
--   - packages/db/src/schema/catalog/catalog-change-log.ts
--   - packages/db/__tests__/migration/0015-pos-catalog-read-down.spec.ts  (round-trip, Docker)
--   - apps/api/test/catalog/schema/catalog-change-log-schema-shape.spec.ts (Docker-free shape)
--
-- Creates the read-down change-log that backs the snapshot cursor + delta
-- stream. ADDITIVE ONLY — it does NOT alter any existing 003 column semantics;
-- it adds one table + three population triggers that READ NEW/OLD on the three
-- catalog source tables and INSERT into catalog_change_log.
--
-- CURSOR (R1/R9): `sequence` is a SINGLE GLOBAL monotonic identity
--   (GENERATED ALWAYS AS IDENTITY). Filtered by tenant_id at read it is
--   monotonic-WITHIN-tenant by construction and sparse per store — that is
--   correct (FR-022 = server-guaranteed completeness, NOT consumer-verified
--   contiguity). A per-tenant max()+1 counter is intentionally NOT used: it
--   races under concurrent catalog writes. The snapshot's opaque cursor
--   (FR-011) IS this sequence value, so the migration is FOUNDATIONAL — it
--   blocks US1 (snapshot) and US2 (delta), not US2 alone.
--
-- FAN-OUT (R9 — resolves external-review R-3): the triggers are deliberately
--   DUMB — exactly ONE row per raw catalog change, NO cross-store fan-out, NO
--   consultation of store_product_overrides. A tenant_products / tenant-wide
--   alias change writes ONE store_id IS NULL (sentinel) row; a
--   store_product_overrides / store-scoped alias change writes ONE store_id = S
--   row. The delta read unions `(store_id = S OR store_id IS NULL)`.
--   Override-masking (a tenant-level change to a field store S overrides) is a
--   harmless read-side idempotent re-upsert (resolver computes Tenant ⊕
--   Override; override wins; FR-021), NOT special-cased here.
--   Worst-case write = ONE INSERT per raw UPDATE — no amplification.
--
-- op (TEXT + CHECK, mirroring 0014 — no pgEnum precedent in repo):
--   'upsert'                — a sellable-relevant field changed OR the row
--                             crossed INTO sellability.
--   'remove_from_sellable'  — retire / deactivate / price→NULL / currency dropped
--                             (the row crossed OUT) at the RAW table level.
--
-- ⚠️ The stored `op` is ADVISORY, not the wire verdict. The trigger fires on a
--   single raw table and CANNOT resolve a product's sellability for store S
--   (that needs Tenant ⊕ Override, which the dumb trigger deliberately does not
--   compute — R9). A change-log row means only "something sellable-relevant
--   changed at this sequence for this (product_id, scope)". The DELTA READ
--   (010-US2-DELTA / T044) MUST re-resolve Tenant ⊕ Override per (tenant, store)
--   for each changed product_id and DERIVE the wire op from the CURRENT resolved
--   state (upsert+row when sellable for S, remove_from_sellable when not). This
--   is why the trigger can over-emit harmlessly (the read-side idempotent
--   re-upsert, R9) — e.g. an override DELETE logs a store-scoped removal hint but
--   the read re-resolves to the still-sellable tenant base and emits upsert;
--   an override UPDATE is_active=false logs an upsert hint but the read emits
--   remove_from_sellable. See data-model.md §3/§4. The trigger's only contract
--   is: log exactly ONE row for every changed (product_id, scope).
--
-- RLS (mirror 0010/0014 — fail-closed empty-GUC CASE guard): ENABLE + FORCE,
--   SELECT + INSERT policies ONLY (append-only — no UPDATE/DELETE policy). The
--   trigger INSERT runs in the catalog write transaction's tenant-GUC context
--   (runWithTenantContext sets app.current_tenant), so a plain INSERT satisfies
--   the INSERT policy — NO SECURITY DEFINER (which would bypass §II isolation).
--
-- Population functions read NEW/OLD on the source tables ONLY and INSERT into
-- catalog_change_log. They NEVER mutate the source row (read-only Non-Goal,
-- §3 / T001 [SIGN-OFF]). plpgsql house style mirrors
-- 0003_session_active_store_tenant_invariant.sql.

BEGIN;

-- ===========================================================================
-- 1. catalog_change_log (data-model.md §3) — append-only read-down change-log
-- ===========================================================================
CREATE TABLE IF NOT EXISTS catalog_change_log (
  -- Single GLOBAL monotonic cursor (R9). PK + IDENTITY: concurrency-safe,
  -- monotonic-within-tenant when filtered by tenant_id at read.
  sequence      BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- NULLABLE: NULL = tenant-wide (sentinel) event; non-NULL = store-scoped (R9).
  store_id      UUID         REFERENCES stores(id) ON DELETE RESTRICT,
  -- Provenance only — the resolved payload is computed at read time (§1/§4).
  product_id    UUID         NOT NULL REFERENCES tenant_products(id) ON DELETE RESTRICT,
  op            TEXT         NOT NULL,
  -- Diagnostics only — ordering uses `sequence`, never this.
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT catalog_change_log_op_allowed
    CHECK (op IN ('upsert', 'remove_from_sellable'))
);

-- The delta-read access path (R9): WHERE tenant_id = T AND (store_id = S OR
-- store_id IS NULL) AND sequence > C ORDER BY sequence. Lead with
-- (tenant_id, sequence); store_id is a filter column resolved by the heap fetch.
CREATE INDEX IF NOT EXISTS idx_catalog_change_log_tenant_sequence
  ON catalog_change_log (tenant_id, sequence);

ALTER TABLE catalog_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_change_log FORCE ROW LEVEL SECURITY;

CREATE POLICY catalog_change_log_tenant_read ON catalog_change_log
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- INSERT-only: append-only change-log, no UPDATE/DELETE policy. Even a role
-- holding UPDATE/DELETE grants is denied under FORCE. The trigger INSERT runs
-- under the catalog write txn's tenant GUC, so this WITH CHECK passes.
CREATE POLICY catalog_change_log_tenant_insert ON catalog_change_log
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- ===========================================================================
-- 2. Population trigger: tenant_products (tenant-wide / store_id IS NULL events)
-- ===========================================================================
-- DUMB: one row per raw change; no store fan-out, no overrides consultation.
-- A sellable-relevant field changing OR a row crossing INTO sellability emits
-- 'upsert'; crossing OUT (retire / deactivate / price→NULL / currency dropped)
-- emits 'remove_from_sellable'. "Sellable base" = retired_at IS NULL AND
-- is_active AND default_price IS NOT NULL AND default_currency_code IS NOT NULL.
CREATE OR REPLACE FUNCTION catalog_change_log_from_tenant_products()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_sellable BOOLEAN;
  new_sellable BOOLEAN;
  changed      BOOLEAN;
  log_op       TEXT;
BEGIN
  -- INSERT: no OLD; treat as a sellability-relevant change.
  IF TG_OP = 'INSERT' THEN
    new_sellable := (NEW.retired_at IS NULL AND NEW.is_active
                     AND NEW.default_price IS NOT NULL
                     AND NEW.default_currency_code IS NOT NULL);
    -- A brand-new non-sellable row produces nothing (it was never sellable and
    -- is not now) — avoid noise; the consumer only cares about sellable rows.
    IF NOT new_sellable THEN
      RETURN NEW;
    END IF;
    INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
      VALUES (NEW.tenant_id, NULL, NEW.id, 'upsert');
    RETURN NEW;
  END IF;

  -- UPDATE: compute the sellability transition + whether a sellable-relevant
  -- field changed at all.
  old_sellable := (OLD.retired_at IS NULL AND OLD.is_active
                   AND OLD.default_price IS NOT NULL
                   AND OLD.default_currency_code IS NOT NULL);
  new_sellable := (NEW.retired_at IS NULL AND NEW.is_active
                   AND NEW.default_price IS NOT NULL
                   AND NEW.default_currency_code IS NOT NULL);

  changed := (NEW.default_price       IS DISTINCT FROM OLD.default_price)
          OR (NEW.default_currency_code IS DISTINCT FROM OLD.default_currency_code)
          OR (NEW.is_active           IS DISTINCT FROM OLD.is_active)
          OR (NEW.retired_at          IS DISTINCT FROM OLD.retired_at)
          OR (NEW.tax_category        IS DISTINCT FROM OLD.tax_category)
          OR (NEW.name                IS DISTINCT FROM OLD.name);

  -- Nothing sellable-relevant changed and no transition — no log row.
  IF NOT changed AND old_sellable = new_sellable THEN
    RETURN NEW;
  END IF;

  IF old_sellable AND NOT new_sellable THEN
    log_op := 'remove_from_sellable';   -- crossed OUT
  ELSE
    -- crossed IN, or stayed sellable with a sellable-relevant field change.
    -- (A non-sellable row whose non-sellable-affecting field changed yields
    --  upsert harmlessly; the read-side filter excludes it from the stream.)
    log_op := 'upsert';
  END IF;

  INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
    VALUES (NEW.tenant_id, NULL, NEW.id, log_op);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_change_log_tenant_products ON tenant_products;
CREATE TRIGGER catalog_change_log_tenant_products
  AFTER INSERT OR UPDATE ON tenant_products
  FOR EACH ROW
  EXECUTE FUNCTION catalog_change_log_from_tenant_products();

-- ===========================================================================
-- 3. Population trigger: store_product_overrides (store-scoped / store_id = S)
-- ===========================================================================
-- The override row carries product_id + store_id + tenant_id. An override
-- nullable field inherits the tenant value when NULL; the trigger cannot fully
-- resolve sellability for S (that is the read-side resolver's job, R9). The
-- dumb rule: any sellable-relevant override field change emits 'upsert';
-- retiring the override row OR a DELETE emits 'remove_from_sellable' (S falls
-- back to the tenant row — a re-resolve is needed, modelled as a removal then
-- the consumer re-pulls / the tenant-wide event covers it on next change). The
-- read-side idempotent re-upsert (R9) absorbs any over-emission harmlessly.
CREATE OR REPLACE FUNCTION catalog_change_log_from_store_overrides()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed BOOLEAN;
  log_op  TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Override removed — S's resolved row reverts to the tenant base; emit a
    -- removal so the consumer re-resolves (the tenant-wide stream then governs).
    INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
      VALUES (OLD.tenant_id, OLD.store_id, OLD.product_id, 'remove_from_sellable');
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A new override always changes S's resolved view of the product.
    log_op := CASE
      WHEN NEW.retired_at IS NOT NULL THEN 'remove_from_sellable'
      ELSE 'upsert'
    END;
    INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
      VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, log_op);
    RETURN NEW;
  END IF;

  -- UPDATE: only emit when a sellable-relevant override field changed.
  changed := (NEW.price          IS DISTINCT FROM OLD.price)
          OR (NEW.currency_code  IS DISTINCT FROM OLD.currency_code)
          OR (NEW.is_active      IS DISTINCT FROM OLD.is_active)
          OR (NEW.tax_category   IS DISTINCT FROM OLD.tax_category)
          OR (NEW.retired_at     IS DISTINCT FROM OLD.retired_at);

  IF NOT changed THEN
    RETURN NEW;
  END IF;

  IF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL THEN
    log_op := 'remove_from_sellable';   -- override retired
  ELSE
    log_op := 'upsert';
  END IF;

  INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
    VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, log_op);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_change_log_store_overrides ON store_product_overrides;
CREATE TRIGGER catalog_change_log_store_overrides
  AFTER INSERT OR UPDATE OR DELETE ON store_product_overrides
  FOR EACH ROW
  EXECUTE FUNCTION catalog_change_log_from_store_overrides();

-- ===========================================================================
-- 4. Population trigger: product_aliases (scope follows the alias scope)
-- ===========================================================================
-- An alias change does not change price/availability but DOES change a sellable
-- row's projected `aliases[]` / `sku` — so it is sellable-relevant and emits an
-- 'upsert' (never a removal: an alias change cannot make a product leave the
-- sellable stream). The alias-table trigger RESOLVES THE PARENT product_id
-- (product_aliases.product_id, NOT NULL) into the change-log row (resolves
-- analyze finding U2). Scope: tenant-wide alias (store_id IS NULL) → sentinel
-- row; store-scoped alias (store_id = S) → store row.
CREATE OR REPLACE FUNCTION catalog_change_log_from_product_aliases()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
      VALUES (OLD.tenant_id, OLD.store_id, OLD.product_id, 'upsert');
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
      VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, 'upsert');
    RETURN NEW;
  END IF;

  -- UPDATE: emit only when an alias field the projection surfaces changed.
  changed := (NEW.value           IS DISTINCT FROM OLD.value)
          OR (NEW.identifier_type IS DISTINCT FROM OLD.identifier_type)
          OR (NEW.retired_at      IS DISTINCT FROM OLD.retired_at)
          OR (NEW.store_id        IS DISTINCT FROM OLD.store_id);

  IF NOT changed THEN
    RETURN NEW;
  END IF;

  INSERT INTO catalog_change_log (tenant_id, store_id, product_id, op)
    VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, 'upsert');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_change_log_product_aliases ON product_aliases;
CREATE TRIGGER catalog_change_log_product_aliases
  AFTER INSERT OR UPDATE OR DELETE ON product_aliases
  FOR EACH ROW
  EXECUTE FUNCTION catalog_change_log_from_product_aliases();

COMMIT;
