/**
 * apps/api/test/catalog/erpnext-item-map/__support__/seed-item-map.ts
 *
 * Slice 013-ISOLATION-HARNESS (T020) — erpnext_item_map test fixtures.
 *
 * Companion seed for the 013 product-master mapping surface. It builds ON TOP
 * of the 003-owned `seedCatalogIsolationFixture` (tenants A/B, base products
 * PRODUCT_A_ACTIVE / PRODUCT_B_ACTIVE, actors A/B) — which it calls first — and
 * adds the `erpnext_item_map` rows the isolation sweep + CRUD/REPOINT specs
 * exercise:
 *
 *   - tenant A: a CONFIRMED active mapping on PRODUCT_A_ACTIVE (the resolvable
 *     happy path), a SUGGESTED active mapping on PRODUCT_A_RETIRED's product
 *     slot (the review-queue case — inert until confirmed), and a RETIRED row
 *     (history — proves the 1:1 partial-unique is on the ACTIVE set only);
 *   - tenant B: a CONFIRMED active mapping on PRODUCT_B_ACTIVE — the
 *     cross-tenant target the sweep proves tenant A can never read.
 *
 * `erpnext_item_map` is TENANT-only — there is NO store axis (OQ-3/OQ-4
 * resolved as no-column; data-model §1/§6). So this seed sets only
 * `app.current_tenant` (no `app.current_store`), and the sweep's cross-store
 * assertion is deliberately vacuous.
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `apps/api/test/catalog/__support__/isolation-harness.ts`. It imports the
 * parent fixture IDs from it and seeds only NEW rows via the `admin` (RLS-
 * bypassing superuser) pool. `.ts` (not `.spec.ts`) so Jest does not collect
 * it as a test.
 *
 * IDs use the `0a…d013…` / `0b…d013…` mnemonic shape (UUIDv7-like, hex a-f
 * only) to stay unique against the t340 catalog corpus + the 010 d010 corpus.
 */
import {
  ACTOR_A,
  ACTOR_B,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  PRODUCT_B_ACTIVE,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
  type SeedableEnv,
} from "../../__support__/isolation-harness";

// ----------------------------------------------------------------------------
// 013-specific fixture IDs
// ----------------------------------------------------------------------------

/** Tenant A — CONFIRMED active mapping on PRODUCT_A_ACTIVE (resolvable). */
export const MAP_A_CONFIRMED = "0a000000-0000-7000-8000-00000d013c11";
/** Tenant A — SUGGESTED active mapping (review queue; inert until confirmed). */
export const MAP_A_SUGGESTED = "0a000000-0000-7000-8000-00000d013511";
/** Tenant A — RETIRED mapping (history; not in the active set). */
export const MAP_A_RETIRED = "0a000000-0000-7000-8000-00000d013011";
/** Tenant B — CONFIRMED active mapping (the cross-tenant target). */
export const MAP_B_CONFIRMED = "0b000000-0000-7000-8000-00000d013c22";

export interface ItemMapFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly mapAConfirmed: string;
  readonly mapASuggested: string;
  readonly mapARetired: string;
  readonly mapBConfirmed: string;
  /** The tenant-A product that already carries the confirmed mapping. */
  readonly productAConfirmed: string;
  /** The tenant-A product slot used by the suggested mapping. */
  readonly productASuggested: string;
  /** The tenant-B product behind MAP_B_CONFIRMED. */
  readonly productBConfirmed: string;
  readonly actorA: string;
  readonly actorB: string;
}

export const ITEM_MAP_FIXTURE_IDS: ItemMapFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  mapAConfirmed: MAP_A_CONFIRMED,
  mapASuggested: MAP_A_SUGGESTED,
  mapARetired: MAP_A_RETIRED,
  mapBConfirmed: MAP_B_CONFIRMED,
  productAConfirmed: PRODUCT_A_ACTIVE,
  productASuggested: PRODUCT_A_RETIRED,
  productBConfirmed: PRODUCT_B_ACTIVE,
  actorA: ACTOR_A,
  actorB: ACTOR_B,
});

/**
 * Seed the 013 fixtures. Calls `seedCatalogIsolationFixture` first (tenants +
 * base products + actors), then adds the erpnext_item_map rows. Idempotent
 * (`ON CONFLICT DO NOTHING`) so it is safe to call once per suite.
 *
 * The CONFIRMED rows satisfy the confirmed-only CHECK (state='confirmed' ⇒
 * confirmed_by/confirmed_at NOT NULL); the SUGGESTED + RETIRED-from-suggested
 * rows keep both NULL. The RETIRED row shares PRODUCT_A_RETIRED with the
 * SUGGESTED row but is itself retired, so the active partial-unique
 * (tenant_id, tenant_product_id) WHERE retired_at IS NULL still admits exactly
 * one active mapping per product.
 */
export async function seedItemMapFixture(
  env: SeedableEnv,
): Promise<ItemMapFixtureIds> {
  await seedCatalogIsolationFixture(env);
  const { admin } = env;

  // ---- Tenant A: confirmed + suggested (active) + retired (history) ---------
  await admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, suggested_by, confirmed_by, confirmed_at,
        version, retired_at)
     VALUES
       -- CONFIRMED active: resolvable. confirmed provenance present.
       ($1, $2, $3, 'ERP-ITEM-A-001', 'confirmed', 'manual', $4, $4, now(), 1, NULL),
       -- SUGGESTED active: inert. confirmed_* NULL.
       ($5, $2, $6, 'ERP-ITEM-A-SUGG', 'suggested', 'manual', $4, NULL, NULL, 1, NULL),
       -- RETIRED: history. shares product slot with the suggested row but is
       -- retired, so the active partial-unique is not violated.
       ($7, $2, $6, 'ERP-ITEM-A-OLD', 'suggested', 'manual', $4, NULL, NULL, 1, now())
     ON CONFLICT DO NOTHING`,
    [
      MAP_A_CONFIRMED, TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A,
      MAP_A_SUGGESTED, PRODUCT_A_RETIRED,
      MAP_A_RETIRED,
    ],
  );

  // ---- Tenant B: confirmed active (the cross-tenant target) -----------------
  await admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
        suggestion_source, suggested_by, confirmed_by, confirmed_at,
        version, retired_at)
     VALUES
       ($1, $2, $3, 'ERP-ITEM-B-001', 'confirmed', 'manual', $4, $4, now(), 1, NULL)
     ON CONFLICT DO NOTHING`,
    [MAP_B_CONFIRMED, TENANT_B, PRODUCT_B_ACTIVE, ACTOR_B],
  );

  return ITEM_MAP_FIXTURE_IDS;
}
