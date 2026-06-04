/**
 * read-down-sweep.spec.ts — 010 catalogue read-down cross-tenant/cross-store +
 * RLS-bypass isolation sweep (T015).
 *
 * Two kinds of assertion live here, by design (010-ISOLATION-HARNESS slice
 * contract: "RED on the missing snapshot/delta operation, NOT on RLS"):
 *
 *   GROUP A — RLS / isolation (RUN + PASS NOW). With the seed-read-down fixture
 *     populated across tenants A/B and stores X/Y (it calls
 *     seedCatalogIsolationFixture first), these prove the data-layer guarantee
 *     the slice exists to deliver on the NEW 0015 `catalog_change_log` table: a
 *     wrong / unset `app.current_tenant` GUC returns ZERO rows, and a
 *     wrong-tenant GUC exposes only that tenant's rows. Run against `env.app`
 *     (the RLS-enforced non-superuser pool — NOT `env.admin`, which bypasses
 *     RLS). The change-log rows here are produced by the 0015 POPULATION
 *     TRIGGERS firing as the fixture seeds priced products + overrides — so this
 *     also proves the triggers wrote tenant-scoped rows that RLS then isolates.
 *
 *   GROUP B — snapshot/delta operation (HTTP). The `posGetCatalogSnapshot` /
 *     `posGetCatalogDeltas` routes do NOT exist yet (010-US1-SNAPSHOT onward
 *     authors the ReadDownController/Service). These cases are written to FAIL
 *     on the MISSING operation (not on RLS) and turn GREEN as the routes land —
 *     the slice's intended RED. They are `describe.skip` behind a marker until
 *     the controller exists (mirrors the 009 inventory-sweep idiom: a hard RED
 *     cannot merge under the suite-gating CI; the RLS half IS the harness
 *     deliverable and runs green now).
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned) — extends via
 * seed-read-down.ts only.
 *
 * Transport: DB/RLS layer for Group A (no HTTP), mirroring the 008/009
 * sweep idiom (withRawClient + set_config LOCAL + ROLLBACK).
 *
 * Docker policy: a missing Docker runtime is a HARD failure unless
 * `MIGRATION_TEST_ALLOW_SKIP=1` is set (CI MUST NOT set it). Run targeted.
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { TENANT_A, TENANT_B } from "../../__support__/isolation-harness";
import {
  READ_DOWN_FIXTURE_IDS,
  seedReadDownFixture,
} from "../__support__/seed-read-down";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// A UUID never inserted into any fixture.
const NON_EXISTENT_TENANT = "0f000000-0000-7000-8000-00000000dead";

// The single NEW 010 table the change-log RLS protects.
const READ_DOWN_TABLES = ["catalog_change_log"] as const;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    // seedReadDownFixture calls seedCatalogIsolationFixture internally, then
    // inserts the priced products + overrides whose INSERT/UPDATE fire the 0015
    // population triggers → catalog_change_log rows for tenant A.
    await seedReadDownFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[read-down-sweep] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[read-down-sweep] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * Acquire an `env.app` (RLS-enforced) client, wrap in BEGIN/ROLLBACK so the
 * LOCAL `set_config` GUC is discarded — no GUC bleed across tests.
 */
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

const F = READ_DOWN_FIXTURE_IDS;

// ===========================================================================
// GROUP A — RLS / isolation (RUN + PASS NOW)
// ===========================================================================

