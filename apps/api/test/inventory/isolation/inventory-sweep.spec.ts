/**
 * inventory-sweep.spec.ts — 009 inventory-ledger cross-tenant/cross-store +
 * RLS-bypass isolation sweep (T015).
 *
 * Two kinds of assertion live here, by design (009-ISOLATION-HARNESS slice
 * contract: "RED on missing movement/on-hand/transfer/count operations, NOT on
 * RLS"):
 *
 *   GROUP A — RLS / isolation (RUN + PASS NOW). With the seed-inventory fixture
 *     populated across tenants A/B and stores X/Y, these prove the data-layer
 *     guarantee the slice exists to deliver: a wrong / unset `app.current_tenant`
 *     GUC returns ZERO rows from stock_movements + stock_counts, and a
 *     wrong-tenant GUC exposes only that tenant's rows. Run against `env.app`
 *     (the RLS-enforced non-superuser pool — NOT `env.admin`, which bypasses
 *     RLS). This is the first place 009 isolation is proven with rows ACTUALLY
 *     PRESENT in tenant A and invisible to tenant B (the 0014 migration
 *     round-trip proved fail-closed on EMPTY tables only — this closes the
 *     CodeRabbit #440 follow-up that asked for a seeded cross-tenant proof).
 *
 *   GROUP B — operation object-safety (HTTP). The movement-create / on-hand /
 *     list / transfer / count routes do NOT exist yet (009-US1-ONHAND onward
 *     authors the InventoryController/Service). These cases are written to FAIL
 *     on the MISSING operation (not on RLS), and turn GREEN as the operations
 *     land — the slice's intended RED. They are skipped here behind a guard
 *     until the controller exists.
 *
 * MUST NOT modify `isolation-harness.ts` (003-owned) — extend via seed-inventory.ts.
 *
 * Transport: DB/RLS layer for Group A (no HTTP), mirroring the 008
 * `sales-sweep.spec.ts` idiom (withRawClient + set_config LOCAL + ROLLBACK).
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
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";
import {
  seedInventoryFixture,
  INVENTORY_FIXTURE_IDS,
} from "../__support__/seed-inventory";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// A UUID never inserted into any fixture.
const NON_EXISTENT_TENANT = "0f000000-0000-7000-8000-00000000dead";

// The two 009 inventory tables.
const INVENTORY_TABLES = ["stock_movements", "stock_counts"] as const;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env); // parent tenants/stores/products/actors
    await seedInventoryFixture(env); // 009 inventory rows across A/B × X/Y
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[inventory-sweep] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[inventory-sweep] skipping — Docker unavailable");
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

const F = INVENTORY_FIXTURE_IDS;

// ===========================================================================
// GROUP A — RLS / isolation (RUN + PASS NOW)
// ===========================================================================

describe("inventory-sweep §A.1 — wrong-tenant GUC exposes only that tenant's rows", () => {
  it.each(INVENTORY_TABLES)(
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

describe("inventory-sweep §A.2 — RLS-bypass probe: wrong tenant ⇒ zero rows on every table", () => {
  it.each(INVENTORY_TABLES)(
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

describe("inventory-sweep §A.3 — fail-closed: unset tenant GUC ⇒ zero rows on every table", () => {
  it.each(INVENTORY_TABLES)(
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

describe("inventory-sweep §A.4 — in-scope baseline (anchors the sweep, prevents vacuous passes)", () => {
  // If these did NOT return rows, the §A.1-A.3 zero-row assertions could pass
  // vacuously (nothing seeded). This proves the fixture IS populated for A.
  it("TENANT_A GUC sees its own seeded movements (incl. sale-linked + ad-hoc)", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM stock_movements WHERE id = ANY($1::uuid[])`,
        [[F.moveAX, F.moveSaleLinkedAX, F.moveAdhocAX, F.moveCorrectionAX]],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
  });

  it("TENANT_A GUC sees its own stock_count row", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM stock_counts WHERE id = $1`,
        [F.countAX],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
  });

  it("TENANT_B GUC does NOT see TENANT_A's specific movements (seeded-invisibility, CodeRabbit #440 follow-up)", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_B,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM stock_movements WHERE id = ANY($1::uuid[])`,
        [[F.moveAX, F.moveSaleLinkedAX, F.moveAdhocAX]],
      );
      return r.rows;
    });
    // Tenant A's rows exist but are invisible under tenant B's GUC.
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
// GROUP B — operation object-safety (HTTP)
// ===========================================================================
//
// READ-path object-safety (T034) is DONE — authored Docker-FREE in
// `apps/api/test/inventory/on-hand/read-object-safety.spec.ts` (a
// FakeInventoryService + the real InventoryController + supertest), proving the
// corrected aggregate-read semantics:
//   - cross-STORE (scoped principal, wrong store) → 404 (non-disclosing, FR-051);
//   - cross-TENANT on-hand → 200/"0" and list → 200/empty (non-disclosure via
//     emptiness — a 404 would contradict FR-005; the tenant resolves from
//     context, never the path);
//   - unauthenticated / no resolved context → 401.
// The DB-layer half of T034 (RLS-bypass + seeded cross-tenant invisibility)
// lives in GROUP A above (§A.1/§A.2/§A.4).
//
// The WRITE-path object-safety (FR-052 mass-assignment: body-supplied
// tenant_id/store_id/created_by/derived balance ignored) is authored in
// 009-US2-MANUAL once createStockMovement exists.
describe.skip("inventory-sweep §B — write-path object-safety (HTTP) [RED until 009-US2-MANUAL]", () => {
  it("body-supplied tenant_id/store_id/created_by/derived balance ignored (FR-052)", () => {
    // Authored in 009-US2-MANUAL once createStockMovement exists.
    expect(true).toBe(true);
  });
});
