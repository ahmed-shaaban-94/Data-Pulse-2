/**
 * T336 — store GUC contract coverage on `store_product_overrides`.
 *
 * Reinterpretation note (resolves finding `MISSING_WITHSTORE_HELPER`)
 * -------------------------------------------------------------------
 * The original T336 brief was "test the existing `withStore(tx, tenantId,
 * storeId)` helper from feature 001 against `store_product_overrides`."
 * That helper file (`packages/db/src/helpers/with-store.ts`) was never
 * scaffolded — only `with-tenant.ts` and `audit-insert.ts` exist under
 * `packages/db/src/helpers/`. Per the slice owner's resolution
 * (path (b) of the `MISSING_WITHSTORE_HELPER` finding), this spec
 * exercises the underlying store-GUC contract directly rather than a
 * non-existent helper surface: `runWithTenantContext` (the production
 * tenant-axis glue, exported from `packages/db/src/middleware/tenant-
 * context.ts`) is composed with a manual `SELECT set_config(
 * 'app.current_store', $1, true)` per transaction. That is precisely
 * the call pattern a `withStore` helper would compile to, so the
 * contract is tested at its operational surface — not at a TS wrapper
 * that may or may not ship later.
 *
 * This mirrors the `T335_TENANT_HELPER_COVERAGE` spec
 * (`with-tenant-catalog.spec.ts`), which faced the same situation on
 * the tenant axis — `withTenant` did not enumerate catalog tables, so
 * T335 tested the contract via `runWithTenantContext` directly. T336
 * is the store-axis counterpart.
 *
 * Contract under test
 * -------------------
 * The final-form (0011) store-axis SELECT policy on
 * `store_product_overrides` is:
 *
 *   USING (
 *     tenant_id = CASE WHEN current_setting('app.current_tenant','') = ''
 *                        THEN NULL
 *                      ELSE current_setting('app.current_tenant','')::uuid
 *                 END
 *     AND CASE
 *       WHEN current_setting('app.current_store','') = '*'  THEN TRUE   -- carve-out
 *       WHEN current_setting('app.current_store','') = ''   THEN FALSE  -- never-set: fail-closed
 *       ELSE store_id = current_setting('app.current_store','')::uuid
 *     END
 *   )
 *
 * Asserted branches (one assertion per branch, plus symmetry + sanity):
 *
 *   A. tenant set + store = own store  → see own-store rows only
 *   B. tenant set + store = sibling store (same tenant) → see sibling rows only
 *   C. tenant set + store = '*' (carve-out) → see ALL of own tenant's rows,
 *      across both own and sibling stores
 *   D. tenant set + store = '' (never-set fail-closed) → see ZERO rows
 *   E. tenant set + store points at another tenant's store id → see ZERO rows
 *      (tenant axis wins even if the store id is valid in a sibling tenant)
 *   F. symmetric mirror of (A) with the second tenant — proves no per-tenant
 *      privilege bleed
 *   G. sanity: a fresh runtime-role pool with NO GUCs set → see ZERO rows
 *      (mirrors the T335 fail-closed sanity test)
 *
 * What this spec does NOT do
 * --------------------------
 *   - Does NOT modify `runWithTenantContext`, the schema, any migration,
 *     or any helper source file.
 *   - Does NOT introduce a `with-store.ts` helper — that surface remains
 *     out of scope and is explicitly the focus of the user-rejected
 *     path (a) for `MISSING_WITHSTORE_HELPER`. Should the helper be
 *     authored later, this spec stays valid: the helper would compile to
 *     the same two `set_config` calls this spec issues manually.
 *
 * Docker-less local runs
 * ----------------------
 * If Testcontainers cannot start and `MIGRATION_TEST_ALLOW_SKIP=1` is
 * exported, the suite warns and skips. Same pattern as
 * `with-tenant-catalog.spec.ts` and the rest of `packages/db/__tests__/`.
 */
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { runWithTenantContext } from "../../src/middleware/tenant-context";

// Stable UUIDv7-shaped literals scoped to this spec (mnemonic prefix t336).
const TENANT_A = "0a000000-0000-7000-8000-00000000a336";
const TENANT_B = "0b000000-0000-7000-8000-00000000b336";

