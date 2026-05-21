/**
 * T325 — Per-file import test for every catalog schema module.
 *
 * Each of the seven future schema files under `packages/db/src/schema/catalog/`
 * must be independently importable. The goal is to detect:
 *
 *   - circular imports between catalog modules (a module that resolves only
 *     via barrel side-effect ordering will fail this test),
 *   - missing default exports / table-symbol typos,
 *   - any module that fails to load standalone.
 *
 * The seven file paths come from `tasks.md` T320:
 *
 *   - packages/db/src/schema/catalog/global-products.ts
 *   - packages/db/src/schema/catalog/tenant-products.ts
 *   - packages/db/src/schema/catalog/tenant-product-categories.ts
 *   - packages/db/src/schema/catalog/store-product-overrides.ts
 *   - packages/db/src/schema/catalog/product-aliases.ts
 *   - packages/db/src/schema/catalog/price-history.ts
 *   - packages/db/src/schema/catalog/unknown-items.ts
 *
 * Each is expected to export the corresponding Drizzle pgTable symbol with
 * the SQL name from data-model.md §1.
 *
 * Authoring this spec is the TDD RED gate for T320 (the schema files themselves).
 * The test will fail RED today because none of those modules exist yet —
 * `import("../../../src/schema/catalog/global-products")` will reject with a
 * module-not-found error. That is the expected RED state.
 */
import { getTableName } from "drizzle-orm";

// ---------------------------------------------------------------------------
// (modulePath, expected pgTable export name, expected SQL table name)
// Tuples drawn from tasks.md T320 (module paths) and data-model.md §1 (SQL
// names). We resolve module paths relative to this spec file using
// `../../../src/schema/catalog/<file>`.
// ---------------------------------------------------------------------------

const CATALOG_MODULES: ReadonlyArray<
  readonly [modulePath: string, exportName: string, sqlTableName: string]
> = [
  [
    "../../../src/schema/catalog/global-products",
    "globalProducts",
    "global_products",
  ],
  [
    "../../../src/schema/catalog/tenant-products",
    "tenantProducts",
    "tenant_products",
  ],
  [
    "../../../src/schema/catalog/tenant-product-categories",
    "tenantProductCategories",
    "tenant_product_categories",
  ],
  [
    "../../../src/schema/catalog/store-product-overrides",
    "storeProductOverrides",
    "store_product_overrides",
  ],
  [
    "../../../src/schema/catalog/product-aliases",
    "productAliases",
    "product_aliases",
  ],
  [
    "../../../src/schema/catalog/price-history",
    "priceHistory",
    "price_history",
  ],
  [
    "../../../src/schema/catalog/unknown-items",
    "unknownItems",
    "unknown_items",
  ],
] as const;

describe("packages/db/src/schema/catalog/* — per-file independent import (T325)", () => {
  it.each(CATALOG_MODULES)(
    "module %s loads standalone and exposes pgTable export %s for SQL table %s",
    async (modulePath, exportName, sqlTableName) => {
      // Dynamic import so a single missing module fails ONE test, not the
      // whole suite. Jest under ts-jest resolves relative paths from this
      // spec file's location.
      const mod = (await import(modulePath)) as Record<string, unknown>;

      expect(mod).toBeDefined();
      expect(mod).toHaveProperty(exportName);

      const tbl = mod[exportName];
      expect(tbl).toBeDefined();
      // getTableName throws if `tbl` is not a real Drizzle pgTable. That is
      // intentional — it doubles as a "the export is actually a table"
      // assertion on top of the SQL-name match.
      expect(getTableName(tbl as Parameters<typeof getTableName>[0])).toBe(
        sqlTableName,
      );
    },
  );
});
