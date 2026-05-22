/**
 * T340 — Catalog isolation test harness.
 *
 * Purpose
 * -------
 * Seeds a representative catalog fixture for the cross-tenant /
 * cross-store / RLS-bypass / malicious-body-override isolation sweeps
 * (T341–T344). The fixture shape is "two tenants × two stores per
 * tenant × representative rows across all seven catalog tables" per
 * specs/003-catalog-foundation/tasks.md §5.5 and rls-test-matrix.md
 * §2–§7. Consumers receive a typed `CatalogFixtureIds` record so they
 * can write assertions like:
 *
 *   expect(visibleIds).not.toContain(ids.storeBY_override);
 *
 * Design
 * ------
 * This is a **support module**, not a spec. It is imported by T341–T344
 * specs after they have:
 *   1. Started a Testcontainers Postgres via
 *      `apps/api/test/_helpers/postgres-container.ts` :: startPgEnv
 *   2. Applied the full migration chain (0000 → 0008) via
 *      `applyAllUpAndCreateAppRole`, which also creates the runtime
 *      `app_test` role.
 * The harness then runs INSERT statements via `env.admin` (RLS bypass
 * for superuser); the runtime-role assertions live in consumer specs.
 *
 * The harness does NOT:
 *   - start/stop the container (consumer's `beforeAll`/`afterAll`)
 *   - apply migrations (consumer calls `applyAllUpAndCreateAppRole`)
 *   - exercise RLS itself (consumer specs do that against `env.app`)
 *   - implement any service or controller (that's later phases)
 *
 * Discovery
 * ---------
 * Jest's `testMatch` is `**\/test/**\/*.spec.ts`. This file is `.ts`
 * (not `.spec.ts`), so it is NOT discovered as a test. It is imported
 * by the consumer specs that ARE discovered. This matches the existing
 * pattern at `apps/api/test/_helpers/postgres-container.ts`. The slice's
 * validation command (`pnpm --filter @data-pulse-2/api test
 * "test/catalog/__support__"`) passes vacuously because the api `test`
 * script includes `--passWithNoTests` — by design.
 */
import type { Pool } from "pg";

// ----------------------------------------------------------------------------
// PgTestEnv reflection (avoids importing the helper's full type surface)
// ----------------------------------------------------------------------------

/**
 * Minimal surface this harness needs from `PgTestEnv`. The consumer
 * passes its own `PgTestEnv` (from `apps/api/test/_helpers/postgres-
 * container.ts`); we only read `admin` (the RLS-bypassing superuser
 * pool used for setup). Keeping the contract narrow lets the harness
 * be reused unchanged if the container helper grows new fields.
 */
export interface SeedableEnv {
  readonly admin: Pool;
}

// ----------------------------------------------------------------------------
// Fixture IDs — exported so consumer specs can destructure
// ----------------------------------------------------------------------------

// UUIDv7-shaped literals; the `t340` mnemonic prefix keeps these IDs
// unique across the test corpus. (memory: feedback_uuid_hex_literals —
// mnemonic prefixes restricted to a-f.)
//
// Tenants
export const TENANT_A = "0a000000-0000-7000-8000-00000000ada1";
export const TENANT_B = "0b000000-0000-7000-8000-00000000bdb1";

// Stores — two per tenant
export const STORE_A_X = "0a000000-0000-7000-8000-00000000a5a1";
export const STORE_A_Y = "0a000000-0000-7000-8000-00000000a5a2";
export const STORE_B_X = "0b000000-0000-7000-8000-00000000b5b1";
export const STORE_B_Y = "0b000000-0000-7000-8000-00000000b5b2";

// Categories — one per tenant
export const CATEGORY_A = "0a000000-0000-7000-8000-0000000ca301";
export const CATEGORY_B = "0b000000-0000-7000-8000-0000000ca302";

// Tenant products — two per tenant (one active, one retired)
export const PRODUCT_A_ACTIVE = "0a000000-0000-7000-8000-00000000a401";
export const PRODUCT_A_RETIRED = "0a000000-0000-7000-8000-00000000a402";
export const PRODUCT_B_ACTIVE = "0b000000-0000-7000-8000-00000000b401";
export const PRODUCT_B_RETIRED = "0b000000-0000-7000-8000-00000000b402";

