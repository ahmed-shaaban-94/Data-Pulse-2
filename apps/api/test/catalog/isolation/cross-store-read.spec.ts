/**
 * T342 — Catalog cross-store read isolation (same tenant).
 *
 * Purpose
 * -------
 * Proves that a runtime principal scoped to Tenant A / Store X cannot read
 * rows belonging to Tenant A / Store Y from `store_product_overrides` or
 * `unknown_items`. The isolation contract is enforced by the combined SELECT
 * policies introduced in 0008_catalog_store_read_isolation.sql and hardened
 * by the CASE guard in 0009_catalog_store_empty_guc_fix.sql.
 *
 * HTTP layer decision
 * -------------------
 * No catalog HTTP controllers or services exist in `apps/api/src/` as of
 * the T342 slice. Assertions are made directly at the DB / RLS layer via
 * the non-superuser `app_test` role, the same approach used by T341 and
 * T335. When Phase 3 ships catalog services, those paths will be covered
 * by separate service-layer specs.
 *
 * Tables covered
 * --------------
 * - store_product_overrides  (0008/0009 SELECT policy: tenant AND store CASE guard)
 * - unknown_items            (0008/0009 SELECT policy: same CASE guard)
 *
 * Assertion groups
 * ----------------
 * (A) Own-store visibility: Tenant A / Store X sees only Store X rows.
 * (B) Cross-store denial: Tenant A / Store X cannot see Store Y rows (same tenant).
 * (C) Tenant-owner carve-out: Tenant A / store='*' sees ALL Tenant A rows in both
 *     tables. Exercises the 0011 sentinel — `app.current_store = '*'` is the
 *     explicit cross-store carve-out; `''` is now fail-closed (never-set).
 * (D) Fail-closed on unset store GUC: Tenant A principal without `app.current_store`
 *     set sees 0 rows from the store-scoped tables.
 *
 * RLS matrix references
 * ---------------------
 * §4.3  — Same-store override read + tenant-owner carve-out ('*' sentinel, store_product_overrides)
 * §4.4  — Cross-store override read denied
 * §4.6  — Unset GUC fail-closed
 * §7.3  — Same-store read + tenant-owner carve-out ('*' sentinel, unknown_items)
 * §7.4  — Cross-store read denied
 * §7.6  — Unset GUC fail-closed
 */
import { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  CATALOG_FIXTURE_IDS,
  CATALOG_FIXTURE_COUNTS,
} from "../__support__/isolation-harness";

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// ---- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[cross-store-read.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper ----------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[cross-store-read.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Tenant + store context helper -----------------------------------------
//
// `store_product_overrides` and `unknown_items` carry the post-0008/0009 RLS
// SELECT policy that AND-combines `app.current_tenant` with a CASE guard on
// `app.current_store`. A real store UUID must be set for every read; the 0009
// CASE guard protects against the ''::uuid cast error on the carve-out path.
// `runWithTenantContext` sets only `app.current_tenant`, so we wrap it here.
async function runWithTenantStoreContext<T>(
  pool: Pool,
  ctx: { tenantId: string; isPlatformAdmin: boolean; storeId: string },
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    pool,
    { tenantId: ctx.tenantId, isPlatformAdmin: ctx.isPlatformAdmin },
    async (client) => {
      await client.query("SELECT set_config('app.current_store', $1, true)", [
        ctx.storeId,
      ]);
      return work(client);
    },
  );
}

// --------------------------------------------------------------------------
// Group A — Own-store visibility: Tenant A / Store X sees only Store X rows
// --------------------------------------------------------------------------

describe("T342 — cross-store read isolation: own-store visibility (Tenant A / Store X)", () => {
  const ctx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: CATALOG_FIXTURE_IDS.storeAX,
  };

  it("store_product_overrides: Store X principal sees exactly 1 row (own store)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctx,
      async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.store_id).toBe(CATALOG_FIXTURE_IDS.storeAX);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.overrideAX);
  });

  it("unknown_items: Store X principal sees exactly 1 row (own store)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctx,
      async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM unknown_items ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.store_id).toBe(CATALOG_FIXTURE_IDS.storeAX);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.unknownAX);
  });

  it("store_product_overrides: Store X principal sees Store X row by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctx,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAX],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.overrideAX);
  });

  it("unknown_items: Store X principal sees Store X item by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctx,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAX],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.unknownAX);
  });

  // Symmetry: Store Y principal sees only Store Y rows
  it("store_product_overrides: Store Y principal sees exactly 1 row (own store)", async () => {
    if (maybeSkip()) return;
    const storeYCtx = { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAY };
    const rows = await runWithTenantStoreContext(
      env!.app,
      storeYCtx,
      async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.store_id).toBe(CATALOG_FIXTURE_IDS.storeAY);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.overrideAY);
  });

  it("unknown_items: Store Y principal sees exactly 1 row (own store)", async () => {
    if (maybeSkip()) return;
    const storeYCtx = { ...ctx, storeId: CATALOG_FIXTURE_IDS.storeAY };
    const rows = await runWithTenantStoreContext(
      env!.app,
      storeYCtx,
      async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM unknown_items ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.store_id).toBe(CATALOG_FIXTURE_IDS.storeAY);
    expect(rows[0]?.id).toBe(CATALOG_FIXTURE_IDS.unknownAY);
  });
});

// --------------------------------------------------------------------------
// Group B — Cross-store denial: Store X principal cannot read Store Y rows
// --------------------------------------------------------------------------