const STORE_A_X = "0a000000-0000-7000-8000-00000000a5a1"; // tenant A, store X
const STORE_A_Y = "0a000000-0000-7000-8000-00000000a5a2"; // tenant A, store Y
const STORE_B_X = "0b000000-0000-7000-8000-00000000b5a1"; // tenant B, store X

const PRODUCT_A = "0a000000-0000-7000-8000-00000000a701";
const PRODUCT_B = "0b000000-0000-7000-8000-00000000b701";

// Override IDs — one per (tenant, store) cell exercised in tests.
const OVERRIDE_A_X = "0a000000-0000-7000-8000-00000000d001";
const OVERRIDE_A_Y = "0a000000-0000-7000-8000-00000000d002";
const OVERRIDE_B_X = "0b000000-0000-7000-8000-00000000d003";

// `created_by` / `updated_by` are NOT NULL UUID columns with no FK to users
// (the SQL just declares them UUID — same pattern T335 uses).
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";
const ACTOR_B = "0b000000-0000-7000-8000-0000000000bc";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    // store_product_overrides lives in 0007; the final-form RLS policy
    // (sentinel '*' carve-out + empty-GUC fail-closed + tenant CASE
    // guard) is composed by 0008/0009/0010/0011 — apply ALL.
    await applyAllUpAndCreateAppRole(env);

    // 1. Two tenants.
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 't336-tenant-a', 'T336 Tenant A'),
         ($2, 't336-tenant-b', 'T336 Tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );

    // 2. Three stores: two in tenant A (so we can prove cross-store hiding
    //    inside a single tenant), one in tenant B (for cross-tenant proof).
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 't336-a-x', 'T336 Tenant A / Store X'),
         ($3, $2, 't336-a-y', 'T336 Tenant A / Store Y'),
         ($4, $5, 't336-b-x', 'T336 Tenant B / Store X')
       ON CONFLICT DO NOTHING`,
      [STORE_A_X, TENANT_A, STORE_A_Y, STORE_B_X, TENANT_B],
    );

    // 3. One tenant_products parent per tenant (FK target for the override).
    await env.admin.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES
         ($1, $2, 'T336 Product A', 'standard', $3, $3),
         ($4, $5, 'T336 Product B', 'standard', $6, $6)
       ON CONFLICT DO NOTHING`,
      [PRODUCT_A, TENANT_A, ACTOR_A, PRODUCT_B, TENANT_B, ACTOR_B],
    );

    // 4. Three overrides:
    //      (A, store X, product A) — own-store target of branches A, C, E
    //      (A, store Y, product A) — sibling-store target of branches B, C
    //      (B, store X, product B) — different-tenant target of branch E
    //    `is_active` is supplied so the `at_least_one_override` CHECK is
    //    satisfied without smuggling in price/tax_category semantics that
    //    aren't part of the T336 contract.
    await env.admin.query(
      `INSERT INTO store_product_overrides
         (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
       VALUES
         ($1, $2, $3, $4, true, $5, $5),
         ($6, $2, $7, $4, true, $5, $5),
         ($8, $9, $10, $11, true, $12, $12)
       ON CONFLICT DO NOTHING`,
      [
        OVERRIDE_A_X, TENANT_A, STORE_A_X, PRODUCT_A, ACTOR_A,
        OVERRIDE_A_Y, STORE_A_Y,
        OVERRIDE_B_X, TENANT_B, STORE_B_X, PRODUCT_B, ACTOR_B,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // Don't interpolate the raw error msg — same logging-hygiene
      // pattern adopted across the catalog wave (CodeRabbit PR #302/#303).
      // eslint-disable-next-line no-console
      console.warn(
        "[with-store-catalog.spec] Docker unavailable — skipping (reason=docker_unavailable)",
      );
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
    console.warn("[with-store-catalog.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Composes `runWithTenantContext` (sets `app.current_tenant` and
 * `app.is_platform_admin`) with a manual `set_config('app.current_store',
 * storeId, true)` on the same transaction-scoped client. This is the
 * canonical "what `withStore` would compile to" call pattern — see the
 * file-header reinterpretation note.
 *
 * `storeId` is passed as a raw string so callers can supply
 * UUID-shaped values, the carve-out sentinel `'*'`, or the empty
 * string `''` (branch D's never-set substitute, useful for asserting
 * the fail-closed branch from inside a tenant-scoped transaction
 * without having to spin up a separate connection).
 */
async function runWithTenantStoreContext<T>(
  pool: Pool,
  ctx: { tenantId: string; isPlatformAdmin: boolean; storeId: string },
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  return runWithTenantContext(
    pool,
    { tenantId: ctx.tenantId, isPlatformAdmin: ctx.isPlatformAdmin },
    async (client) => {
      await client.query(
        "SELECT set_config('app.current_store', $1, true)",
        [ctx.storeId],
      );
      return work(client);
    },
  );
}

describe("store GUC contract — store_product_overrides RLS (T336)", () => {
  // ----- Branch A: tenant set + store = own store -------------------------
  it("(A) tenant A + store X sees only the (A, X) override", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_X },
      async (client) => {
        const r = await client.query<{ id: string; tenant_id: string; store_id: string }>(
          `SELECT id, tenant_id, store_id FROM store_product_overrides
             ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OVERRIDE_A_X);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
    expect(rows[0]?.store_id).toBe(STORE_A_X);
  });

  // ----- Branch B: tenant set + sibling store -----------------------------
  it("(B) tenant A + store Y sees only the (A, Y) override (sibling-store hidden axis)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_Y },
      async (client) => {
        const r = await client.query<{ id: string; store_id: string }>(
          `SELECT id, store_id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OVERRIDE_A_Y);
    expect(rows[0]?.store_id).toBe(STORE_A_Y);
  });

  // ----- Branch C: tenant set + store sentinel '*' (carve-out) -----------
  it("(C) tenant A + store='*' (carve-out) sees BOTH tenant-A overrides", async () => {
    if (maybeSkip()) return;
    const ids = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: "*" },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows.map((row) => row.id);
      },
    );
    expect(ids).toEqual([OVERRIDE_A_X, OVERRIDE_A_Y].sort());
    // Crucially, the carve-out must NOT leak tenant B's row — tenant axis
    // remains AND-gated.
    expect(ids).not.toContain(OVERRIDE_B_X);
  });

  // ----- Branch D: tenant set + store = '' (never-set fail-closed) -------
  it("(D) tenant A + store='' (never-set sentinel) sees ZERO rows (fail-closed)", async () => {
    if (maybeSkip()) return;
    const count = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: "" },
      async (client) => {
        const r = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
        );
        return r.rows[0]?.count;
      },
    );
    expect(count).toBe("0");
  });

  // ----- Branch E: tenant set + cross-tenant store id --------------------
  it("(E) tenant A + store = tenant-B's store id sees ZERO rows (tenant axis wins)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_B_X },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides`,
        );
        return r.rows;
      },
    );
    expect(rows).toEqual([]);
  });

  // ----- Branch F: symmetry with tenant B --------------------------------
  it("(F) tenant B + store X sees only the (B, X) override (symmetry)", async () => {
    if (maybeSkip()) return;
    const rows = await runWithTenantStoreContext(
      env!.app,
      { tenantId: TENANT_B, isPlatformAdmin: false, storeId: STORE_B_X },
      async (client) => {
        const r = await client.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM store_product_overrides ORDER BY id`,
        );
        return r.rows;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(OVERRIDE_B_X);
    expect(rows[0]?.tenant_id).toBe(TENANT_B);
  });
});

// Sanity probe: a fresh runtime-role pool with no GUCs set must see zero
// rows. This proves (i) the seed actually inserted rows under the
// superuser and (ii) the runtime app role does NOT bypass RLS by default —
// guarding against accidentally running the assertions above as superuser
// or inheriting a stale GUC value across pool acquisitions.
//
// Same shape as the matching sanity describe in `with-tenant-catalog.spec.ts`.
describe("store GUC contract — sanity: runtime role without any GUC is fail-closed", () => {
  it("(G) runtime-role connection without tenant OR store GUC sees zero rows", async () => {
    if (maybeSkip()) return;
    const pool = new Pool({
      connectionString: `postgres://app_test:app_test@${env!.host}:${env!.port}/test`,
    });
    try {
      const r = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM store_product_overrides`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