// Global product — one platform-wide row (no tenant_id). Provides the
// raw-SQL probe surface for T343's `global_products_read` policy and
// the source-of-provenance for tenant_products.source_global_product_id.
export const GLOBAL_PRODUCT = "0c000000-0000-7000-8000-00000000c001";

// Store product overrides — one per store, attached to that tenant's
// active product. Four overrides total. These are the focus of
// T342 (cross-store read denial) and the RLS fix shipped in PR #254.
export const OVERRIDE_A_X = "0a000000-0000-7000-8000-00000000a5d1";
export const OVERRIDE_A_Y = "0a000000-0000-7000-8000-00000000a5d2";
export const OVERRIDE_B_X = "0b000000-0000-7000-8000-00000000b5d1";
export const OVERRIDE_B_Y = "0b000000-0000-7000-8000-00000000b5d2";

// Product aliases — one tenant-wide barcode per tenant, plus one
// store-scoped external_pos_id per store. Covers tenant-only RLS plus
// the store-scoped uniqueness path for §5 of the matrix.
export const ALIAS_A_BARCODE = "0a000000-0000-7000-8000-00000000aa11";
export const ALIAS_A_X_POS = "0a000000-0000-7000-8000-00000000aa12";
export const ALIAS_B_BARCODE = "0b000000-0000-7000-8000-00000000ba11";
export const ALIAS_B_X_POS = "0b000000-0000-7000-8000-00000000ba12";

// Price history — one tenant-level baseline per active product, plus
// one store-scoped row per active product per store. Covers §6
// immutability path indirectly (the policy denies all UPDATE/DELETE,
// which a consumer spec can probe).
export const PRICE_HIST_A_TENANT = "0a000000-0000-7000-8000-00000000a601";
export const PRICE_HIST_A_STORE_X = "0a000000-0000-7000-8000-00000000a602";
export const PRICE_HIST_B_TENANT = "0b000000-0000-7000-8000-00000000b601";
export const PRICE_HIST_B_STORE_X = "0b000000-0000-7000-8000-00000000b602";

// Unknown items — one pending per store (cross-store SELECT denial
// target for T342 / matrix §7), one resolved per tenant for the
// resolution-status branches.
export const UNKNOWN_A_X = "0a000000-0000-7000-8000-00000000a711";
export const UNKNOWN_A_Y = "0a000000-0000-7000-8000-00000000a712";
export const UNKNOWN_B_X = "0b000000-0000-7000-8000-00000000b711";
export const UNKNOWN_B_Y = "0b000000-0000-7000-8000-00000000b712";

// Correlation IDs for unknown_items (NOT NULL on that table).
export const UNKNOWN_A_X_CORR = "0a000000-0000-7000-8000-00000000a721";
export const UNKNOWN_A_Y_CORR = "0a000000-0000-7000-8000-00000000a722";
export const UNKNOWN_B_X_CORR = "0b000000-0000-7000-8000-00000000b721";
export const UNKNOWN_B_Y_CORR = "0b000000-0000-7000-8000-00000000b722";

// Actors — `created_by` / `updated_by` are NOT NULL on tenant_products
// and store_product_overrides but have no FK; any UUID is acceptable.
export const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";
export const ACTOR_B = "0b000000-0000-7000-8000-0000000000bc";

/**
 * Strongly-typed bundle of every ID this harness creates. Consumer
 * specs destructure what they need.
 */
