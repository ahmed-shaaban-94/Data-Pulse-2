/**
 * T317 — `global_products` Drizzle schema shape test.
 *
 * Authoritative source: specs/003-catalog-foundation/data-model.md §2.
 *
 * Asserts the platform-scoped Global Product Index schema. Key properties:
 *
 *   1. `global_products` is a **platform-wide** reference table — it must
 *      NOT carry `tenant_id` or `store_id` columns. Tenant scoping lives on
 *      `tenant_products` (data-model.md §1 "Source-of-truth authority" and
 *      §2 "Purpose and source-of-truth role").
 *   2. Soft-delete uses `retired_at timestamptz NULL` per R-3 / PQ-5.
 *   3. Price (`default_price numeric(19,4) NULL`) and currency
 *      (`default_currency_code char(3) NULL`) are paired; both nullable
 *      only because the Global Index allows "no suggested price". The Zod
 *      / CHECK pairing rule (price-iff-currency) is enforced at the DB
 *      layer by `CHK global_products_currency_paired`; this spec asserts
 *      the column shape needed to support that CHECK.
 *   4. `id uuid PRIMARY KEY` (UUIDv7 preferred, UUIDv4 fallback).
 *   5. `created_at` / `updated_at` timestamptz NOT NULL.
 *   6. `created_by uuid NOT NULL` (Platform Admin actor; never body-supplied).
 *
 * This test is the TDD RED gate for T320's `global-products.ts` schema
 * authoring. It will fail RED today because the file does not exist yet.
 */
import { getTableColumns, getTableName } from "drizzle-orm";

import * as schema from "../../../src/schema";

// ---------------------------------------------------------------------------
// Resolve the table export. We do not import from
// `../../../src/schema/catalog/global-products` directly — the barrel is the
// source of truth for downstream consumers (T331), so we exercise the barrel.
// ---------------------------------------------------------------------------

function loadGlobalProductsTable(): Parameters<typeof getTableColumns>[0] {
  const tbl = (schema as Record<string, unknown>)["globalProducts"];
  if (tbl === undefined) {
    // Re-throwing here would obscure the real "module not found" error from
    // resolving the barrel; jest will already report a meaningful failure
    // from the `expect(tbl).toBeDefined()` call below. We still narrow types.
    throw new Error("globalProducts is not exported from the schema barrel");
  }
  return tbl as Parameters<typeof getTableColumns>[0];
}

describe("packages/db/src/schema/catalog/global-products.ts — schema shape (T317)", () => {
  it("is exported from the schema barrel and bound to the `global_products` SQL name", () => {
    const tbl = (schema as Record<string, unknown>)["globalProducts"];
    expect(tbl).toBeDefined();
    expect(getTableName(tbl as Parameters<typeof getTableName>[0])).toBe(
      "global_products",
    );
  });

  it("has an `id` primary-key column of uuid type", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    expect(cols).toHaveProperty("id");
    const id = cols["id"];
    expect(id).toBeDefined();
    expect(id!.primary).toBe(true);
    // Drizzle reports uuid columns with dataType "string" and columnType
    // "PgUUID". Asserting columnType is the precise check.
    expect(id!.columnType).toBe("PgUUID");
    expect(id!.notNull).toBe(true);
  });

  it("DOES NOT have a `tenant_id` column (platform-scoped reference table)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    expect(cols).not.toHaveProperty("tenantId");
    expect(cols).not.toHaveProperty("tenant_id");
    for (const col of Object.values(cols)) {
      expect(col.name).not.toBe("tenant_id");
    }
  });

  it("DOES NOT have a `store_id` column (platform-scoped reference table)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    expect(cols).not.toHaveProperty("storeId");
    expect(cols).not.toHaveProperty("store_id");
    for (const col of Object.values(cols)) {
      expect(col.name).not.toBe("store_id");
    }
  });

  it("has `retired_at` nullable timestamptz for soft-delete (R-3 / PQ-5)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    // The Drizzle property name in our codebase convention is camelCase;
    // the SQL column is `retired_at`.
    const retiredAt = cols["retiredAt"] ?? cols["retired_at"];
    expect(retiredAt).toBeDefined();
    expect(retiredAt!.name).toBe("retired_at");
    expect(retiredAt!.notNull).toBe(false);
    expect(retiredAt!.columnType).toBe("PgTimestamp");
  });

  it("has `created_at` and `updated_at` NOT NULL timestamptz", () => {
    const cols = getTableColumns(loadGlobalProductsTable());

    const createdAt = cols["createdAt"] ?? cols["created_at"];
    expect(createdAt).toBeDefined();
    expect(createdAt!.name).toBe("created_at");
    expect(createdAt!.notNull).toBe(true);
    expect(createdAt!.columnType).toBe("PgTimestamp");

    const updatedAt = cols["updatedAt"] ?? cols["updated_at"];
    expect(updatedAt).toBeDefined();
    expect(updatedAt!.name).toBe("updated_at");
    expect(updatedAt!.notNull).toBe(true);
    expect(updatedAt!.columnType).toBe("PgTimestamp");
  });

  it("has `name` text NOT NULL (canonical product name)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    expect(cols).toHaveProperty("name");
    const name = cols["name"];
    expect(name).toBeDefined();
    expect(name!.notNull).toBe(true);
    // Drizzle text columns have columnType "PgText".
    expect(name!.columnType).toBe("PgText");
  });

  it("has `default_price` nullable numeric and `default_currency_code` nullable char(3) (paired by CHECK)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());

    const price = cols["defaultPrice"] ?? cols["default_price"];
    expect(price).toBeDefined();
    expect(price!.name).toBe("default_price");
    expect(price!.notNull).toBe(false);
    // Drizzle numeric columns have columnType "PgNumeric".
    expect(price!.columnType).toBe("PgNumeric");

    const currency =
      cols["defaultCurrencyCode"] ?? cols["default_currency_code"];
    expect(currency).toBeDefined();
    expect(currency!.name).toBe("default_currency_code");
    expect(currency!.notNull).toBe(false);
    // Drizzle char columns have columnType "PgChar".
    expect(currency!.columnType).toBe("PgChar");
  });

  it("has `created_by` uuid NOT NULL (Platform Admin actor; never body-supplied)", () => {
    const cols = getTableColumns(loadGlobalProductsTable());
    const createdBy = cols["createdBy"] ?? cols["created_by"];
    expect(createdBy).toBeDefined();
    expect(createdBy!.name).toBe("created_by");
    expect(createdBy!.notNull).toBe(true);
    expect(createdBy!.columnType).toBe("PgUUID");
  });

  it("characterizes the table as reference-only (no tenant or store scoping columns at all)", () => {
    // Belt-and-braces: enumerate all columns and assert none of them are
    // tenant_id or store_id under any naming convention. This guards against
    // a future drift where someone "helpfully" adds a tenant scope to the
    // Global Product Index, which would silently violate the source-of-truth
    // contract from data-model.md §1.
    const cols = getTableColumns(loadGlobalProductsTable());
    const sqlNames = Object.values(cols).map((c) => c.name);
    expect(sqlNames).not.toContain("tenant_id");
    expect(sqlNames).not.toContain("store_id");
  });
});
