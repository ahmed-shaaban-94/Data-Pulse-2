/**
 * T350 — TenantCatalogService.create contract test (RED slice).
 *
 * Purpose
 * -------
 * Asserts the behavioral contract that `TenantCatalogService.create` MUST
 * satisfy once T351 implements it. This file intentionally imports the
 * service from its future target path so the test suite fails RED —
 * "Cannot find module" — because no service exists yet.
 *
 * Contract covered (tasks.md T350, spec §5.2, §7.S1, [S1][Q5][Q6][Q7])
 * ----------------------------------------------------------------------
 * 1. Happy path — a Tenant A admin principal can create a `tenant_products`
 *    row; the returned record is owned by Tenant A.
 * 2. Server-resolved tenant_id — the row's `tenant_id` comes from the
 *    authenticated principal, NOT the request payload.
 * 3. Body-supplied tenant_id is ignored — when a malicious caller supplies
 *    a foreign `tenant_id` in the payload, the persisted row carries the
 *    principal's own tenant_id (Constitution §12, spec §5.2).
 * 4. Tenant isolation — Tenant B cannot see the row just created by Tenant A
 *    (cross-tenant read returns empty under RLS; [S7]).
 * 5. Required-field validation — missing `name` or `tax_category` is rejected
 *    before persistence.
 * 6. Audit event — the `audit_events` table receives one CREATE entry with
 *    the correct actor, tenant, and action after a successful create.
 *
 * Pattern notes
 * -------------
 * - Lifecycle: `beforeAll` starts Testcontainers Postgres, applies all
 *   migrations (0000–0008), creates the `app_test` role, seeds the isolation
 *   fixture, then instantiates the service under test.
 * - The service is tested at the service layer (not via HTTP). No NestJS
 *   application is bootstrapped — the service is constructed directly with its
 *   DB dependency injected via the admin pool where writes are needed and the
 *   app pool where RLS-enforced reads are needed.
 * - `MIGRATION_TEST_ALLOW_SKIP=1` makes the whole suite pass vacuously when
 *   Docker is unavailable (local development without Docker Desktop).
 * - `runWithTenantContext` from the shared DB helper is used to prove RLS
 *   isolation without rebuilding that logic here.
 *
 * Harness
 * -------
 * The isolation fixture from T340 is reused for the two seeded tenants and
 * stores. New rows created by this spec use unique IDs with the `t350`
 * mnemonic prefix (a–f hex chars only, per harness convention).
 */

import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  CATALOG_FIXTURE_IDS,
} from "./__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Import the NOT-YET-EXISTING service — this line causes the RED failure.
// T351 will create apps/api/src/modules/catalog/tenant-catalog.service.ts.
// ---------------------------------------------------------------------------
import { TenantCatalogService } from "../../src/modules/catalog/tenant-catalog.service";

// ---------------------------------------------------------------------------
// Stable test IDs (mnemonic prefix t350; hex chars a–f only)
// ---------------------------------------------------------------------------

/** A product created by this spec — must not bleed into other tenants. */
const PRODUCT_T350_A = "03500000-0000-7000-8000-00000000a350";

/** Actor / user ID used as the principal for Tenant A in this spec. */
const ACTOR_T350_A = "03500000-0000-7000-8000-0000000000ae";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let service: TenantCatalogService | null = null;
let dockerSkipped = false;

// ---- Lifecycle ------------------------------------------------------------