describe("read-down-sweep §A.1 — wrong-tenant GUC exposes only that tenant's change-log rows", () => {
  it.each(READ_DOWN_TABLES)(
    "%s: app.current_tenant = TENANT_B → zero TENANT_A rows visible",
    async (table) => {
      if (maybeSkip()) return;
      const rows = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          TENANT_B,
        ]);
        const r = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM ${table}`,
        );
        return r.rows;
      });
      for (const row of rows) {
        expect(row.tenant_id).toBe(TENANT_B);
      }
      expect(rows.filter((r) => r.tenant_id === TENANT_A)).toEqual([]);
    },
  );
});

describe("read-down-sweep §A.2 — RLS-bypass probe: wrong tenant ⇒ zero rows", () => {
  it.each(READ_DOWN_TABLES)(
    "%s: a non-existent app.current_tenant returns zero rows",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          NON_EXISTENT_TENANT,
        ]);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("read-down-sweep §A.3 — fail-closed: unset tenant GUC ⇒ zero rows", () => {
  it.each(READ_DOWN_TABLES)(
    "%s: no app.current_tenant set returns zero rows (empty-GUC CASE guard)",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        // No set_config — current_setting('app.current_tenant', true) returns
        // '' → CASE guard yields NULL → NULL = tenant_id → row filtered.
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );
});

describe("read-down-sweep §A.4 — in-scope baseline (anchors the sweep, prevents vacuous passes)", () => {
  // If this did NOT return rows, the §A.1-A.3 zero-row assertions could pass
  // vacuously (nothing seeded). This proves the 0015 triggers populated
  // catalog_change_log for tenant A as the fixture seeded.
  it("TENANT_A GUC sees its own seeded change-log rows (trigger-populated)", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ tenant_id: string; product_id: string }>(
        `SELECT tenant_id, product_id FROM catalog_change_log WHERE tenant_id = $1`,
        [TENANT_A],
      );
      return r.rows;
    });
    // The seed inserted a priced product + a non-representable product + an
    // override on tenant A — each fires a trigger row. At least the sellable
    // product's row must be present and attributed to tenant A.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
    expect(rows.some((r) => r.product_id === F.sellableProduct)).toBe(true);
  });

  it("TENANT_B GUC does NOT see TENANT_A's change-log rows (seeded-invisibility)", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_B,
      ]);
      const r = await client.query<{ product_id: string }>(
        `SELECT product_id FROM catalog_change_log WHERE product_id = $1`,
        [F.sellableProduct],
      );
      return r.rows;
    });
    // Tenant A's change-log row exists but is invisible under tenant B's GUC.
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
// GROUP B — snapshot/delta operation object-safety (HTTP)
// ===========================================================================
//
// The posGetCatalogSnapshot / posGetCatalogDeltas routes do NOT exist yet —
// 010-US1-SNAPSHOT authors the ReadDownController/Service (snapshot) and
// 010-US2-DELTA the delta. These cases are the slice's intended RED: they fail
// on the MISSING operation, not on RLS. They are `describe.skip` until the
// routes land (mirrors 009 inventory-sweep §B: a hard-failing RED cannot merge
// under the suite-gating CI; the GROUP A RLS proof above IS the harness
// deliverable and runs green now). 010-US1-SNAPSHOT (T036) + 010-US3-ISOLATION
// (T053) un-skip and complete the HTTP sweep across snapshot + delta:
//   - unauthenticated → 401; manager Clerk JWT without device principal → rejected;
//   - cross-tenant/cross-store branch_id → non-disclosing 404-class;
//   - foreign `since` cursor → non-disclosing rejection;
//   - unresolved store context → store_context_required;
//   - the device principal is the ONLY scope ever served.
// 010-US3-ISOLATION (T053) — the HTTP cross-scope sweep (unauth → 401; manager
// JWT w/o device principal → 401; branch_id mismatch → non-disclosing 404;
// foreign `since` → non-disclosing; unresolved store → store_context_required)
// is authored against the booted Nest app in the sibling isolation specs
// (device-auth-required / scope-mismatch / store-context-required) + the snapshot
// spec's T036, because that surface needs the real controller + guards. THIS
// file's unique contribution is the DB-LAYER proof: the RESOLVED READ PATH
// (tenant_products ⊕ store_product_overrides — the tables US1's resolver joins)
// is tenant+store isolated under RLS, NOT just the change-log (§A above). A
// raw-SQL RLS-bypass on those source tables proves the device principal's scope
// is the ONLY data the resolver could ever surface, even if a route forgot a
// predicate (defense beneath the controller).
describe("read-down-sweep §B — resolved read path RLS-bypass (T053, DB-layer)", () => {
  it.each(["tenant_products", "store_product_overrides"] as const)(
    "%s: a non-existent app.current_tenant returns zero rows (resolver source isolated)",
    async (table) => {
      if (maybeSkip()) return;
      const count = await withRawClient(async (client) => {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
          NON_EXISTENT_TENANT,
        ]);
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}`,
        );
        return r.rows[0]?.count;
      });
      expect(count).toBe("0");
    },
  );

  it("store_product_overrides: TENANT_A + a wrong store GUC hides another store's overrides (store-axis RLS)", async () => {
    if (maybeSkip()) return;
    // The resolver sets app.current_store to the device's store; the override
    // join is store-axis RLS'd (0008/0009/0011). Under TENANT_A + a non-existent
    // store, the seeded A-X override is invisible — proving a wrong/forged store
    // scope cannot surface another store's overrides.
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      await client.query(`SELECT set_config('app.current_store', $1, true)`, [
        "0f000000-0000-7000-8000-0000000000ff",
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM store_product_overrides WHERE store_id <> current_setting('app.current_store', true)::uuid`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});
