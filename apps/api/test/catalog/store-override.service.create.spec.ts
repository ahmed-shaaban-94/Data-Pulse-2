/**
 * T372 — StoreOverrideService.create — RED suite
 *
 * Purpose
 * -------
 * Failing test suite for `StoreOverrideService.create`. The service
 * module does NOT exist yet; importing it at the top level causes Jest
 * to abort the entire suite with "Cannot find module" — the correct RED
 * signal for a TDD slice.
 *
 * Scenarios covered (from slice brief T372_STORE_OVERRIDE_CREATE_RED):
 *   S1. Happy path — tenant-admin in Tenant A scoped to Store S1 can
 *       INSERT a store_product_override row tied to a tenant_catalog row.
 *   S2. Store isolation — Store AY context cannot read Store AX's override
 *       (RLS store_read policy denies cross-store SELECT).
 *   S3. Tenant isolation — Tenant B context cannot see Tenant A's override
 *       (RLS tenant_isolation policy denies cross-tenant SELECT).
 *   S4. FK validation — creating an override in Tenant A pointing at
 *       Tenant B's product is rejected (RLS hides the product, causing
 *       FK violation or empty result).
 *   S5. Q8 field rejection — body-supplied `name` or `category_id` fields
 *       are rejected with 400 (those fields are not overrideable at the
 *       store level per spec §5.3 Q8).
 *
 * Notes
 * -----
 * - `StoreOverrideService` is imported from its expected (not-yet-existing)
 *   path. Any test runner resolving this file will fail at module load with
 *   "Cannot find module … store-override.service". This is intentional.
 * - The suite uses the T340 isolation harness for fixtures; all IDs are
 *   deterministic UUIDv7-shaped literals.
 * - The harness already seeds overrides for PRODUCT_A_ACTIVE in STORE_A_X
 *   and STORE_A_Y. The happy-path create therefore targets PRODUCT_A_RETIRED
 *   (no existing override) to avoid the partial UQ on
 *   (tenant_id, store_id, product_id) WHERE retired_at IS NULL.
 * - Docker unavailability is handled via MIGRATION_TEST_ALLOW_SKIP=1.
 */

// ---------------------------------------------------------------------------
// RED import — triggers "Cannot find module" until the service is implemented
// ---------------------------------------------------------------------------
import { StoreOverrideService } from "../../src/modules/catalog/store-override.service";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
} from "../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  PRODUCT_A_RETIRED,
  PRODUCT_B_ACTIVE,
  ACTOR_A,
} from "./__support__/isolation-harness";

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Module-level env state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let appPool: Pool | null = null;
let dockerSkipped = false;

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);

    // Build a connection pool that authenticates as the runtime app role
    // (RLS is enforced for this role — not bypassed like env.admin).
    appPool = new Pool({
      host: env.host,
      port: env.port,
      database: env.database,
      user: APP_ROLE_NAME,
      password: APP_ROLE_PASSWORD,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      console.warn(
        `\n[store-override.service.create.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (appPool) await appPool.end();
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// Helper — skip gate
// ---------------------------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    console.warn(
      "[store-override.service.create.spec] Skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper — run work under tenant + store GUC context via app role
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper — minimal DTO factory for store override creation
// ---------------------------------------------------------------------------

interface CreateStoreOverrideDto {
  tenantId: string;
  storeId: string;
  productId: string;
  actorId: string;
  /** At least one of price, isActive, taxCategory must be present (CHECK) */
  isActive?: boolean;
  price?: string;
  taxCategory?: string;
  /** Q8 forbidden fields — service must reject these with 400 */
  name?: string;
  categoryId?: string;
}

// ---------------------------------------------------------------------------
// S1 — Happy path: tenant-admin in Tenant A, Store AX can create an override
// ---------------------------------------------------------------------------

describe("S1 — happy path: create store_product_override", () => {
  it("inserts an override row for (tenantA, storeAX, productARetired) and returns it", async () => {
    if (maybeSkip()) return;

    const service = new StoreOverrideService(appPool!);

    const dto: CreateStoreOverrideDto = {
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_RETIRED,
      actorId: ACTOR_A,
      isActive: true,
    };

    const result = await runWithTenantStoreContext(
      appPool!,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_X },
      (_client) => service.create(dto),
    );

    expect(result).toBeDefined();
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.storeId).toBe(STORE_A_X);
    expect(result.productId).toBe(PRODUCT_A_RETIRED);
    expect(result.isActive).toBe(true);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — Store isolation: Store AY context cannot read Store AX's override
// ---------------------------------------------------------------------------

describe("S2 — store isolation: cross-store read denied", () => {
  it("returns empty result when querying Store AX's override under Store AY GUC", async () => {
    if (maybeSkip()) return;

    // Query the override that was seeded for STORE_A_X via Store AY context.
    // The RLS store_read policy only exposes rows where
    //   store_id = current_setting('app.current_store')
    // or app.current_store = '*' (platform-admin wildcard).
    // STORE_A_Y context must NOT see STORE_A_X overrides.

    const rows = await runWithTenantStoreContext(
      appPool!,
      { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_Y },
      async (client) => {
        const res = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides
           WHERE tenant_id = $1 AND store_id = $2`,
          [TENANT_A, STORE_A_X],
        );
        return res.rows;
      },
    );

    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S3 — Tenant isolation: Tenant B context cannot see Tenant A's override
