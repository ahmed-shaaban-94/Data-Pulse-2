/**
 * Catalog RLS — cross-store read leak (RED proof).
 *
 * Purpose
 * -------
 * Proves, against a real Postgres container running the actual catalog
 * migration, that `store_product_overrides` does NOT enforce cross-store
 * SELECT isolation at the RLS layer when accessed via the runtime
 * (non-superuser) app role. A second `it` block extends the same proof
 * to `unknown_items`, which carries the identical split-permissive
 * SELECT policy pattern.
 *
 * Why this is RED today
 * ---------------------
 * `packages/db/drizzle/0007_catalog.sql:239-248` declares two PERMISSIVE
 * SELECT policies on `store_product_overrides`:
 *
 *   CREATE POLICY store_product_overrides_tenant_isolation
 *     ON store_product_overrides FOR SELECT
 *     USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
 *
 *   CREATE POLICY store_product_overrides_store_read
 *     ON store_product_overrides FOR SELECT
 *     USING (
 *       store_id = current_setting('app.current_store', true)::uuid
 *       OR current_setting('app.current_store', true) = ''
 *     );
 *
 * PostgreSQL combines PERMISSIVE policies for the same command with OR
 * (https://www.postgresql.org/docs/current/sql-createpolicy.html — "Multiple
 * policies may apply to a single command; in this case, ... the policies
 * are combined using OR for permissive policies"). The tenant_isolation
 * policy alone returns TRUE for every row of the active tenant, regardless
 * of `store_id`. The store_read policy is therefore additive only — it
 * cannot remove visibility that tenant_isolation already grants.
 *
 * Net effect: a runtime principal with `app.current_tenant = Tenant A` and
 * `app.current_store = Store X` can SELECT rows belonging to Tenant A /
 * Store Y. That is a cross-store data leak inside a tenant.
 *
 * `unknown_items` (`0007_catalog.sql:444-453`) uses the same shape and
 * exhibits the same leak.
 *
 * Note on writes
 * --------------
 * Only SELECT is affected. The corresponding `_tenant_write` policies are
 * `FOR ALL` with `tenant_id AND store_id` in both USING and WITH CHECK,
 * so cross-store INSERT/UPDATE/DELETE are still denied. This spec does not
 * exercise writes — its scope is the SELECT defect surfaced above.
 *
 * Scope of this spec
 * ------------------
 * RED-only proof. Does NOT modify SQL, schema, helpers, or any production
 * code. The corrective gated SQL migration is a separate slice.
 *
 * Docker requirement
 * ------------------
 * This spec needs a real Postgres container — RLS cannot be exercised
 * against a mock and is bypassed for the superuser. If the Testcontainers
 * harness fails to start AND `MIGRATION_TEST_ALLOW_SKIP=1` is set in the
 * environment, the suite emits a warning and skips. Without that env, a
 * container failure is a hard error. The harness will NOT silently mark
 * the test as passing.
 */
import { Pool } from "pg";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ----- Identifiers -----
// Tenant + stores: one tenant, two stores under it.
const TENANT_A = "0a000000-0000-7000-8000-00000000a336";
const STORE_X = "0a000000-0000-7000-8000-00000000a3a1";
const STORE_Y = "0a000000-0000-7000-8000-00000000a3a2";

// tenant_products row (FK target for store_product_overrides.product_id).
const PRODUCT_A = "0a000000-0000-7000-8000-00000000a3b1";

// store_product_overrides rows — one per store.
const OVERRIDE_X = "0a000000-0000-7000-8000-00000000a3c1";
const OVERRIDE_Y = "0a000000-0000-7000-8000-00000000a3c2";

// unknown_items rows — one per store.
const UNKNOWN_X = "0a000000-0000-7000-8000-00000000a3d1";
const UNKNOWN_Y = "0a000000-0000-7000-8000-00000000a3d2";
// unknown_items requires NOT NULL correlation_id.
const UNKNOWN_X_CORR = "0a000000-0000-7000-8000-00000000a3e1";
const UNKNOWN_Y_CORR = "0a000000-0000-7000-8000-00000000a3e2";

