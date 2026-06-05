/**
 * 014-ISOLATION-HARNESS (T020) — erpnext_warehouse_map RLS isolation sweep.
 *
 * Proves the tenant isolation shipped with migration 0018 holds for the
 * `erpnext_warehouse_map` table. DB/RLS-layer only — mirrors the 013-owned
 * `apps/api/test/catalog/erpnext-item-map/isolation/item-map-sweep.spec.ts`:
 * raw `set_config` GUC manipulation inside explicit BEGIN/ROLLBACK transactions
 * on the non-superuser `app_test` pool, so GUC bleed between tests is
 * impossible (LOCAL scope discards on ROLLBACK).
 *
 * These probes characterise ALREADY-SHIPPED behaviour (the 0018 RLS policies),
 * so the suite is GREEN — the same posture as the schema round-trip test. The
 * operations-level cross-tenant 404 (set/retire addressing a foreign mapping)
 * is exercised in 014-CRUD, where the controller exists and a meaningful
 * NON-DISCLOSING 404 can be asserted.
 *
 * Coverage
 * --------
 * §A wrong-tenant GUC      → only the GUC tenant's rows are visible
 * §B unset-tenant GUC      → fail-closed (0 rows); INSERT denied
 * §C cross-tenant read     → tenant A cannot SELECT tenant B's mapping (0 rows)
 * §D cross-tenant INSERT   → tenant A cannot write a row tagged tenant B
 * §E purpose-grain unique  → a 2nd active 'stock' per store → 23505; a 'returns'
 *                            row coexists
 * §F cross-store           → VACUOUS: erpnext_warehouse_map has NO store RLS
 *                            axis (store_id is a tenant-local FK) — asserted.
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ACTOR_A,
  STORE_A_X,
} from "../../__support__/isolation-harness";
import {
  WAREHOUSE_MAP_FIXTURE_IDS,
  MAP_A_STOCK,
  MAP_B_STOCK,
  seedWarehouseMapFixture,
} from "../__support__/seed-warehouse-map";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const TENANT_A = WAREHOUSE_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = WAREHOUSE_MAP_FIXTURE_IDS.tenantB;

// ---- Lifecycle ------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedWarehouseMapFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[warehouse-map-sweep.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[warehouse-map-sweep.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Raw probe helper -----------------------------------------------------
// Non-superuser client, explicit BEGIN/ROLLBACK so set_config LOCAL is
// discarded — no GUC bleed across pooled connections.

async function withRawClient<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await env!.app.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---- Denial-assertion helper ---------------------------------------------

type PgErr = Error & { code?: string };
const DENIAL_SQLSTATES = new Set(["42501", "23514", "22P02"]);

async function expectDeniedByPolicyOrCast(
  promise: Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const err = caught as PgErr;
  expect(typeof err.code).toBe("string");
  if (!DENIAL_SQLSTATES.has(err.code as string)) {
    throw new Error(
      `Expected SQLSTATE in {42501, 23514, 22P02}, got ${err.code}: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §A — wrong-tenant GUC: only the GUC tenant's rows are visible
// ---------------------------------------------------------------------------

describe("014 §A — erpnext_warehouse_map wrong-tenant GUC", () => {
  it("tenant-B GUC exposes only tenant-B rows", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_B,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM erpnext_warehouse_map ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("tenant-A GUC never surfaces the tenant-B mapping", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_warehouse_map ORDER BY id`,
      );
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(MAP_A_STOCK);
    expect(ids).not.toContain(MAP_B_STOCK);
  });
});

// ---------------------------------------------------------------------------
// §B — unset-tenant GUC: fail-closed
// ---------------------------------------------------------------------------

describe("014 §B — erpnext_warehouse_map unset-tenant GUC", () => {
  it("unset tenant GUC: SELECT returns 0 rows (empty-GUC CASE guard)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erpnext_warehouse_map`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("unset tenant GUC: INSERT is denied", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      await expectDeniedByPolicyOrCast(
        client.query(
          `INSERT INTO erpnext_warehouse_map
             (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
              set_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'stock', 'BYPASS', $3, 1)`,
          [TENANT_A, STORE_A_X, ACTOR_A],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §C — cross-tenant read: known foreign id still returns 0 rows
// ---------------------------------------------------------------------------

describe("014 §C — erpnext_warehouse_map cross-tenant read", () => {
  it("tenant A cannot read tenant B's mapping even by known id", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_warehouse_map WHERE id = $1`,
        [MAP_B_STOCK],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §D — cross-tenant INSERT: tenant A cannot write a row tagged tenant B
// ---------------------------------------------------------------------------

describe("014 §D — erpnext_warehouse_map cross-tenant INSERT", () => {
  it("tenant-A GUC: INSERT tagged tenant B is denied by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      await expectDeniedByPolicyOrCast(
        client.query(
          `INSERT INTO erpnext_warehouse_map
             (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
              set_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'stock', 'CROSS', $3, 1)`,
          // tenant_id = B while GUC = A → WITH CHECK fails (42501)
          [TENANT_B, WAREHOUSE_MAP_FIXTURE_IDS.storeBMapped, ACTOR_A],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §E — purpose-grain partial-unique holds (retired excluded; 'returns' coexists)
// ---------------------------------------------------------------------------

describe("014 §E — erpnext_warehouse_map purpose-grain partial-unique", () => {
  it("a 2nd ACTIVE 'stock' mapping for the same store is rejected (23505)", async () => {
    if (maybeSkip()) return;
    // The active 'stock' mapping on STORE_A_X exists; a second active 'stock'
    // row for the same (tenant, store, purpose) must violate the partial-unique.
    let caught: PgErr | undefined;
    try {
      await withRawClient(async (client) => {
        await client.query(
          `SELECT set_config('app.current_tenant', $1, true)`,
          [TENANT_A],
        );
        await client.query(
          `INSERT INTO erpnext_warehouse_map
             (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
              set_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'stock', 'DUP-ACTIVE', $3, 1)`,
          [TENANT_A, STORE_A_X, ACTOR_A],
        );
      });
    } catch (err) {
      caught = err as PgErr;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("23505");
  });

  it("a 'returns' mapping for the same store COEXISTS with the active 'stock' (OQ-2 grain)", async () => {
    if (maybeSkip()) return;
    // Rolled back, so the seed is unaffected.
    const inserted = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO erpnext_warehouse_map
           (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
            set_by, version)
         VALUES (gen_random_uuid(), $1, $2, 'returns', 'ERP-WH-A-RET', $3, 1)
         RETURNING id`,
        [TENANT_A, STORE_A_X, ACTOR_A],
      );
      return r.rows[0]?.id;
    });
    expect(typeof inserted).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// §F — cross-store is VACUOUS: erpnext_warehouse_map has no store RLS axis
// ---------------------------------------------------------------------------

describe("014 §F — erpnext_warehouse_map has no store RLS axis (vacuous cross-store)", () => {
  it("the table is tenant-scoped — store_id is a tenant-local FK, not an RLS axis", async () => {
    if (maybeSkip()) return;
    const policies = await withRawClient(async (client) => {
      const r = await client.query<{ qual: string | null }>(
        `SELECT qual FROM pg_policies WHERE tablename = 'erpnext_warehouse_map'`,
      );
      return r.rows.map((x) => x.qual ?? "");
    });
    // No policy references app.current_store — isolation is on app.current_tenant only.
    for (const qual of policies) {
      expect(qual).not.toContain("app.current_store");
    }
    expect(policies.length).toBeGreaterThan(0);
  });
});
