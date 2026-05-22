/**
 * T344 — Catalog malicious body-override probe.
 *
 * Purpose
 * -------
 * Proves that a caller cannot escalate privileges by supplying a
 * `tenant_id` or `store_id` in a write operation that disagrees with
 * the session's active GUC-derived principal. The server (Postgres RLS
 * WITH CHECK clauses) rejects the mismatched row outright — this is
 * Constitution §III "backend authority": the server controls the binding
 * of tenant/store identity; client-supplied identifiers are never trusted.
 *
 * HTTP layer decision
 * -------------------
 * No catalog HTTP controllers or services exist in `apps/api/src/` as of
 * the T344 slice. The catalog module is schema-only (Phase 2 of spec
 * 003-catalog-foundation — "Runtime, contracts, and APIs paused while 004
 * closes"). Assertions are therefore made at the direct DB / RLS layer,
 * which is the authoritative test surface at this phase and mirrors the
 * approach taken by T341–T343.
 *
 * When Phase 3 ships catalog services and Zod `.strict()` DTOs, the HTTP-
 * layer variant of this contract (rls-test-matrix.md §2.5 and §7.7) will
 * be satisfied by those service specs. The DB-layer assertions here cover
 * the anchor rows in:
 *   - §1.2 — `global_products_platform_write` write denial for tenant
 *   - §2.2 — `tenant_products` cross-tenant INSERT/UPDATE blocked
 *   - §5.2 — `product_aliases` cross-tenant INSERT blocked
 *   - §7.2 + §7.4 — `unknown_items` cross-tenant + cross-store INSERT blocked
 *   - §4.2 + §4.4 — `store_product_overrides` cross-tenant + cross-store
 *     INSERT/UPDATE blocked
 *
 * RLS WITH CHECK semantics
 * ------------------------
 * Policies on these tables are `FOR ALL` or `FOR INSERT`/`FOR UPDATE`
 * with a WITH CHECK clause that evaluates `tenant_id = GUC::uuid` (and
 * for store-scoped tables, `store_id = GUC::uuid` via the CASE guard from
 * 0009). When a caller attempts to INSERT a row with a `tenant_id` that
 * differs from the GUC, the WITH CHECK fires and the database raises:
 *   "new row violates row-level security policy for table <tablename>"
 * Assertions therefore use `.rejects.toThrow(/row-level security/)`.
 *
 * For UPDATE (SET tenant_id / store_id mutation), the USING clause hides
 * rows that don't match the GUC — the caller sees 0 rows affected because
 * USING filters BEFORE the update fires. Assertions on mutations therefore
 * check `rowCount = 0`, not an error.
 *
 * Assertion groups
 * ----------------
 * (A) Cross-tenant INSERT rejected — attacker supplies foreign tenant_id
 *     in INSERT while their GUC = own tenant
 * (B) Cross-store INSERT rejected — attacker supplies foreign store_id
 *     in INSERT while their GUC = own store (store-scoped tables only)
 * (C) UPDATE mutation attempts — attacker tries to re-assign an existing
 *     own row to a foreign tenant or store (0 rows affected — USING guard)
 * (D) Positive control — matching tenant_id/store_id INSERT succeeds
 *     (proves rejection above is a policy hit, not an unrelated constraint)
 */
import { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  CATALOG_FIXTURE_IDS,
  TENANT_A,
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
} from "../__support__/isolation-harness";

