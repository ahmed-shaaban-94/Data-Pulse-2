/**
 * T335 — `withTenant` helper, catalog coverage.
 *
 * Scope:
 *   Verifies that the tenant-context contract that backs `withTenant`
 *   (from feature 001) — a non-superuser runtime role + `app.current_tenant`
 *   GUC set inside a transaction — correctly isolates `tenant_products` rows
 *   added by the 0007_catalog migration. `withTenant`'s TS surface does not
 *   yet enumerate catalog tables (the helper was authored before 003 shipped
 *   its schema), so the production glue used here is `runWithTenantContext`
 *   from `packages/db/src/middleware/tenant-context.ts` — the same module
 *   that the helper composes with at the application layer. The RLS policy
 *   on `tenant_products` (`tenant_products_tenant_isolation`, FOR SELECT,
 *   USING `tenant_id = current_setting('app.current_tenant')::uuid`) is what
 *   makes this isolation real: it cannot be bypassed by replacing the helper.
 *
 *   This spec does NOT modify `withTenant`, `runWithTenantContext`, the
 *   schema, the migration, or any helper source. It only adds a test file.
 *
 * Design:
 *   - Two tenants are seeded via the admin pool (RLS bypass for superuser).
 *   - Each tenant gets a `tenant_products` row.
 *   - Reads are issued under the runtime-role `app` pool, wrapped in
 *     `runWithTenantContext` so the tenant GUC is set per-transaction.
 *   - Asserts:
 *       (1) tenant A context sees A's row and only A's row.
 *       (2) tenant A context cannot see B's row.
 *       (3) tenant B context sees B's row only — symmetry.
 *
 * Docker-less local runs: if the Testcontainers harness cannot start and
 * `MIGRATION_TEST_ALLOW_SKIP=1` is exported, the suite warns and skips
 * (matches the pattern in `with-tenant.spec.ts`).
 */
import { Pool } from "pg";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { runWithTenantContext } from "../../src/middleware/tenant-context";

const TENANT_A = "0a000000-0000-7000-8000-00000000a335";
const TENANT_B = "0b000000-0000-7000-8000-00000000b335";

const PRODUCT_A = "0a000000-0000-7000-8000-00000000a701";
const PRODUCT_B = "0b000000-0000-7000-8000-00000000b701";

// `created_by` / `updated_by` are NOT NULL but have no FK to any user table
// (the SQL just declares them UUID). Any UUID is acceptable here.
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";
const ACTOR_B = "0b000000-0000-7000-8000-0000000000bc";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    // The catalog tables live in 0007_catalog.sql — apply ALL migrations.
    await applyAllUpAndCreateAppRole(env);

    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 't335-tenant-a', 'T335 Tenant A'),
         ($2, 't335-tenant-b', 'T335 Tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );

    await env.admin.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES
         ($1, $2, 'T335 Product A', 'standard', $3, $3),
         ($4, $5, 'T335 Product B', 'standard', $6, $6)`,
      [PRODUCT_A, TENANT_A, ACTOR_A, PRODUCT_B, TENANT_B, ACTOR_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[with-tenant-catalog.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[with-tenant-catalog.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("withTenant — tenant_products RLS isolation (T335)", () => {
  it("tenant A context sees its own tenant_products row", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string; name: string; tenant_id: string }>(
          `SELECT id, name, tenant_id FROM tenant_products ORDER BY name`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(PRODUCT_A);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
  });

  it("tenant A context cannot see tenant B's tenant_products row", async () => {
    if (maybeSkip()) return;
    // Direct-by-id probe: even with the row's PK known, RLS must hide it.
    const rows = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM tenant_products WHERE id = $1`,
          [PRODUCT_B],
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  it("tenant B context sees its own row only (symmetry)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_B, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM tenant_products ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(PRODUCT_B);
    expect(rows[0]?.tenant_id).toBe(TENANT_B);
  });

  it("count(*) under tenant A context returns 1, not 2 (no leakage)", async () => {
    if (maybeSkip()) return;
    const count = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM tenant_products`,
        );
        return r.rows[0]?.count;
      },
    );
    expect(count).toBe("1");
  });
});

// Sanity probe: a separate runtime-role pool with NO GUC set must see zero
// rows — proves the rows exist for the superuser but are RLS-hidden for the
// runtime role without a tenant GUC. This guards against accidentally
// running the assertions above as superuser.
describe("withTenant — sanity: runtime role without GUC is fail-closed", () => {
  it("runtime-role connection without app.current_tenant sees zero rows", async () => {
    if (maybeSkip()) return;
    const pool = new Pool({
      connectionString: `postgres://app_test:app_test@${env!.host}:${env!.port}/test`,
    });
    try {
      const r = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tenant_products`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
