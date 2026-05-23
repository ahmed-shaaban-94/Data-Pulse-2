/**
 * T383 — ProductAliasesService uniqueness scope tests.
 *
 * Status: RED — ProductAliasesService does not yet exist.
 * Implementation lands in T384 at:
 *   apps/api/src/modules/catalog/product-aliases.service.ts
 *
 * Purpose
 * -------
 * Asserts that alias uniqueness rules from data-model.md §6 and spec §6.1
 * (Q4 binding) are enforced by the service layer. Three partial unique
 * indexes govern alias uniqueness:
 *
 *   1. UQ_idx_product_aliases_tenant_wide
 *      ON (tenant_id, identifier_type, value)
 *      WHERE store_id IS NULL AND identifier_type <> 'external_pos_id'
 *      AND retired_at IS NULL
 *
 *   2. UQ_idx_product_aliases_external_pos_id
 *      ON (tenant_id, source_system, value)
 *      WHERE identifier_type = 'external_pos_id' AND retired_at IS NULL
 *
 *   3. UQ_idx_product_aliases_store_scoped
 *      ON (tenant_id, store_id, identifier_type, value)
 *      WHERE store_id IS NOT NULL AND retired_at IS NULL
 *
 * Assumed service contract (T384 must satisfy):
 * -----------------------------------------------
 *   ProductAliasesService.create(
 *     input: {
 *       tenantId: string;
 *       productId: string;
 *       identifierType: 'barcode' | 'sku' | 'plu' | 'supplier_code' | 'external_pos_id';
 *       value: string;
 *       sourceSystem?: string;  // required when identifierType = 'external_pos_id'
 *       storeId?: string;       // null/undefined = tenant-wide alias
 *     },
 *     actorId: string,
 *   ): Promise<{ id: string; tenantId: string; productId: string; identifierType: string;
 *                value: string; sourceSystem: string | null; storeId: string | null; }>
 *
 * When a uniqueness constraint is violated the service must throw an error
 * that either:
 *   (a) is an instance of ConflictException (NestJS), or
 *   (b) has message matching /duplicate|unique|conflict|already exists/i, or
 *   (c) re-throws the underlying Postgres unique-violation (code '23505').
 * Any of those three signals is acceptable — the test matches on all three.
 *
 * Scenarios covered (Groups A–H)
 * --------------------------------
 * A. Happy create — tenant-wide barcode persists with correct fields.
 * B. Tenant-wide collision — duplicate (tenant_id, identifier_type, value)
 *    with store_id NULL is rejected.
 * C. Cross-tenant same value allowed — Tenant A and Tenant B may both hold
 *    the same (identifier_type, value) without collision.
 * D. external_pos_id — source_system required (CHK constraint surfaced).
 * E. external_pos_id uniqueness — duplicate (tenant_id, source_system, value)
 *    rejected; different source_system with same value allowed.
 * F. Store-scoped uniqueness — duplicate (tenant_id, store_id, identifier_type,
 *    value) rejected; same value in a different store is allowed.
 * G. Coexistence — tenant-wide alias and store-scoped alias for the same value
 *    can both exist (different partial-UQ predicates, no collision).
 * H. external_pos_id cannot be store-scoped (CHK product_aliases_store_scope_consistency).
 *
 * Note on filename discrepancy
 * -----------------------------
 * tasks.md §4.6 T383 names the file `product-aliases.service.uniqueness.spec.ts`,
 * but execution-map.yaml (authoritative) names it `product-aliases.service.spec.ts`.
 * This file follows execution-map.yaml — which governs per CLAUDE.md bootstrap order.
 *
 * Note on Docker requirement
 * --------------------------
 * These tests require a running Postgres container (Testcontainers). Set
 * MIGRATION_TEST_ALLOW_SKIP=1 to skip on machines without Docker.
 */

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

// The service does NOT exist yet — this import triggers the RED failure.
// T384 will create the file at this path.
import { ProductAliasesService } from "../../src/modules/catalog/product-aliases.service";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Returns true if the error indicates a uniqueness / conflict violation.
 * Accepts: Postgres code 23505, NestJS ConflictException (409), or message
 * matching duplicate/unique/conflict/already exists.
 */
function isConflictError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["code"] === "23505") return true;
  if (typeof e["status"] === "number" && e["status"] === 409) return true;
  const msg = typeof e["message"] === "string" ? e["message"] : "";
  return /duplicate|unique|conflict|already exists/i.test(msg);
}

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let service: ProductAliasesService | null = null;
let dockerSkipped = false;

