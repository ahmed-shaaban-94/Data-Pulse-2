/**
 * T343 — RLS bypass probe.
 *
 * Purpose
 * -------
 * Proves that common RLS bypass attempts FAIL against the 0007 + 0008 + 0009
 * migration stack. All probes run against the non-superuser `app_test` role,
 * using raw `SET LOCAL` / `set_config` calls inside explicit transactions so
 * GUC bleed between tests is impossible (LOCAL scope discards on ROLLBACK).
 *
 * Matrix coverage
 * ---------------
 * §1.4 + §1.5  — global_products: unset role → write denied; SELECT always open
 * §2.3 + §2.4  — tenant_products: unset GUC → 0 rows; wrong-tenant GUC → foreign rows only
 * §3.3 + §3.4  — tenant_product_categories: same as above
 * §4.5 + §4.6  — store_product_overrides: wrong-tenant, wrong-store, unset GUC probes
 * §5.3 + §5.4  — product_aliases: unset GUC → 0 rows; wrong-tenant
 * §6.4 + §6.5  — price_history: wrong-tenant, unset GUC, UPDATE/DELETE = 0 rows
 * §7.5 + §7.6  — unknown_items: wrong-tenant, wrong-store, unset store GUC, '' carve-out
 *
 * Intentionally omitted
 * ---------------------
 * - SQL injection via GUC value: not in rls-test-matrix (matrix is silent → omit).
 * - Body-override probes: matrix §2.5/§7.7 are assigned to T344, not T343.
 *
 * Transport
 * ---------
 * No HTTP layer exists in Phase 2. All assertions are DB/RLS layer, consistent
 * with the approach used by T341 (cross-tenant-read.spec.ts).
 *
 * GUC isolation
 * -------------
 * Every probe uses an explicit BEGIN/ROLLBACK wrapper via a dedicated client
 * acquired directly from env.app. `set_config(name, value, true)` is LOCAL
 * (transaction-scoped), so ROLLBACK discards it. This prevents the connection-
 * pooling GUC bleed documented in 0009_catalog_store_empty_guc_fix.sql.
 */
import { Pool, type PoolClient } from "pg";
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
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  PRODUCT_A_ACTIVE,
  PRODUCT_B_ACTIVE,
  CATEGORY_A,
  ACTOR_A,
} from "../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

// A UUID that was never inserted into any fixture table.
const NON_EXISTENT_TENANT = "0f000000-0000-7000-8000-00000000dead";