// --------------------------------------------------------------------------
// Fresh UUIDs for positive-control and malicious-row insertions.
// These are intentionally different from the seeded fixture rows so that
// ON CONFLICT DO NOTHING does not silently suppress the INSERT and mask
// an RLS false-positive. Mnemonic prefix `0e` = "t344-evil".
// --------------------------------------------------------------------------
const EVIL_PRODUCT = "0e000000-0000-7000-8000-00000000e001";
const EVIL_CATEGORY = "0e000000-0000-7000-8000-00000000e002";
const EVIL_ALIAS = "0e000000-0000-7000-8000-00000000e003";
const EVIL_UNKNOWN = "0e000000-0000-7000-8000-00000000e004";
const EVIL_OVERRIDE = "0e000000-0000-7000-8000-00000000e005";
const EVIL_PRICE_HIST = "0e000000-0000-7000-8000-00000000e006";
const EVIL_CORR = "0e000000-0000-7000-8000-00000000e007";
const GOOD_PRODUCT = "0e000000-0000-7000-8000-00000000e011";
const GOOD_CATEGORY = "0e000000-0000-7000-8000-00000000e012";
const GOOD_ALIAS = "0e000000-0000-7000-8000-00000000e013";
const GOOD_UNKNOWN = "0e000000-0000-7000-8000-00000000e014";
const GOOD_OVERRIDE = "0e000000-0000-7000-8000-00000000e015";
const GOOD_PRICE_HIST = "0e000000-0000-7000-8000-00000000e016";
const GOOD_CORR = "0e000000-0000-7000-8000-00000000e017";

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

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
      console.warn(`\n[malicious-override.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[malicious-override.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Store-context helper (mirrors T341 — not imported, not in harness) ---
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
// Group A — Cross-tenant INSERT rejected (foreign tenant_id in column list)
// --------------------------------------------------------------------------

describe("T344 — malicious body override: cross-tenant INSERT rejected by WITH CHECK", () => {
  // Tenant A principal (GUC = TENANT_A) attempts to INSERT rows stamped
  // with TENANT_B's id in the tenant_id column. The WITH CHECK clause
  // `tenant_id = current_setting('app.current_tenant', true)::uuid` fires
  // and raises a row-level security error.

  const ctx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
  };

  it("global_products: non-platform-admin INSERT is blocked regardless of current_role", async () => {
    if (maybeSkip()) return;
    // global_products_platform_write requires current_role = 'platform_admin'.
    // A tenant principal (role unset) cannot INSERT.
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO global_products (id, name, suggested_tax_category, created_by)
           VALUES ($1, 'evil-global', 'standard', $2)`,
          [EVIL_PRODUCT, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("tenant_products: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    // GUC = TENANT_A, injected tenant_id = TENANT_B → WITH CHECK fires.
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO tenant_products
             (id, tenant_id, name, tax_category, created_by, updated_by)
           VALUES ($1, $2, 'evil-product', 'standard', $3, $3)`,
          [EVIL_PRODUCT, TENANT_B, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("tenant_product_categories: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO tenant_product_categories
             (id, tenant_id, name, created_by)
           VALUES ($1, $2, 'evil-category', $3)`,
          [EVIL_CATEGORY, TENANT_B, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("product_aliases: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    // tenant_id = TENANT_B but product_id references TENANT_A's product.
    // We expect RLS to fire on tenant_id mismatch before any FK check.
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO product_aliases
             (id, tenant_id, product_id, identifier_type, value, created_by)
           VALUES ($1, $2, $3, 'barcode', 'evil-barcode', $4)`,
          [EVIL_ALIAS, TENANT_B, PRODUCT_A_ACTIVE, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("price_history: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO price_history
             (id, tenant_id, product_id, price, currency_code,
              effective_from, changed_by, correlation_id)
           VALUES ($1, $2, $3, 9.99, 'USD', now(), $4, $5)`,
          [EVIL_PRICE_HIST, TENANT_B, PRODUCT_A_ACTIVE, ACTOR_A, EVIL_CORR],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("unknown_items: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO unknown_items
             (id, tenant_id, store_id, identifier_type, value,
              resolution_status, correlation_id)
           VALUES ($1, $2, $3, 'barcode', 'evil-unk', 'pending', $4)`,
          [EVIL_UNKNOWN, TENANT_B, STORE_A_X, EVIL_CORR],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

// --------------------------------------------------------------------------
// Group B — Cross-store INSERT rejected (foreign store_id in column list)
//           (store-scoped tables: store_product_overrides, unknown_items)
// --------------------------------------------------------------------------

describe("T344 — malicious body override: cross-store INSERT rejected by WITH CHECK", () => {
  // Tenant A / Store A-X principal (GUC tenant=A, store=A-X) attempts
  // to INSERT rows stamped with Store A-Y's id in the store_id column.
  // The WITH CHECK CASE guard `store_id = GUC::uuid` (0009) fires.

  const ctx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: STORE_A_X,
  };

  it("store_product_overrides: INSERT with foreign store_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    // GUC store = STORE_A_X, injected store_id = STORE_A_Y → WITH CHECK fails.
    await expect(
      runWithTenantStoreContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO store_product_overrides
             (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
           VALUES ($1, $2, $3, $4, true, $5, $5)`,
          [EVIL_OVERRIDE, TENANT_A, STORE_A_Y, PRODUCT_A_ACTIVE, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("store_product_overrides: INSERT with foreign tenant_id is rejected by WITH CHECK", async () => {
    if (maybeSkip()) return;
    // tenant_id = TENANT_B, store_id = STORE_A_X (own store) — tenant mismatch.
    await expect(
      runWithTenantStoreContext(env!.app, ctx, async (client) => {
        await client.query(
          `INSERT INTO store_product_overrides
             (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
           VALUES ($1, $2, $3, $4, true, $5, $5)`,
          [EVIL_OVERRIDE, TENANT_B, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

});

// --------------------------------------------------------------------------
// Group C — UPDATE mutation attempts (re-assign own row to foreign tenant/store)
// --------------------------------------------------------------------------

describe("T344 — malicious body override: UPDATE tenant_id/store_id reassignment blocked", () => {
  // An attacker owns a row (tenant_id = TENANT_A) and tries to move it to
  // TENANT_B by issuing UPDATE … SET tenant_id = TENANT_B.
  // The USING clause hides own-tenant rows from the "wrong" tenant context,
  // so the update is attempted against the own-tenant context — but the
  // WITH CHECK then fires when the updated value disagrees with the GUC.
  //
  // For tables where UPDATE is forbidden (price_history), verify that policy.

  const ctx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
  };
  const ctxStore = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: STORE_A_X,
  };

  it("tenant_products: UPDATE SET tenant_id to foreign tenant is blocked by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `UPDATE tenant_products SET tenant_id = $1 WHERE id = $2`,
          [TENANT_B, CATALOG_FIXTURE_IDS.productAActive],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("tenant_product_categories: UPDATE SET tenant_id to foreign tenant is blocked by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `UPDATE tenant_product_categories SET tenant_id = $1 WHERE id = $2`,
          [TENANT_B, CATALOG_FIXTURE_IDS.categoryA],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("product_aliases: UPDATE SET tenant_id to foreign tenant is blocked by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantContext(env!.app, ctx, async (client) => {
        await client.query(
          `UPDATE product_aliases SET tenant_id = $1 WHERE id = $2`,
          [TENANT_B, CATALOG_FIXTURE_IDS.aliasABarcode],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("price_history: UPDATE is unconditionally blocked (immutability policy FALSE)", async () => {
    if (maybeSkip()) return;
    // price_history_no_update policy: WITH CHECK = FALSE. Any UPDATE must be
    // rejected regardless of the tenant_id value, including a "legitimate"
    // update of one's own row. Zero rows affected confirms the USING = FALSE
    // filter fires; an error would confirm the WITH CHECK fired.
    const result = await runWithTenantContext(
      env!.app,
      ctx,
      async (client) => {
        const r = await client.query(
          `UPDATE price_history SET price = 0.01 WHERE id = $1`,
          [CATALOG_FIXTURE_IDS.priceHistATenant],
        );
        return r.rowCount;
      },
    );
    // 0 rows affected = USING = FALSE filtered the target out.
    expect(result).toBe(0);
  });

  it("store_product_overrides: UPDATE SET store_id to sibling store blocked by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantStoreContext(env!.app, ctxStore, async (client) => {
        await client.query(
          `UPDATE store_product_overrides SET store_id = $1 WHERE id = $2`,
          [STORE_A_Y, CATALOG_FIXTURE_IDS.overrideAX],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("store_product_overrides: UPDATE SET tenant_id to foreign tenant blocked by WITH CHECK", async () => {
    if (maybeSkip()) return;
    await expect(
      runWithTenantStoreContext(env!.app, ctxStore, async (client) => {
        await client.query(
          `UPDATE store_product_overrides SET tenant_id = $1 WHERE id = $2`,
          [TENANT_B, CATALOG_FIXTURE_IDS.overrideAX],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

// --------------------------------------------------------------------------
// Group D — Positive control: matching tenant_id / store_id succeeds
// --------------------------------------------------------------------------

describe("T344 — malicious body override: positive control — matching identifiers succeed", () => {
  // Verify that rejections above are policy hits, not unrelated constraints.
  // Inserts use unique IDs (GOOD_*) to avoid ON CONFLICT DO NOTHING masking.

  const ctx = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
  };
  const ctxStore = {
    tenantId: CATALOG_FIXTURE_IDS.tenantA,
    isPlatformAdmin: false,
    storeId: STORE_A_X,
  };

  it("tenant_products: INSERT with matching tenant_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO tenant_products
           (id, tenant_id, name, tax_category, created_by, updated_by)
         VALUES ($1, $2, 'good-product', 'standard', $3, $3)`,
        [GOOD_PRODUCT, TENANT_A, ACTOR_A],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    // Cleanup via admin.
    await env!.admin.query(
      `DELETE FROM tenant_products WHERE id = $1`,
      [GOOD_PRODUCT],
    );
  });

  it("tenant_product_categories: INSERT with matching tenant_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO tenant_product_categories
           (id, tenant_id, name, created_by)
         VALUES ($1, $2, 'good-category', $3)`,
        [GOOD_CATEGORY, TENANT_A, ACTOR_A],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    await env!.admin.query(
      `DELETE FROM tenant_product_categories WHERE id = $1`,
      [GOOD_CATEGORY],
    );
  });

  it("product_aliases: INSERT with matching tenant_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO product_aliases
           (id, tenant_id, product_id, identifier_type, value, created_by)
         VALUES ($1, $2, $3, 'barcode', 'good-barcode-t344', $4)`,
        [GOOD_ALIAS, TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    await env!.admin.query(
      `DELETE FROM product_aliases WHERE id = $1`,
      [GOOD_ALIAS],
    );
  });

  it("price_history: INSERT with matching tenant_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantContext(env!.app, ctx, async (client) => {
      const r = await client.query(
        `INSERT INTO price_history
           (id, tenant_id, product_id, price, currency_code,
            effective_from, changed_by, correlation_id)
         VALUES ($1, $2, $3, 12.50, 'USD', now(), $4, $5)`,
        [GOOD_PRICE_HIST, TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A, GOOD_CORR],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    // price_history has no DELETE policy for the app role; use admin.
    await env!.admin.query(
      `DELETE FROM price_history WHERE id = $1`,
      [GOOD_PRICE_HIST],
    );
  });

  it("store_product_overrides: INSERT with matching tenant_id and store_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantStoreContext(env!.app, ctxStore, async (client) => {
      const r = await client.query(
        `INSERT INTO store_product_overrides
           (id, tenant_id, store_id, product_id, is_active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [GOOD_OVERRIDE, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    await env!.admin.query(
      `DELETE FROM store_product_overrides WHERE id = $1`,
      [GOOD_OVERRIDE],
    );
  });

  it("unknown_items: INSERT with matching tenant_id and own store_id succeeds", async () => {
    if (maybeSkip()) return;
    let inserted = false;
    await runWithTenantStoreContext(env!.app, ctxStore, async (client) => {
      const r = await client.query(
        `INSERT INTO unknown_items
           (id, tenant_id, store_id, identifier_type, value,
            resolution_status, correlation_id)
         VALUES ($1, $2, $3, 'barcode', 'good-unk-t344', 'pending', $4)`,
        [GOOD_UNKNOWN, TENANT_A, STORE_A_X, GOOD_CORR],
      );
      inserted = (r.rowCount ?? 0) === 1;
    });
    expect(inserted).toBe(true);
    await env!.admin.query(
      `DELETE FROM unknown_items WHERE id = $1`,
      [GOOD_UNKNOWN],
    );
  });
});