// Stable new IDs used only within this spec (mnemonic prefix 't383').
// All hex, per feedback_uuid_hex_literals convention.
const NEW_ALIAS_ID_1 = "0a000000-0000-7000-8000-000000003831";
const NEW_ALIAS_ID_2 = "0a000000-0000-7000-8000-000000003832";
const NEW_ALIAS_ID_3 = "0b000000-0000-7000-8000-000000003833";
const NEW_ALIAS_ID_4 = "0a000000-0000-7000-8000-000000003834";
const NEW_ALIAS_ID_5 = "0a000000-0000-7000-8000-000000003835";
const NEW_ALIAS_ID_6 = "0a000000-0000-7000-8000-000000003836";
const NEW_ALIAS_ID_7 = "0b000000-0000-7000-8000-000000003837";
const NEW_ALIAS_ID_8 = "0a000000-0000-7000-8000-000000003838";
const NEW_ALIAS_ID_9 = "0a000000-0000-7000-8000-000000003839";

// Actor IDs from the harness
const { actorA, actorB } = CATALOG_FIXTURE_IDS;

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    // T384 will make this construction valid. For now the import above
    // fails before we ever reach here — the RED is at module-load time.
    service = new ProductAliasesService(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[product-aliases.service.spec] Docker NOT AVAILABLE: ${msg}\n`,
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
    console.warn(
      "[product-aliases.service.spec] skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Group A — Happy create: tenant-wide barcode alias
// --------------------------------------------------------------------------

describe("T383-A — happy create: tenant-wide barcode alias", () => {
  it("creates a tenant-wide barcode alias and returns correct fields", async () => {
    if (maybeSkip()) return;
    const result = await service!.create(
      {
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
        productId: CATALOG_FIXTURE_IDS.productAActive,
        identifierType: "barcode",
        value: "T383-A-BARCODE-NEW",
        storeId: undefined,
        sourceSystem: undefined,
      },
      actorA,
    );
    expect(result).toBeDefined();
    expect(result.tenantId).toBe(CATALOG_FIXTURE_IDS.tenantA);
    expect(result.productId).toBe(CATALOG_FIXTURE_IDS.productAActive);
    expect(result.identifierType).toBe("barcode");
    expect(result.value).toBe("T383-A-BARCODE-NEW");
    expect(result.storeId).toBeNull();
    expect(result.sourceSystem).toBeNull();
    expect(result.id).toBeTruthy();
  });

  it("creates a tenant-wide SKU alias and returns correct fields", async () => {
    if (maybeSkip()) return;
    const result = await service!.create(
      {
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
        productId: CATALOG_FIXTURE_IDS.productAActive,
        identifierType: "sku",
        value: "T383-A-SKU-NEW",
        storeId: undefined,
        sourceSystem: undefined,
      },
      actorA,
    );
    expect(result.tenantId).toBe(CATALOG_FIXTURE_IDS.tenantA);
    expect(result.identifierType).toBe("sku");
    expect(result.storeId).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Group B — Tenant-wide collision: duplicate (tenant_id, identifier_type, value)
// --------------------------------------------------------------------------

describe("T383-B — tenant-wide uniqueness collision: duplicate barcode within same tenant", () => {
  const sharedValue = "T383-B-DUPE-BARCODE";

  it("first create succeeds", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "barcode",
          value: sharedValue,
          storeId: undefined,
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });

  it("second create with same (tenant_id, identifier_type, value) fails with a conflict error", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productARetired, // different product, same alias
          identifierType: "barcode",
          value: sharedValue,
          storeId: undefined,
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).rejects.toSatisfy(isConflictError);
  });
});

// --------------------------------------------------------------------------
// Group C — Cross-tenant: same (identifier_type, value) allowed in different tenants
// --------------------------------------------------------------------------

describe("T383-C — cross-tenant: same alias value allowed in different tenants", () => {
  const crossTenantValue = "T383-C-SHARED-ACROSS-TENANTS";

  it("Tenant A creates a barcode alias", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "barcode",
          value: crossTenantValue,
          storeId: undefined,
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });

  it("Tenant B creates the same barcode value — no collision (different tenant)", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantB,
          productId: CATALOG_FIXTURE_IDS.productBActive,
          identifierType: "barcode",
          value: crossTenantValue,
          storeId: undefined,
          sourceSystem: undefined,
        },
        actorB,
      ),
    ).resolves.toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group D — external_pos_id: source_system is required
// --------------------------------------------------------------------------

describe("T383-D — external_pos_id requires source_system", () => {
  it("creating external_pos_id alias without source_system fails (CHK constraint)", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "external_pos_id",
          value: "T383-D-POS-NO-SRC",
          storeId: undefined,
          sourceSystem: undefined, // missing — must fail
        },
        actorA,
      ),
    ).rejects.toBeDefined();
  });

  it("creating external_pos_id alias with source_system succeeds", async () => {
    if (maybeSkip()) return;
    const result = await service!.create(
      {
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
        productId: CATALOG_FIXTURE_IDS.productAActive,
        identifierType: "external_pos_id",
        value: "T383-D-POS-WITH-SRC",
        sourceSystem: "pos-system-alpha",
        storeId: undefined,
      },
      actorA,
    );
    expect(result.identifierType).toBe("external_pos_id");
    expect(result.sourceSystem).toBe("pos-system-alpha");
    expect(result.storeId).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Group E — external_pos_id uniqueness: (tenant_id, source_system, value)
// --------------------------------------------------------------------------

describe("T383-E — external_pos_id uniqueness scoped by source_system", () => {
  const posValue = "T383-E-POS-VALUE";

  it("first external_pos_id (source_system=alpha) succeeds", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "external_pos_id",
          value: posValue,
          sourceSystem: "pos-alpha",
          storeId: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });

  it("duplicate (tenant_id, source_system, value) rejected — same pos system", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productARetired, // different product
          identifierType: "external_pos_id",
          value: posValue,
          sourceSystem: "pos-alpha", // same — collision
          storeId: undefined,
        },
        actorA,
      ),
    ).rejects.toSatisfy(isConflictError);
  });

  it("same value with different source_system is allowed — no collision", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productARetired,
          identifierType: "external_pos_id",
          value: posValue,
          sourceSystem: "pos-beta", // different source — OK
          storeId: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group F — Store-scoped uniqueness: (tenant_id, store_id, identifier_type, value)
// --------------------------------------------------------------------------

describe("T383-F — store-scoped alias uniqueness", () => {
  const storeScopedValue = "T383-F-STORE-SKU";

  it("creating a store-scoped SKU alias for Store A-X succeeds", async () => {
    if (maybeSkip()) return;
    const result = await service!.create(
      {
        tenantId: CATALOG_FIXTURE_IDS.tenantA,
        productId: CATALOG_FIXTURE_IDS.productAActive,
        identifierType: "sku",
        value: storeScopedValue,
        storeId: CATALOG_FIXTURE_IDS.storeAX,
        sourceSystem: undefined,
      },
      actorA,
    );
    expect(result.storeId).toBe(CATALOG_FIXTURE_IDS.storeAX);
    expect(result.identifierType).toBe("sku");
  });

  it("duplicate (tenant_id, store_id, identifier_type, value) in same store is rejected", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productARetired, // different product
          identifierType: "sku",
          value: storeScopedValue,
          storeId: CATALOG_FIXTURE_IDS.storeAX, // same store — collision
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).rejects.toSatisfy(isConflictError);
  });

  it("same (identifier_type, value) in a different store of the same tenant is allowed", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productARetired,
          identifierType: "sku",
          value: storeScopedValue,
          storeId: CATALOG_FIXTURE_IDS.storeAY, // different store — OK
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group G — Coexistence: tenant-wide and store-scoped aliases for same value
// --------------------------------------------------------------------------

describe("T383-G — coexistence of tenant-wide and store-scoped aliases for identical value", () => {
  const coexistValue = "T383-G-COEXIST";

  it("tenant-wide barcode alias (store_id = NULL) creates without error", async () => {
    if (maybeSkip()) return;
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "barcode",
          value: coexistValue,
          storeId: undefined, // tenant-wide
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });

  it("store-scoped barcode alias for same value (store_id = storeAX) creates without error — no collision with tenant-wide row", async () => {
    if (maybeSkip()) return;
    // The UQ_idx_product_aliases_tenant_wide partial index predicate
    // is `WHERE store_id IS NULL ...` and
    // UQ_idx_product_aliases_store_scoped is `WHERE store_id IS NOT NULL ...`.
    // These are mutually exclusive — both rows can coexist.
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "barcode",
          value: coexistValue,
          storeId: CATALOG_FIXTURE_IDS.storeAX, // store-scoped — different partial index
          sourceSystem: undefined,
        },
        actorA,
      ),
    ).resolves.toBeDefined();
  });
});

// --------------------------------------------------------------------------
// Group H — external_pos_id cannot be store-scoped (CHK constraint)
// --------------------------------------------------------------------------

describe("T383-H — external_pos_id cannot be store-scoped (CHK product_aliases_store_scope_consistency)", () => {
  it("creating external_pos_id alias with store_id set fails (check constraint)", async () => {
    if (maybeSkip()) return;
    // CHK product_aliases_store_scope_consistency:
    //   store_id IS NULL OR identifier_type <> 'external_pos_id'
    // A row with identifier_type = 'external_pos_id' AND store_id IS NOT NULL
    // violates this constraint.
    await expect(
      service!.create(
        {
          tenantId: CATALOG_FIXTURE_IDS.tenantA,
          productId: CATALOG_FIXTURE_IDS.productAActive,
          identifierType: "external_pos_id",
          value: "T383-H-POS-STORE-SCOPED",
          sourceSystem: "pos-gamma",
          storeId: CATALOG_FIXTURE_IDS.storeAX, // must be NULL for external_pos_id
        },
        actorA,
      ),
    ).rejects.toBeDefined();
  });
});