export interface CatalogFixtureIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly storeAX: string;
  readonly storeAY: string;
  readonly storeBX: string;
  readonly storeBY: string;
  readonly categoryA: string;
  readonly categoryB: string;
  readonly productAActive: string;
  readonly productARetired: string;
  readonly productBActive: string;
  readonly productBRetired: string;
  readonly globalProduct: string;
  readonly overrideAX: string;
  readonly overrideAY: string;
  readonly overrideBX: string;
  readonly overrideBY: string;
  readonly aliasABarcode: string;
  readonly aliasAXPos: string;
  readonly aliasBBarcode: string;
  readonly aliasBXPos: string;
  readonly priceHistATenant: string;
  readonly priceHistAStoreX: string;
  readonly priceHistBTenant: string;
  readonly priceHistBStoreX: string;
  readonly unknownAX: string;
  readonly unknownAY: string;
  readonly unknownBX: string;
  readonly unknownBY: string;
  readonly actorA: string;
  readonly actorB: string;
}

/** Frozen ID record — what `seedCatalogIsolationFixture` returns. */
export const CATALOG_FIXTURE_IDS: CatalogFixtureIds = Object.freeze({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  storeAX: STORE_A_X,
  storeAY: STORE_A_Y,
  storeBX: STORE_B_X,
  storeBY: STORE_B_Y,
  categoryA: CATEGORY_A,
  categoryB: CATEGORY_B,
  productAActive: PRODUCT_A_ACTIVE,
  productARetired: PRODUCT_A_RETIRED,
  productBActive: PRODUCT_B_ACTIVE,
  productBRetired: PRODUCT_B_RETIRED,
  globalProduct: GLOBAL_PRODUCT,
  overrideAX: OVERRIDE_A_X,
  overrideAY: OVERRIDE_A_Y,
  overrideBX: OVERRIDE_B_X,
  overrideBY: OVERRIDE_B_Y,
  aliasABarcode: ALIAS_A_BARCODE,
  aliasAXPos: ALIAS_A_X_POS,
  aliasBBarcode: ALIAS_B_BARCODE,
  aliasBXPos: ALIAS_B_X_POS,
  priceHistATenant: PRICE_HIST_A_TENANT,
  priceHistAStoreX: PRICE_HIST_A_STORE_X,
  priceHistBTenant: PRICE_HIST_B_TENANT,
  priceHistBStoreX: PRICE_HIST_B_STORE_X,
  unknownAX: UNKNOWN_A_X,
  unknownAY: UNKNOWN_A_Y,
  unknownBX: UNKNOWN_B_X,
  unknownBY: UNKNOWN_B_Y,
  actorA: ACTOR_A,
  actorB: ACTOR_B,
});

// ----------------------------------------------------------------------------
// Seed function
// ----------------------------------------------------------------------------

/**
 * Seed the catalog isolation fixture against `env.admin`. Idempotent
 * via `ON CONFLICT DO NOTHING` on every INSERT — a consumer spec may
 * call this twice without harm. Returns the frozen ID record.
 *
 * Preconditions (consumer responsibilities):
 *   - The Postgres container is running.
 *   - All migrations 0000–0008 have been applied (e.g. via
 *     `applyAllUpAndCreateAppRole(env)` from
 *     `apps/api/test/_helpers/postgres-container.ts`).
 *   - The runtime `app_test` role has been created with GRANTs on
 *     public tables and sequences.
 */