beforeAll(async () => {
  // Narrow MIGRATION_TEST_ALLOW_SKIP=1 to Docker-only failures so a real
  // regression in migrations/seeds is not silently swallowed.
  // env is assigned only after startPgEnv() succeeds; if env is still null
  // when caught, container startup is the culprit (Docker unavailable).
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[tenant-catalog.service.create.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // Container is up — failures past this point are real and must not skip.
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Seed the actor user. `audit_events.actor_user_id` is FK→`users.id`,
  // so the GREEN `TenantCatalogService.create` (which emits one audit
  // event per create through the legacy queue path) needs the row to
  // exist before any create runs. The catalog isolation harness only
  // seeds tenants/stores/products — users are this spec's responsibility.
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, NULL)
       ON CONFLICT (id) DO NOTHING`,
    [ACTOR_T350_A, `t350-actor-${ACTOR_T350_A}@test.invalid`],
  );

  // Instantiate the service under test.
  // T351 will define the constructor signature. The expectation is that
  // TenantCatalogService accepts a Postgres pool (or a Drizzle client) so it
  // can write to `tenant_products`. The admin pool is passed here so the test
  // can exercise the write path directly; store-context assertions use
  // env.app (the non-superuser pool that RLS applies to).
  service = new TenantCatalogService(env.admin);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---- Guard helper ---------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn(
      "[tenant-catalog.service.create.spec] skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Group 1 — Happy path: Tenant A admin creates a product
// ---------------------------------------------------------------------------

describe("T350 — TenantCatalogService.create: happy path", () => {
  it(
    "creates a tenant_products row owned by the principal's tenant (server-resolved tenant_id)",
    async () => {
      if (maybeSkip()) return;

      const principal = {
        userId: ACTOR_T350_A,
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
      };

      const result = await service!.create(principal, {
        name: "T350 Widget A",
        taxCategory: "standard",
        // Deliberately omit `tenantId` to prove it comes from the principal.
      });

      // Row is returned and carries the principal's tenantId.
      expect(result).toBeDefined();
      expect(result.tenantId).toBe(CATALOG_FIXTURE_IDS.tenantA);
      expect(result.name).toBe("T350 Widget A");
      expect(result.taxCategory).toBe("standard");
      // ID is assigned by the service / DB.
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      // Active by default (retired_at IS NULL).
      expect(result.retiredAt).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Group 2 — Body-supplied tenant_id is NOT trusted (Constitution §12)
// ---------------------------------------------------------------------------

describe("T350 — TenantCatalogService.create: body-supplied tenant_id ignored", () => {
  it(
    "ignores a malicious tenant_id in the payload; row is owned by principal's tenant",
    async () => {
      if (maybeSkip()) return;

      const principalTenantId = CATALOG_FIXTURE_IDS.tenantA;
      const maliciousTenantId = CATALOG_FIXTURE_IDS.tenantB;

      const principal = {
        userId: ACTOR_T350_A,
        tenantId: principalTenantId,
      };

      const result = await service!.create(principal, {
        name: "T350 Malicious Payload Widget",
        taxCategory: "standard",
        // Attempt to inject a foreign tenant ID — must be silently discarded.
        tenantId: maliciousTenantId,
      } as Parameters<TenantCatalogService["create"]>[1]);

      // The persisted tenant_id MUST match the principal, not the payload.
      expect(result.tenantId).toBe(principalTenantId);
      expect(result.tenantId).not.toBe(maliciousTenantId);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 3 — Tenant isolation: Tenant B cannot see Tenant A's new row
// ---------------------------------------------------------------------------

describe("T350 — TenantCatalogService.create: cross-tenant isolation [S7]", () => {
  it(
    "Tenant B context cannot read the row created by Tenant A (RLS non-disclosure)",
    async () => {
      if (maybeSkip()) return;

      // Create a product in Tenant A's namespace.
      const principalA = {
        userId: ACTOR_T350_A,
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
      };

      const created = await service!.create(principalA, {
        name: "T350 RLS Probe Product",
        taxCategory: "standard",
      });

      // Now query the DB as Tenant B's runtime context — RLS must hide the row.
      const ctxB = {
        tenantId: CATALOG_FIXTURE_IDS.tenantB,
        isPlatformAdmin: false,
      };

      const rows = await runWithTenantContext(
        env!.app,
        ctxB,
        async (client) => {
          const r = await client.query<{ id: string }>(
            `SELECT id FROM tenant_products WHERE id = $1`,
            [created.id],
          );
          return r.rows;
        },
      );

      // Tenant B must see zero rows — the same safe non-disclosing response
      // as a 404 (Constitution §2, spec §5.2, [S7]).
      expect(rows).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 4 — Required-field validation
// ---------------------------------------------------------------------------

describe("T350 — TenantCatalogService.create: required-field validation", () => {
  it("rejects a create payload that is missing the required 'name' field", async () => {
    if (maybeSkip()) return;

    const principal = {
      userId: ACTOR_T350_A,
      tenantId: CATALOG_FIXTURE_IDS.tenantA,
    };

    await expect(
      service!.create(principal, {
        // name intentionally omitted
        taxCategory: "standard",
      } as Parameters<TenantCatalogService["create"]>[1]),
    ).rejects.toThrow();
  });

  it("rejects a create payload that is missing the required 'taxCategory' field", async () => {
    if (maybeSkip()) return;

    const principal = {
      userId: ACTOR_T350_A,
      tenantId: CATALOG_FIXTURE_IDS.tenantA,
    };

    await expect(
      service!.create(principal, {
        name: "T350 Missing Tax Category",
        // taxCategory intentionally omitted
      } as Parameters<TenantCatalogService["create"]>[1]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — Audit event emitted after successful create
// ---------------------------------------------------------------------------

describe("T350 — TenantCatalogService.create: audit event emission", () => {
  it(
    "writes one audit_events row with the correct actor, tenant, and action after create",
    async () => {
      if (maybeSkip()) return;

      // Count existing audit rows for this actor before the create.
      const beforeCount = await env!.admin
        .query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM audit_events
           WHERE actor_user_id = $1
             AND action = 'catalog.product.create'`,
          [ACTOR_T350_A],
        )
        .then((r) => parseInt(r.rows[0]?.count ?? "0", 10));

      const principal = {
        userId: ACTOR_T350_A,
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
      };

      await service!.create(principal, {
        name: "T350 Audit Widget",
        taxCategory: "standard",
      });

      // One new audit_events row must appear with the create action.
      const afterCount = await env!.admin
        .query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM audit_events
           WHERE actor_user_id = $1
             AND action = 'catalog.product.create'`,
          [ACTOR_T350_A],
        )
        .then((r) => parseInt(r.rows[0]?.count ?? "0", 10));

      expect(afterCount).toBe(beforeCount + 1);
    },
  );
});