// ---- Lifecycle -----------------------------------------------------------

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
      console.warn(`\n[rls-bypass-probe.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper --------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[rls-bypass-probe.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Raw probe helper ----------------------------------------------------
//
// Acquires a client from the app (non-superuser) pool, wraps the work in an
// explicit transaction, and rolls back afterwards. This makes set_config LOCAL
// calls safe: the GUC value is discarded on ROLLBACK.

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

// ---------------------------------------------------------------------------
// §1 — global_products (bypass probes)
// ---------------------------------------------------------------------------

describe("T343 §1 — global_products RLS bypass probes", () => {
  // §1.1 — SELECT is open (policy = TRUE) even without tenant GUC
  it("§1.4 unset role GUC: SELECT returns all rows (read policy is TRUE)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      // No GUCs set — SELECT policy is unconditionally TRUE
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM global_products`,
      );
      return r.rows[0]?.count;
    });
    // Fixture seeds 1 global product
    expect(count).toBe("1");
  });

  // §1.5 — Write denied when app.current_role is not 'platform_admin'
  it("§1.5 unset role GUC: INSERT into global_products is denied by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      // No app.current_role set → policy evaluates to '' = 'platform_admin' → FALSE
      await expect(
        client.query(
          `INSERT INTO global_products (id, name, created_by)
           VALUES (gen_random_uuid(), 'BypassAttempt', $1)`,
          [ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  it("§1.5 wrong role GUC: INSERT into global_products is denied when role != platform_admin", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_role', 'tenant_member', true)`,
      );
      await expect(
        client.query(
          `INSERT INTO global_products (id, name, created_by)
           VALUES (gen_random_uuid(), 'BypassAttempt', $1)`,
          [ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant_products bypass probes
// ---------------------------------------------------------------------------

describe("T343 §2 — tenant_products RLS bypass probes", () => {
  // §2.3 — Unset tenant GUC → fail-closed (0 rows)
  it("§2.3 unset tenant GUC: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      // No GUC set at all — current_setting returns '' → ''::uuid raises →
      // but FORCE RLS + policy using `current_setting(..., true)` suppresses
      // missing-GUC error and returns empty string, which casts to NULL → 0 rows
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_products`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("§2.3 unset tenant GUC: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO tenant_products
             (id, tenant_id, name, tax_category, created_by, updated_by)
           VALUES (gen_random_uuid(), $1, 'BypassProduct', 'standard', $2, $2)`,
          [TENANT_A, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  // §2.4 — Wrong-tenant GUC → only that tenant's rows visible (no row leak from prior context)
  it("§2.4 wrong-tenant GUC: setting Tenant B UUID exposes only Tenant B rows", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_products ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("§2.4 non-existent tenant UUID: SELECT returns 0 rows with no error", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [NON_EXISTENT_TENANT],
      );
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenant_products`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it("§2.4 GUC recontextualization: switching from Tenant A to B in a new txn sees no A rows", async () => {
    if (maybeSkip()) return;
    // Txn 1: Tenant A context — sees its own rows
    const rowsA = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      const r = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_products`,
      );
      return r.rows;
    });
    expect(rowsA.every((r) => r.tenant_id === TENANT_A)).toBe(true);

    // Txn 2: Tenant B context — sees only B rows; no A rows leak from txn 1
    const rowsB = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      const r = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_products`,
      );
      return r.rows;
    });
    expect(rowsB.every((r) => r.tenant_id === TENANT_B)).toBe(true);
    const aIdsInB = rowsB.filter((r) => r.tenant_id === TENANT_A);
    expect(aIdsInB).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3 — tenant_product_categories bypass probes
// ---------------------------------------------------------------------------

describe("T343 §3 — tenant_product_categories RLS bypass probes", () => {
  it("§3.3 unset tenant GUC: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_product_categories`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("§3.3 unset tenant GUC: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO tenant_product_categories
             (id, tenant_id, name, created_by)
           VALUES (gen_random_uuid(), $1, 'BypassCat', $2)`,
          [TENANT_A, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  it("§3.4 wrong-tenant GUC: setting Tenant B UUID exposes only Tenant B categories", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM tenant_product_categories`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("§3.4 empty-string tenant GUC: SELECT returns 0 rows (fail-closed)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', '', true)`,
      );
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_product_categories`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// §4 — store_product_overrides bypass probes
// ---------------------------------------------------------------------------

describe("T343 §4 — store_product_overrides RLS bypass probes", () => {
  // §4.5 — wrong-tenant GUC: only that tenant's rows are visible
  it("§4.5 wrong-tenant GUC: switching to Tenant B UUID exposes only Tenant B overrides", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      // Use '' for cross-store (tenant-owner carve-out) to see all stores of B
      await client.query(
        `SELECT set_config('app.current_store', '', true)`,
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM store_product_overrides ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  // §4.5 — wrong-store GUC: only that store's rows visible (within the tenant)
  it("§4.5 wrong-store GUC: Tenant A principal with Store AY sees only AY override", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.current_store', $1, true)`,
        [STORE_A_Y],
      );
      const r = await client.query<{ id: string; store_id: string }>(
        `SELECT id, store_id FROM store_product_overrides ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.store_id).toBe(STORE_A_Y);
    }
  });

  // §4.5 — no tenant GUC + store set: 0 rows (tenant check fails first)
  it("§4.5 no tenant GUC, store set: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_store', $1, true)`,
        [STORE_A_X],
      );
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  // §4.6 — unset store GUC (tenant set): 0 rows — NOT the '' carve-out
  it("§4.6 tenant set, store GUC absent (not '' — missing entirely): SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    // A fresh pool connection with no GUC set at all then only set tenant.
    // current_setting('app.current_store', true) returns NULL (not '') for a
    // GUC that was never configured in this session. CASE: NULL != '' → ELSE
    // branch → store_id = NULL::uuid = NULL → FALSE → 0 rows.
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      // Explicitly do NOT set app.current_store — the GUC remains absent
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  // §4.6 — empty-string store GUC: tenant-owner carve-out → all tenant stores visible
  it("§4.6 tenant set, store GUC = '': carve-out allows all-store read for that tenant", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.current_store', '', true)`,
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM store_product_overrides ORDER BY id`,
      );
      return r.rows;
    });
    // Should see both Store AX and AY overrides (2 total for Tenant A)
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
  });

  // §4.6 — write under unset/wrong store GUC: INSERT rejected
  it("§4.6 write with tenant set but store unset: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      // No store GUC set — WITH CHECK fails (store_id = NULL::uuid)
      await expect(
        client.query(
          `INSERT INTO store_product_overrides
             (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
           VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $4)`,
          [TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  it("§4.6 write with tenant set, store set to wrong store: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      // GUC points to Store AX, but INSERT targets Store AY — WITH CHECK fails
      await client.query(
        `SELECT set_config('app.current_store', $1, true)`,
        [STORE_A_X],
      );
      await expect(
        client.query(
          `INSERT INTO store_product_overrides
             (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
           VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $4)`,
          [TENANT_A, STORE_A_Y, PRODUCT_A_ACTIVE, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// §5 — product_aliases bypass probes
// ---------------------------------------------------------------------------

describe("T343 §5 — product_aliases RLS bypass probes", () => {
  it("§5.3 unset tenant GUC: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM product_aliases`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("§5.3 unset tenant GUC: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO product_aliases
             (id, tenant_id, product_id, identifier_type, value, created_by)
           VALUES (gen_random_uuid(), $1, $2, 'barcode', 'BYPASS-BAR', $3)`,
          [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  it("§5.4 wrong-tenant GUC: setting Tenant B UUID exposes only Tenant B aliases", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM product_aliases ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("§5.4 empty-string tenant GUC: SELECT returns 0 rows (fail-closed)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', '', true)`,
      );
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM product_aliases`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// §6 — price_history bypass probes
// ---------------------------------------------------------------------------

describe("T343 §6 — price_history RLS bypass probes", () => {
  it("§6.4 wrong-tenant GUC: setting Tenant B UUID exposes only Tenant B price history", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM price_history ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("§6.5 unset tenant GUC: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM price_history`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("§6.5 unset tenant GUC: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO price_history
             (id, tenant_id, product_id, price, currency_code,
              effective_from, changed_by, correlation_id)
           VALUES (gen_random_uuid(), $1, $2, 9.99, 'USD', now(), $3, gen_random_uuid())`,
          [TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
        ),
      ).rejects.toThrow();
    });
  });

  // §6.4 — immutability probe: UPDATE returns 0 rows affected (RLS policy = FALSE)
  it("§6.4 immutability: UPDATE with correct tenant GUC affects 0 rows (USING false policy)", async () => {
    if (maybeSkip()) return;
    const result = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      const r = await client.query(
        `UPDATE price_history SET price = 0 WHERE tenant_id = $1`,
        [TENANT_A],
      );
      return r.rowCount;
    });
    expect(result).toBe(0);
  });

  // §6.4 — immutability probe: DELETE returns 0 rows affected
  it("§6.4 immutability: DELETE with correct tenant GUC affects 0 rows (USING false policy)", async () => {
    if (maybeSkip()) return;
    const result = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      const r = await client.query(
        `DELETE FROM price_history WHERE tenant_id = $1`,
        [TENANT_A],
      );
      return r.rowCount;
    });
    expect(result).toBe(0);
  });

  it("§6.4 empty-string tenant GUC: SELECT returns 0 rows (fail-closed)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', '', true)`,
      );
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM price_history`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// §7 — unknown_items bypass probes
// ---------------------------------------------------------------------------

describe("T343 §7 — unknown_items RLS bypass probes", () => {
  // §7.5 — wrong-tenant GUC
  it("§7.5 wrong-tenant GUC: setting Tenant B UUID exposes only Tenant B unknown items", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_B],
      );
      // '' carve-out to see all B stores
      await client.query(
        `SELECT set_config('app.current_store', '', true)`,
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM unknown_items ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  // §7.5 — wrong-store GUC: store isolation holds
  it("§7.5 wrong-store GUC: Tenant A principal with Store BX sees 0 rows of Tenant A", async () => {
    if (maybeSkip()) return;
    // NOTE: Store BX belongs to Tenant B. Setting Tenant A + Store BX:
    // tenant check passes only for Tenant A rows, but store check
    // requires store_id = BX. Tenant A has no items in BX → 0 rows.
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.current_store', $1, true)`,
        [STORE_B_X],
      );
      const r = await client.query<{ id: string }>(
        `SELECT id FROM unknown_items`,
      );
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  // §7.6 — unset store GUC (tenant set) → 0 rows
  it("§7.6 tenant set, store GUC absent: SELECT returns 0 rows (fail-closed)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      // Deliberately do NOT set app.current_store
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM unknown_items`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  // §7.5 — cross-store carve-out ('' store GUC): all tenant items visible
  it("§7.5 store GUC = '': carve-out allows all-store read for that tenant", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.current_store', '', true)`,
      );
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM unknown_items ORDER BY id`,
      );
      return r.rows;
    });
    // Fixture has 2 unknown items for Tenant A (one per store)
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
  });

  // §7.6 — unset tenant GUC → 0 rows
  it("§7.6 unset tenant GUC: SELECT returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM unknown_items`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("§7.6 unset tenant GUC: INSERT is rejected by RLS", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await expect(
        client.query(
          `INSERT INTO unknown_items
             (id, tenant_id, store_id, identifier_type, value,
              resolution_status, correlation_id)
           VALUES (gen_random_uuid(), $1, $2, 'barcode', 'BYPASS-UNK',
                   'pending', gen_random_uuid())`,
          [TENANT_A, STORE_A_X],
        ),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-suite: no-GUC pool (mirrors T341 Group D for completeness)
// ---------------------------------------------------------------------------

describe("T343 — cross-suite: direct runtime-role pool with no GUC is fail-closed", () => {
  /**
   * Validates that a cold connection to the app role (no set_config called)
   * sees zero rows from every tenant-scoped table. This is the no-GUC
   * fail-closed case documented in matrix §2.3/§3.3/§5.3/§6.5/§7.6.
   */
  let noGucPool: Pool | null = null;

  beforeAll(async () => {
    if (dockerSkipped || !env) return;
    const host = env.container.getHost();
    const port = env.container.getMappedPort(5432);
    noGucPool = new Pool({
      connectionString: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`,
    });
  });

  afterAll(async () => {
    await noGucPool?.end().catch(() => undefined);
  });

  it("global_products: no-GUC pool sees all rows (read policy is TRUE)", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM global_products`,
    );
    expect(r.rows[0]?.count).toBe("1");
  });

  it("tenant_products: no-GUC pool sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_products`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("tenant_product_categories: no-GUC pool sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenant_product_categories`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("product_aliases: no-GUC pool sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM product_aliases`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("price_history: no-GUC pool sees 0 rows", async () => {
    if (maybeSkip() || !noGucPool) return;
    const r = await noGucPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM price_history`,
    );
    expect(r.rows[0]?.count).toBe("0");
  });

  it("store_product_overrides: no-GUC pool is fail-closed (0 rows or cast error)", async () => {
    if (maybeSkip() || !noGucPool) return;
    // 0009 CASE guard: absent GUC → current_setting returns '' in pg's
    // `missing_ok` mode, then CASE '' = '' → TRUE → only tenant check applies.
    // But tenant check also has absent GUC → 0 rows. Either 0 rows or error
    // proves no data visible.
    try {
      const r = await noGucPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } catch (err) {
      expect(String(err)).toMatch(/invalid input syntax for type uuid/);
    }
  });

  it("unknown_items: no-GUC pool is fail-closed (0 rows or cast error)", async () => {
    if (maybeSkip() || !noGucPool) return;
    try {
      const r = await noGucPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM unknown_items`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } catch (err) {
      expect(String(err)).toMatch(/invalid input syntax for type uuid/);
    }
  });
});