export async function seedCatalogIsolationFixture(
  env: SeedableEnv,
): Promise<CatalogFixtureIds> {
  const { admin } = env;

  // ---- 1. tenants ---------------------------------------------------------
  await admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 't340-a', 'T340 Tenant A', 'USD'),
       ($2, 't340-b', 'T340 Tenant B', 'USD')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  );

  // ---- 2. stores ----------------------------------------------------------
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'AX', 'T340 Store A-X'),
       ($3, $2, 'AY', 'T340 Store A-Y'),
       ($4, $5, 'BX', 'T340 Store B-X'),
       ($6, $5, 'BY', 'T340 Store B-Y')
     ON CONFLICT DO NOTHING`,
    [STORE_A_X, TENANT_A, STORE_A_Y, STORE_B_X, TENANT_B, STORE_B_Y],
  );

  // ---- 3. global_products (platform-wide; no tenant_id) ------------------
  await admin.query(
    `INSERT INTO global_products
       (id, name, suggested_tax_category, created_by)
     VALUES ($1, 'T340 Global Product', 'standard', $2)
     ON CONFLICT DO NOTHING`,
    [GLOBAL_PRODUCT, ACTOR_A],
  );

  // ---- 4. tenant_product_categories ---------------------------------------
  await admin.query(
    `INSERT INTO tenant_product_categories
       (id, tenant_id, name, created_by)
     VALUES
       ($1, $2, 'T340 Category A', $3),
       ($4, $5, 'T340 Category B', $6)
     ON CONFLICT DO NOTHING`,
    [CATEGORY_A, TENANT_A, ACTOR_A, CATEGORY_B, TENANT_B, ACTOR_B],
  );

  // ---- 5. tenant_products -------------------------------------------------
  // Active rows reference their tenant's category. Retired rows leave
  // category_id NULL to keep the fixture small.
  // `retired_at` set on the retired row demonstrates the soft-delete
  // path used by retired_at partial-index logic.
  await admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, category_id, tax_category,
        source_global_product_id, retired_at, created_by, updated_by)
     VALUES
       ($1, $2, 'T340 Product A-Active', $3, 'standard', $4, NULL, $5, $5),
       ($6, $2, 'T340 Product A-Retired', NULL, 'standard', NULL, now(), $5, $5),
       ($7, $8, 'T340 Product B-Active', $9, 'standard', $4, NULL, $10, $10),
       ($11, $8, 'T340 Product B-Retired', NULL, 'standard', NULL, now(), $10, $10)
     ON CONFLICT DO NOTHING`,
    [
      PRODUCT_A_ACTIVE, TENANT_A, CATEGORY_A, GLOBAL_PRODUCT, ACTOR_A,
      PRODUCT_A_RETIRED,
      PRODUCT_B_ACTIVE, TENANT_B, CATEGORY_B,
      ACTOR_B,
      PRODUCT_B_RETIRED,
    ],
  );

  // ---- 6. store_product_overrides ----------------------------------------
  // One per store, attached to that tenant's ACTIVE product. Use
  // `is_active = true` alone to satisfy the
  // `store_product_overrides_at_least_one_override` CHECK while keeping
  // price/currency NULL (the paired-currency CHECK is happy when both
  // are null).
  await admin.query(
    `INSERT INTO store_product_overrides
       (id, tenant_id, store_id, product_id, is_active,
        created_by, updated_by)
     VALUES
       ($1, $2, $3, $4, true, $5, $5),
       ($6, $2, $7, $4, true, $5, $5),
       ($8, $9, $10, $11, true, $12, $12),
       ($13, $9, $14, $11, true, $12, $12)
     ON CONFLICT DO NOTHING`,
    [
      OVERRIDE_A_X, TENANT_A, STORE_A_X, PRODUCT_A_ACTIVE, ACTOR_A,
      OVERRIDE_A_Y, STORE_A_Y,
      OVERRIDE_B_X, TENANT_B, STORE_B_X, PRODUCT_B_ACTIVE, ACTOR_B,
      OVERRIDE_B_Y, STORE_B_Y,
    ],
  );

  // ---- 7. product_aliases -------------------------------------------------
  // Two per tenant: a tenant-wide barcode (store_id NULL) and a
  // store-scoped sku (store_id = the X store). external_pos_id cannot
  // be store-scoped per the `product_aliases_store_scope_consistency`
  // CHECK (external_pos_id rows must have store_id NULL); sku has no
  // such restriction, so it satisfies the store-scoped-uniqueness path
  // we want to exercise. source_system stays NULL for non-external types
  // per the `product_aliases_source_system_required` CHECK.
  await admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES
       ($1, $2, $3, 'barcode', 'T340-A-BAR-001', NULL, NULL, $11),
       ($4, $2, $3, 'sku', 'A-X-SKU-001', NULL, $5, $11),
       ($6, $7, $8, 'barcode', 'T340-B-BAR-001', NULL, NULL, $12),
       ($9, $7, $8, 'sku', 'B-X-SKU-001', NULL, $10, $12)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_A_BARCODE, TENANT_A, PRODUCT_A_ACTIVE,
      ALIAS_A_X_POS, STORE_A_X,
      ALIAS_B_BARCODE, TENANT_B, PRODUCT_B_ACTIVE,
      ALIAS_B_X_POS, STORE_B_X,
      ACTOR_A, ACTOR_B,
    ],
  );

  // ---- 8. price_history ---------------------------------------------------
  // Two per tenant: a tenant-level baseline (store_id NULL) and a
  // store-scoped X-store row. Required columns vary by what 0007
  // declares; we set the common ones (tenant_id, product_id, price,
  // currency_code, effective_from) and let any optional column default.
  // If the schema rejects this shape on a future migration, the
  // consumer spec will catch it.
  await admin.query(
    `INSERT INTO price_history
       (id, tenant_id, product_id, store_id, price, currency_code,
        effective_from, created_by)
     VALUES
       ($1, $2, $3, NULL, 9.99, 'USD', now(), $4),
       ($5, $2, $3, $6, 10.49, 'USD', now(), $4),
       ($7, $8, $9, NULL, 8.50, 'USD', now(), $10),
       ($11, $8, $9, $12, 8.99, 'USD', now(), $10)
     ON CONFLICT DO NOTHING`,
    [
      PRICE_HIST_A_TENANT, TENANT_A, PRODUCT_A_ACTIVE, ACTOR_A,
      PRICE_HIST_A_STORE_X, STORE_A_X,
      PRICE_HIST_B_TENANT, TENANT_B, PRODUCT_B_ACTIVE, ACTOR_B,
      PRICE_HIST_B_STORE_X, STORE_B_X,
    ],
  );

  // ---- 9. unknown_items ---------------------------------------------------
  // One PENDING per store (cross-store SELECT denial target for T342
  // and matrix §7.4). Pending status requires all resolved_* fields
  // null per the `unknown_items_resolved_fields_consistent` CHECK.
  // `correlation_id` is NOT NULL.
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', 'T340-A-X-UNK', 'pending', $4),
       ($5, $2, $6, 'barcode', 'T340-A-Y-UNK', 'pending', $7),
       ($8, $9, $10, 'barcode', 'T340-B-X-UNK', 'pending', $11),
       ($12, $9, $13, 'barcode', 'T340-B-Y-UNK', 'pending', $14)
     ON CONFLICT DO NOTHING`,
    [
      UNKNOWN_A_X, TENANT_A, STORE_A_X, UNKNOWN_A_X_CORR,
      UNKNOWN_A_Y, STORE_A_Y, UNKNOWN_A_Y_CORR,
      UNKNOWN_B_X, TENANT_B, STORE_B_X, UNKNOWN_B_X_CORR,
      UNKNOWN_B_Y, STORE_B_Y, UNKNOWN_B_Y_CORR,
    ],
  );

  return CATALOG_FIXTURE_IDS;
}

// ----------------------------------------------------------------------------
// Aggregate counts — exported for consumer spec sanity checks
// ----------------------------------------------------------------------------

/**
 * Expected row counts after `seedCatalogIsolationFixture` succeeds.
 * Consumer specs can use these to verify the fixture is intact before
 * exercising RLS assertions.
 *
 * Per-table counts:
 *   - tenants:                    2
 *   - stores:                     4  (2 per tenant)
 *   - global_products:            1
 *   - tenant_product_categories:  2  (1 per tenant)
 *   - tenant_products:            4  (2 per tenant: 1 active + 1 retired)
 *   - store_product_overrides:    4  (1 per store)
 *   - product_aliases:            4  (1 barcode + 1 external_pos_id per tenant)
 *   - price_history:              4  (1 tenant-level + 1 store-X-level per tenant)
 *   - unknown_items:              4  (1 pending per store)
 */
export const CATALOG_FIXTURE_COUNTS = Object.freeze({
  tenants: 2,
  stores: 4,
  global_products: 1,
  tenant_product_categories: 2,
  tenant_products: 4,
  store_product_overrides: 4,
  product_aliases: 4,
  price_history: 4,
  unknown_items: 4,
} as const);
