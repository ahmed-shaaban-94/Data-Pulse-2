/**
 * apps/api/test/catalog/erpnext-warehouse-map/__support__/seed-warehouse-map.ts
 *
 * Slice 014-ISOLATION-HARNESS (T020) — erpnext_warehouse_map test fixtures.
 *
 * Companion seed for the 014 store↔warehouse mapping surface. It builds ON TOP
 * of the 003-owned `seedCatalogIsolationFixture` (tenants A/B, stores A-X/A-Y +
 * B-X/B-Y, actors A/B) — which it calls first — and adds the
 * `erpnext_warehouse_map` rows the isolation sweep + CRUD specs exercise:
 *
 *   - tenant A: an ACTIVE 'stock' mapping on STORE_A_X (the resolvable happy
 *     path) and a RETIRED row on STORE_A_Y (history — proves the partial-unique
 *     is on the ACTIVE set only);
 *   - tenant B: an ACTIVE 'stock' mapping on STORE_B_X — the cross-tenant target
 *     the sweep proves tenant A can never read.
 *
 * `erpnext_warehouse_map` is TENANT-only — `store_id` is a tenant-local FK, not
 * a second RLS axis (data-model §5). So this seed sets only `app.current_tenant`
 * (no `app.current_store`), and the sweep's cross-store assertion is
 * deliberately vacuous.
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `apps/api/test/catalog/__support__/isolation-harness.ts`. It imports the
 * parent fixture IDs from it and seeds only NEW rows via the `admin` (RLS-
 * bypassing superuser) pool. `.ts` (not `.spec.ts`) so Jest does not collect
 * it as a test.
 *
 * IDs use the `0a…d014…` / `0b…d014…` mnemonic shape (UUIDv7-like, hex a-f
 * only) to stay unique against the t340 catalog corpus + the 013 d013 corpus.
 */
import {
  ACTOR_A,
  ACTOR_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
  type SeedableEnv,
} from "../../__support__/isolation-harness";

// ----------------------------------------------------------------------------
// 014-specific fixture IDs
// ----------------------------------------------------------------------------

/** Tenant A — ACTIVE 'stock' mapping on STORE_A_X (resolvable). */
export const MAP_A_STOCK = "0a000000-0000-7000-8000-00000d014c11";
/** Tenant A — RETIRED mapping on STORE_A_Y (history; not in the active set). */
export const MAP_A_RETIRED = "0a000000-0000-7000-8000-00000d014011";
/** Tenant B — ACTIVE 'stock' mapping (the cross-tenant target). */
export const MAP_B_STOCK = "0b000000-0000-7000-8000-00000d014c22";

export interface WarehouseMapFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly mapAStock: string;
  readonly mapARetired: string;
  readonly mapBStock: string;
  /** The tenant-A store that already carries the active 'stock' mapping. */
  readonly storeAMapped: string;
  /** The tenant-A store used by the retired mapping. */
  readonly storeARetired: string;
  /** The tenant-B store behind MAP_B_STOCK. */
  readonly storeBMapped: string;
  readonly actorA: string;
  readonly actorB: string;
}

export const WAREHOUSE_MAP_FIXTURE_IDS: WarehouseMapFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  mapAStock: MAP_A_STOCK,
  mapARetired: MAP_A_RETIRED,
  mapBStock: MAP_B_STOCK,
  storeAMapped: STORE_A_X,
  storeARetired: STORE_A_Y,
  storeBMapped: STORE_B_X,
  actorA: ACTOR_A,
  actorB: ACTOR_B,
});

/**
 * Seed the 014 fixtures. Calls `seedCatalogIsolationFixture` first (tenants +
 * stores + actors), then adds the erpnext_warehouse_map rows. Idempotent
 * (`ON CONFLICT DO NOTHING`) so it is safe to call once per suite.
 *
 * v1 only ever writes `purpose='stock'`. The RETIRED row keeps the active
 * partial-unique on (tenant_id, store_id, purpose) WHERE retired_at IS NULL
 * satisfied — it shares no active slot with the STORE_A_X 'stock' row.
 */
export async function seedWarehouseMapFixture(
  env: SeedableEnv,
): Promise<WarehouseMapFixtureIds> {
  await seedCatalogIsolationFixture(env);
  const { admin } = env;

  // ---- Tenant A: active 'stock' on STORE_A_X + retired on STORE_A_Y ---------
  await admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
        set_by, version, retired_at)
     VALUES
       -- ACTIVE 'stock': resolvable.
       ($1, $2, $3, 'stock', 'ERP-WH-A-001', $4, 1, NULL),
       -- RETIRED: history on a different store.
       ($5, $2, $6, 'stock', 'ERP-WH-A-OLD', $4, 1, now())
     ON CONFLICT DO NOTHING`,
    [
      MAP_A_STOCK, TENANT_A, STORE_A_X, ACTOR_A,
      MAP_A_RETIRED, STORE_A_Y,
    ],
  );

  // ---- Tenant B: active 'stock' (the cross-tenant target) -------------------
  await admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
        set_by, version, retired_at)
     VALUES
       ($1, $2, $3, 'stock', 'ERP-WH-B-001', $4, 1, NULL)
     ON CONFLICT DO NOTHING`,
    [MAP_B_STOCK, TENANT_B, STORE_B_X, ACTOR_B],
  );

  return WAREHOUSE_MAP_FIXTURE_IDS;
}
