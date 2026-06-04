/**
 * 013-ISOLATION-HARNESS (T020) — erpnext_item_map RLS isolation sweep.
 *
 * Proves the tenant isolation shipped with migration 0017 (PR #487) holds for
 * the `erpnext_item_map` table. DB/RLS-layer only — mirrors the 003-owned
 * `apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts`: raw `set_config`
 * GUC manipulation inside explicit BEGIN/ROLLBACK transactions on the
 * non-superuser `app_test` pool, so GUC bleed between tests is impossible
 * (LOCAL scope discards on ROLLBACK).
 *
 * These probes characterise ALREADY-SHIPPED behaviour (the 0017 RLS policies),
 * so the suite is GREEN — the same posture as the schema round-trip test that
 * shipped in #487. The operations-level cross-tenant 404 (suggest/confirm/
 * retire addressing a foreign mapping) is exercised in 013-CRUD, where the
 * controller exists and a meaningful NON-DISCLOSING 404 can be asserted; a
 * route-level 404 from a missing controller would test nothing. (Map-text
 * reconciliation: the execution-map's "RED on missing suggest/confirm" is
 * unsound — calling a nonexistent service errors rather than fails, and there
 * is no controller to produce the designed 404 yet. Recorded in wave-status,
 * mirroring the cookieAuth-vs-Clerk-JWT auth-scheme reconciliation.)
 *
 * Coverage
 * --------
 * §A wrong-tenant GUC      → only the GUC tenant's rows are visible
 * §B unset-tenant GUC      → fail-closed (0 rows); INSERT denied
 * §C cross-tenant read     → tenant A cannot SELECT tenant B's mapping (0 rows)
 * §D cross-tenant INSERT   → tenant A cannot write a row tagged tenant B
 * §E active partial-unique → 1:1 holds on the active set (retired excluded)
 * §F cross-store           → VACUOUS: erpnext_item_map has NO store axis
 *                            (OQ-3/OQ-4 no-column) — asserted absent.
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
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";
import {
  ITEM_MAP_FIXTURE_IDS,
  MAP_A_CONFIRMED,
  MAP_B_CONFIRMED,
  seedItemMapFixture,
} from "../__support__/seed-item-map";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = ITEM_MAP_FIXTURE_IDS.tenantB;

// ---- Lifecycle ------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedItemMapFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[item-map-sweep.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[item-map-sweep.spec] skipping — Docker unavailable");
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
// 42501 RLS USING/WITH CHECK failure; 23514 CHECK; 22P02 '' ::uuid cast — all
// legitimate "the write did NOT succeed" outcomes (mirrors rls-bypass-probe).

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

describe("013 §A — erpnext_item_map wrong-tenant GUC", () => {
  it("tenant-B GUC exposes only tenant-B rows", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_B,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM erpnext_item_map ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("tenant-A GUC never surfaces the tenant-B confirmed mapping", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_item_map ORDER BY id`,
      );
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(MAP_A_CONFIRMED);
    expect(ids).not.toContain(MAP_B_CONFIRMED);
  });
});

// ---------------------------------------------------------------------------
// §B — unset-tenant GUC: fail-closed
// ---------------------------------------------------------------------------

describe("013 §B — erpnext_item_map unset-tenant GUC", () => {
  it("unset tenant GUC: SELECT returns 0 rows (empty-GUC CASE guard)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      // No app.current_tenant set → CASE guard yields NULL → tenant_id = NULL
      // is never true → 0 rows. (Must RESET in case a pooled connection leaked
      // a prior GUC — mirrors reference_migration_test_gotchas.)
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erpnext_item_map`,
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
          `INSERT INTO erpnext_item_map
             (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
              suggestion_source, suggested_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'BYPASS', 'suggested', 'manual', $3, 1)`,
          [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §C — cross-tenant read: known foreign id still returns 0 rows
// ---------------------------------------------------------------------------

describe("013 §C — erpnext_item_map cross-tenant read", () => {
  it("tenant A cannot read tenant B's mapping even by known id", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_item_map WHERE id = $1`,
        [MAP_B_CONFIRMED],
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §D — cross-tenant INSERT: tenant A cannot write a row tagged tenant B
// ---------------------------------------------------------------------------

describe("013 §D — erpnext_item_map cross-tenant INSERT", () => {
  it("tenant-A GUC: INSERT tagged tenant B is denied by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      await expectDeniedByPolicyOrCast(
        client.query(
          `INSERT INTO erpnext_item_map
             (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
              suggestion_source, suggested_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'CROSS', 'suggested', 'manual', $3, 1)`,
          // tenant_id = B while GUC = A → WITH CHECK fails (42501)
          [TENANT_B, ITEM_MAP_FIXTURE_IDS.productBConfirmed, ACTOR_A],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §E — 1:1 active partial-unique holds (retired excluded from the active set)
// ---------------------------------------------------------------------------

describe("013 §E — erpnext_item_map active 1:1 partial-unique", () => {
  it("a 2nd ACTIVE mapping for the same product is rejected (23505)", async () => {
    if (maybeSkip()) return;
    // The confirmed mapping on PRODUCT_A_ACTIVE is active; a second active row
    // for the same (tenant, product) must violate UQ_idx_erpnext_item_map_active.
    let caught: PgErr | undefined;
    try {
      await withRawClient(async (client) => {
        await client.query(
          `SELECT set_config('app.current_tenant', $1, true)`,
          [TENANT_A],
        );
        await client.query(
          `INSERT INTO erpnext_item_map
             (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
              suggestion_source, suggested_by, version)
           VALUES (gen_random_uuid(), $1, $2, 'DUP-ACTIVE', 'suggested', 'manual', $3, 1)`,
          [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
        );
      });
    } catch (err) {
      caught = err as PgErr;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("23505"); // unique_violation on the active partial-unique
  });
});

// ---------------------------------------------------------------------------
// §F — cross-store is VACUOUS: erpnext_item_map has no store axis
// ---------------------------------------------------------------------------

describe("013 §F — erpnext_item_map has no store axis (vacuous cross-store)", () => {
  it("the table exposes NO store_id column (tenant-only — OQ-3/OQ-4)", async () => {
    if (maybeSkip()) return;
    const cols = await withRawClient(async (client) => {
      const r = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'erpnext_item_map'`,
      );
      return r.rows.map((x) => x.column_name);
    });
    expect(cols).not.toContain("store_id");
    // Sanity: the tenant axis IS present.
    expect(cols).toContain("tenant_id");
  });
});