// created_by / updated_by — UUIDs with no FK, any UUID accepted.
const ACTOR = "0a000000-0000-7000-8000-0000000000ac";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Tenant + two stores.
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'rls-rs-a', 'RLS-RS Tenant A')
       ON CONFLICT DO NOTHING`,
      [TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'X', 'Store X'),
         ($3, $2, 'Y', 'Store Y')
       ON CONFLICT DO NOTHING`,
      [STORE_X, TENANT_A, STORE_Y],
    );

    // One tenant product so overrides have a valid product_id FK.
    await env.admin.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'RLS-RS Product', 'standard', $3, $3)`,
      [PRODUCT_A, TENANT_A, ACTOR],
    );

    // Two store_product_overrides — one per store. Use `is_active = true`
    // alone to satisfy `store_product_overrides_at_least_one_override`
    // while keeping price/currency NULL (the paired-currency CHECK is
    // happy when both are null).
    await env.admin.query(
      `INSERT INTO store_product_overrides
         (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
       VALUES
         ($1, $2, $3, $4, true, $5, $5),
         ($6, $2, $7, $4, true, $5, $5)`,
      [OVERRIDE_X, TENANT_A, STORE_X, PRODUCT_A, ACTOR, OVERRIDE_Y, STORE_Y],
    );

    // Two unknown_items in pending state — one per store. Pending status
    // requires all resolved_* fields null per the resolved_fields_consistent
    // CHECK. `correlation_id` is NOT NULL on this table.
    await env.admin.query(
      `INSERT INTO unknown_items
         (id, tenant_id, store_id, identifier_type, value,
          resolution_status, correlation_id)
       VALUES
         ($1, $2, $3, 'barcode', '111-X', 'pending', $4),
         ($5, $2, $6, 'barcode', '222-Y', 'pending', $7)`,
      [UNKNOWN_X, TENANT_A, STORE_X, UNKNOWN_X_CORR, UNKNOWN_Y, STORE_Y, UNKNOWN_Y_CORR],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[catalog-rls-store-read.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/**
 * Open a runtime-role pool, set both tenant + store GUCs inside a single
 * transaction, run `work`, then COMMIT and release. The connection is
 * NOT the superuser — RLS applies. Uses `set_config(..., true)` so the
 * GUC is scoped to the transaction and cannot leak across acquisitions.
 *
 * Defined locally (not via `runWithTenantContext`) because we must set
 * BOTH `app.current_tenant` AND `app.current_store`, and the production
 * middleware only sets the tenant GUC.
 */
async function runAsRuntimePrincipal<T>(
  pool: Pool,
  tenantId: string,
  storeId: string,
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await client.query("SELECT set_config('app.current_store', $1, true)", [storeId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // swallow — the original error is what matters
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[catalog-rls-store-read.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// ===========================================================================
// RED proofs
// ===========================================================================

describe("catalog RLS — store_product_overrides cross-store SELECT leak (RED)", () => {
  it("runtime app role with Tenant A + Store X context must NOT see Store Y override row", async () => {
    if (maybeSkip()) return;

    const appPool = new Pool({
      connectionString: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${env!.host}:${env!.port}/test`,
    });
    let rows: { id: string; store_id: string }[] = [];
    try {
      rows = await runAsRuntimePrincipal(appPool, TENANT_A, STORE_X, async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM store_product_overrides ORDER BY store_id`,
        );
        return r.rows;
      });
    } finally {
      await appPool.end().catch(() => undefined);
    }

    // Diagnostic context — when the test goes RED, the failure message
    // prints what was actually visible so the leak is unmistakable.
    const visibleIds = rows.map((r) => r.id);
    const visibleStores = rows.map((r) => r.store_id);

    // Invariant: under Store X context, the Store Y row must NOT be visible.
    // Today this assertion FAILS because tenant_isolation (PERMISSIVE
    // SELECT, tenant-only) and store_read (PERMISSIVE SELECT, store-or-empty)
    // are OR-combined, so the tenant-only policy makes the Store Y row
    // visible regardless of `app.current_store`.
    expect({
      visibleIds,
      visibleStores,
      sawStoreY: visibleStores.includes(STORE_Y),
    }).toEqual({
      visibleIds: [OVERRIDE_X],
      visibleStores: [STORE_X],
      sawStoreY: false,
    });
  });
});

describe("catalog RLS — unknown_items cross-store SELECT leak (RED)", () => {
  // Same split-permissive SELECT pattern as store_product_overrides
  // (`0007_catalog.sql:444-453`). Included here so the gated SQL hotfix
  // covers both tables in one slice, and so a future regression on either
  // policy is caught immediately.
  it("runtime app role with Tenant A + Store X context must NOT see Store Y unknown_items row", async () => {
    if (maybeSkip()) return;

    const appPool = new Pool({
      connectionString: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${env!.host}:${env!.port}/test`,
    });
    let rows: { id: string; store_id: string }[] = [];
    try {
      rows = await runAsRuntimePrincipal(appPool, TENANT_A, STORE_X, async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM unknown_items ORDER BY store_id`,
        );
        return r.rows;
      });
    } finally {
      await appPool.end().catch(() => undefined);
    }

    const visibleIds = rows.map((r) => r.id);
    const visibleStores = rows.map((r) => r.store_id);

    expect({
      visibleIds,
      visibleStores,
      sawStoreY: visibleStores.includes(STORE_Y),
    }).toEqual({
      visibleIds: [UNKNOWN_X],
      visibleStores: [STORE_X],
      sawStoreY: false,
    });
  });
});