describe("T342 — cross-store read isolation: cross-store denial (Store X → Store Y, same tenant)", () => {
  const ctxX = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: CATALOG_FIXTURE_IDS.storeAX,
  };
  const ctxY = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: CATALOG_FIXTURE_IDS.storeAY,
  };

  it("store_product_overrides: Store X principal cannot see Store Y row by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxX,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAY],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("unknown_items: Store X principal cannot see Store Y item by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxX,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAY],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("store_product_overrides: Store Y principal cannot see Store X row by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxY,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("unknown_items: Store Y principal cannot see Store X item by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxY,
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("store_product_overrides: Store X principal row count is 1, not 2 (no cross-store bleed)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxX,
      async (client) => {
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
        );
        return r.rows;
      },
    );
    // Only 1 of Tenant A's 2 overrides is visible (Store X only, not both stores)
    expect(rows[0]?.count).toBe("1");
  });

  it("unknown_items: Store X principal row count is 1, not 2 (no cross-store bleed)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      ctxX,
      async (client) => {
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM unknown_items`,
        );
        return r.rows;
      },
    );
    expect(rows[0]?.count).toBe("1");
  });
});

// --------------------------------------------------------------------------
// Group C — Tenant-owner carve-out: app.current_store='*' sees all tenant rows
//
// This group exercises the 0011 sentinel (rls-test-matrix.md §4.3 / §7.3).
// When app.current_store = '*', the CASE branch fires TRUE, making all stores
// of the active tenant visible. Migration 0011 introduced '*' as the explicit
// carve-out sentinel; '' (empty string / never-set) is now fail-closed.
// --------------------------------------------------------------------------

describe("T342 — cross-store read isolation: tenant-owner carve-out (app.current_store = '*')", () => {
  const tenantACtx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
  };

  it("store_product_overrides: '*' carve-out sees both Store X and Store Y rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        // '*' = tenant-owner all-stores carve-out (rls-test-matrix.md §4.3).
        // Migration 0011: '*' is the explicit sentinel; '' is now fail-closed.
        await client.query(`SELECT set_config('app.current_store', '*', true)`);
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows;
      },
    );
    // 2 per tenant (one per store): CATALOG_FIXTURE_COUNTS.store_product_overrides / 2 = 2
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.store_product_overrides / 2);
    const visibleIds = rows.map((r) => r.id);
    expect(visibleIds).toContain(CATALOG_FIXTURE_IDS.overrideAX);
    expect(visibleIds).toContain(CATALOG_FIXTURE_IDS.overrideAY);
    // Tenant B rows must NOT appear
    expect(visibleIds).not.toContain(CATALOG_FIXTURE_IDS.overrideBX);
    expect(visibleIds).not.toContain(CATALOG_FIXTURE_IDS.overrideBY);
  });

  it("unknown_items: '*' carve-out sees both Store X and Store Y items", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        await client.query(`SELECT set_config('app.current_store', '*', true)`);
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM unknown_items ORDER BY id`,
        );
        return r.rows;
      },
    );
    // 2 per tenant (one per store): CATALOG_FIXTURE_COUNTS.unknown_items / 2 = 2
    expect(rows).toHaveLength(CATALOG_FIXTURE_COUNTS.unknown_items / 2);
    const visibleIds = rows.map((r) => r.id);
    expect(visibleIds).toContain(CATALOG_FIXTURE_IDS.unknownAX);
    expect(visibleIds).toContain(CATALOG_FIXTURE_IDS.unknownAY);
    // Tenant B rows must NOT appear
    expect(visibleIds).not.toContain(CATALOG_FIXTURE_IDS.unknownBX);
    expect(visibleIds).not.toContain(CATALOG_FIXTURE_IDS.unknownBY);
  });

  it("store_product_overrides: '*' carve-out sees Store X override by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        await client.query(`SELECT set_config('app.current_store', '*', true)`);
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAX],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });

  it("store_product_overrides: '*' carve-out sees Store Y override by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        await client.query(`SELECT set_config('app.current_store', '*', true)`);
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAY],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });

  it("unknown_items: '*' carve-out sees Store Y item by known ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        await client.query(`SELECT set_config('app.current_store', '*', true)`);
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAY],
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Group D — Fail-closed: Tenant A context without app.current_store sees 0 rows
//
// `runWithTenantContext` sets only `app.current_tenant`; `app.current_store`
// is never set in the session. Migration 0011 changed the store-axis CASE
// guard so that `''` (the value returned by current_setting when the GUC
// was never set) resolves to THEN FALSE — fail-closed.
// Previously (0009/0010) `WHEN '' THEN TRUE` fired here, leaking rows.
// (rls-test-matrix.md §4.6 / §7.6).
// --------------------------------------------------------------------------

describe("T342 — cross-store read isolation: fail-closed when app.current_store unset", () => {
  const tenantACtx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
  };

  it("§4.6 store_product_overrides: Tenant A without store GUC sees 0 rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        // app.current_store is NOT set — current_setting returns '' → THEN FALSE
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides`,
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("§7.6 unknown_items: Tenant A without store GUC sees 0 rows", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        // app.current_store is NOT set — current_setting returns '' → THEN FALSE
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items`,
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("§4.6 store_product_overrides: Tenant A without store GUC cannot read known Store X override ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        // app.current_store is NOT set — policy denies the row
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.overrideAX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("§7.6 unknown_items: Tenant A without store GUC cannot read known Store X item ID", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      tenantACtx,
      async (client) => {
        // app.current_store is NOT set — policy denies the row
        const r = await client.query<{ id: string }>(
          `SELECT id FROM unknown_items WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.unknownAX],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });
});