// ---------------------------------------------------------------------------

describe("S3 — tenant isolation: cross-tenant read denied", () => {
  it("returns empty result when Tenant B queries Tenant A override", async () => {
    if (maybeSkip()) return;

    // Under Tenant B's GUC the tenant_isolation RLS policy restricts
    // SELECT to rows where tenant_id = current_setting('app.current_tenant').
    // Tenant B must not see any of Tenant A's overrides.

    const rows = await runWithTenantStoreContext(
      appPool!,
      { tenantId: TENANT_B, isPlatformAdmin: false, storeId: STORE_A_X },
      async (client) => {
        const res = await client.query<{ id: string }>(
          `SELECT id FROM store_product_overrides WHERE tenant_id = $1`,
          [TENANT_A],
        );
        return res.rows;
      },
    );

    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S4 — FK validation: cross-tenant product reference is rejected
// ---------------------------------------------------------------------------

describe("S4 — FK validation: cross-tenant product_id reference rejected", () => {
  it("rejects an override in Tenant A that references Tenant B's product", async () => {
    if (maybeSkip()) return;

    // Under Tenant A's GUC, PRODUCT_B_ACTIVE is invisible to RLS. An
    // INSERT referencing it will fail with a FK violation (the referenced
    // row does not exist from the role's perspective) or a policy-violation
    // error. We do not pin the error code; the call must simply reject.

    const service = new StoreOverrideService(appPool!);

    const dto: CreateStoreOverrideDto = {
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_B_ACTIVE, // belongs to Tenant B
      actorId: ACTOR_A,
      isActive: true,
    };

    await expect(
      runWithTenantStoreContext(
        appPool!,
        { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_X },
        (_client) => service.create(dto),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// S5 — Q8 field rejection: name / category_id in body → 400
// ---------------------------------------------------------------------------

describe("S5 — Q8 field rejection: non-overrideable fields rejected", () => {
  it("rejects a DTO containing 'name' with a validation error (400)", async () => {
    if (maybeSkip()) return;

    // Per spec §5.3 Q8, only price, is_active, and tax_category are
    // overrideable at the store level. `name` and `category_id` are
    // tenant-catalog concerns and must be rejected by the service before
    // any DB call is made. The service should throw with a status of 400
    // or equivalent validation error.

    const service = new StoreOverrideService(appPool!);

    const dtoWithName: CreateStoreOverrideDto = {
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_RETIRED,
      actorId: ACTOR_A,
      isActive: true,
      name: "Forbidden name override", // Q8 violation
    };

    await expect(
      runWithTenantStoreContext(
        appPool!,
        { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_X },
        (_client) => service.create(dtoWithName),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a DTO containing 'categoryId' with a validation error (400)", async () => {
    if (maybeSkip()) return;

    const service = new StoreOverrideService(appPool!);

    const dtoWithCategory: CreateStoreOverrideDto = {
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_RETIRED,
      actorId: ACTOR_A,
      isActive: true,
      categoryId: STORE_A_X, // Q8 violation — any UUID will do
    };

    await expect(
      runWithTenantStoreContext(
        appPool!,
        { tenantId: TENANT_A, isPlatformAdmin: false, storeId: STORE_A_X },
        (_client) => service.create(dtoWithCategory),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
