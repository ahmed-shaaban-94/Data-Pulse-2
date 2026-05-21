/**
 * T318 — `tenant_products` Drizzle schema shape (RED).
 *
 * This test is authored BEFORE the catalog schema files exist (T320 is
 * `[GATED]` and has not run yet). The future schema file
 * `packages/db/src/schema/catalog/tenant-products.ts` must be re-exported by
 * the schema barrel (T331) and satisfy the assertions below.
 *
 * Source of truth for column shape: `specs/003-catalog-foundation/data-model.md`
 * §3 (`tenant_products`) plus §11 (variant forward-compatibility / Q6).
 *
 * Q-coverage anchors (spec §16):
 *   - Q1  → monetary precision/scale via `numeric(19, 4)`.
 *   - Q2  → ISO 4217 currency stored as `char(3) NOT NULL` when a monetary
 *           amount is stored (data-model.md §3 keeps `default_currency_code`
 *           NULLable, but paired with `default_price` via a CHECK
 *           constraint; the column shape itself remains `char(3)`).
 *   - Q5  → copy-on-adopt provenance via nullable `source_global_product_id`;
 *           data-model.md §3 deliberately removes the FK to `global_products`
 *           so platform-side lifecycle never cascades into tenant data. The
 *           test enforces both readings: no FK declared, and if a future
 *           variant ever declares one, it MUST NOT be `ON DELETE CASCADE`.
 *   - Q6  → product variants deferred from v1 — no `parent_product_id`,
 *           `variant_group_id`, or `variant_attributes` columns are present.
 *   - Q7  → flat categories — `category_id` references the (flat)
 *           `tenant_product_categories` table; no hierarchy column lives on
 *           `tenant_products` itself.
 *   - Q11 → opaque tax classification on `tenant_products` is `text NOT NULL`
 *           (task brief tagged this as Q6 but data-model.md §3 ties it to
 *           Q11 / R-5; we anchor the assertion to its truer source).
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { ForeignKey } from "drizzle-orm/pg-core";

// Intentional dynamic-shape import so a missing future schema produces a
// runtime RED failure (`expect(tenantProducts).toBeDefined()`) rather than a
// TS2305 compile error from ts-jest. The schema barrel re-exports nothing for
// `tenantProducts` today; T320 + T331 introduce both the file and the
// re-export simultaneously.
import * as schema from "../../../src/schema";
import type { tenants as tenantsTable } from "../../../src/schema";

type DrizzleTable = ReturnType<typeof getTableConfig> extends infer _
  ? Parameters<typeof getTableConfig>[0]
  : never;

interface SchemaShape {
  tenantProducts?: DrizzleTable;
  tenantProductCategories?: DrizzleTable;
  tenants?: typeof tenantsTable;
}

const s = schema as unknown as SchemaShape;
const tenantProducts = s.tenantProducts as DrizzleTable;
const tenantProductCategories = s.tenantProductCategories as
  | DrizzleTable
  | undefined;

describe("schema/catalog/tenant_products (T318)", () => {
  it("is exported from the schema barrel", () => {
    // RED: future schema not yet authored (T320 gated).
    expect(s.tenantProducts).toBeDefined();
  });

  it("is named `tenant_products` at the SQL layer", () => {
    expect(tenantProducts).toBeDefined();
    expect(getTableName(tenantProducts)).toBe("tenant_products");
  });

  it("`tenant_id` column exists and is NOT NULL (Q-multi-tenant — Constitution §2)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; notNull: boolean }
    >;
    expect(cols["tenantId"]).toBeDefined();
    expect(cols["tenantId"]?.name).toBe("tenant_id");
    expect(cols["tenantId"]?.notNull).toBe(true);
  });

  it("`tenant_id` declares a FK to `tenants.id` (Constitution §2 — tenant scoping enforced at the schema layer)", () => {
    expect(tenantProducts).toBeDefined();
    const cfg = getTableConfig(tenantProducts);
    const fks = cfg.foreignKeys as ForeignKey[];

    // Find the FK whose local column set includes `tenant_id`. The migration
    // suite (T326+) will additionally verify ON DELETE RESTRICT at the
    // pg_constraint level; here we anchor the FK presence + target shape in
    // Drizzle metadata so a future refactor cannot silently drop it.
    const tenantFk = fks.find((fk) => {
      const ref = fk.reference();
      return ref.columns.some((col) => col.name === "tenant_id");
    });
    expect(tenantFk).toBeDefined();

    const ref = tenantFk!.reference();
    expect(getTableName(ref.foreignTable)).toBe("tenants");
    // The referenced column on `tenants` MUST be `id`. Drizzle exposes the
    // referenced columns via `ref.foreignColumns` in 0.45.x.
    const referencedColumnNames = ref.foreignColumns.map(
      (col) => (col as { name: string }).name,
    );
    expect(referencedColumnNames).toEqual(["id"]);
  });

  it("monetary `default_price` is `numeric(19, 4)` (Q1)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string }
    >;
    expect(cols["defaultPrice"]).toBeDefined();
    expect(cols["defaultPrice"]?.name).toBe("default_price");
    // Q1 — no floating-point money. Drizzle's PgNumeric.getSQLType()
    // formats this as `numeric(19, 4)` (with a space) in 0.45.x.
    expect(cols["defaultPrice"]?.getSQLType()).toBe("numeric(19, 4)");
  });

  it("`default_currency_code` is `char(3)` paired with `default_price` (Q2)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    expect(cols["defaultCurrencyCode"]).toBeDefined();
    expect(cols["defaultCurrencyCode"]?.name).toBe("default_currency_code");
    // Q2 — ISO 4217 currency code, fixed 3 chars.
    expect(cols["defaultCurrencyCode"]?.getSQLType()).toBe("char(3)");
    // Pairing rule: data-model.md §3 keeps the column NULLABLE so
    // `default_price IS NULL` rows can omit currency. The check constraint
    // `tenant_products_currency_paired` (Q2) enforces the (price, currency)
    // both-null-or-both-not-null invariant at the SQL layer.
    expect(cols["defaultCurrencyCode"]?.notNull).toBe(false);
    expect(cols["defaultPrice"]?.notNull).toBe(false);
  });

  it("`source_global_product_id` is a NULLABLE uuid column (Q5 — copy-on-adopt provenance)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    expect(cols["sourceGlobalProductId"]).toBeDefined();
    expect(cols["sourceGlobalProductId"]?.name).toBe("source_global_product_id");
    expect(cols["sourceGlobalProductId"]?.getSQLType()).toBe("uuid");
    expect(cols["sourceGlobalProductId"]?.notNull).toBe(false);
  });

  it("`source_global_product_id` either declares NO FK to `global_products` (data-model.md §3) — and if it does, NEVER `ON DELETE CASCADE` (Q5)", () => {
    expect(tenantProducts).toBeDefined();
    const cfg = getTableConfig(tenantProducts);
    const fks = cfg.foreignKeys as ForeignKey[];

    // Q5 — data-model.md §3 explicitly: "No FK constraint". A FK (even
    // without CASCADE) creates a hard dependency that would let platform-
    // side global-product lifecycle constrain tenant data. The primary
    // assertion: no FK whose local column set includes `source_global_product_id`.
    const offendingFks = fks.filter((fk) => {
      const ref = fk.reference();
      return ref.columns.some(
        (col) => col.name === "source_global_product_id",
      );
    });
    expect(offendingFks).toHaveLength(0);

    // Defense in depth — even if a future refactor re-introduces an FK on
    // this column, Q5 forbids CASCADE under any circumstance.
    for (const fk of offendingFks) {
      expect(fk.onDelete).not.toBe("cascade");
      expect(fk.onUpdate).not.toBe("cascade");
    }
  });

  it("`category_id` column references the FLAT `tenant_product_categories` table (Q7)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    expect(cols["categoryId"]).toBeDefined();
    expect(cols["categoryId"]?.name).toBe("category_id");
    expect(cols["categoryId"]?.getSQLType()).toBe("uuid");
    // Q7 — categories are flat; category_id is nullable (uncategorized).
    expect(cols["categoryId"]?.notNull).toBe(false);

    // Q7 — the FK target is `tenant_product_categories`, not a hierarchy
    // table. Detect the FK that lives on `category_id`.
    const cfg = getTableConfig(tenantProducts);
    const fks = cfg.foreignKeys as ForeignKey[];
    const categoryFk = fks.find((fk) => {
      const ref = fk.reference();
      return ref.columns.some((col) => col.name === "category_id");
    });
    expect(categoryFk).toBeDefined();
    const ref = categoryFk!.reference();
    expect(getTableName(ref.foreignTable)).toBe("tenant_product_categories");
    // FK to a retired category should not destroy the product; data-model
    // §3 specifies `ON DELETE SET NULL`.
    expect(categoryFk!.onDelete).toBe("set null");
  });

  it("`tax_category` is `text NOT NULL` (Q11 — opaque tax classification)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    // Q11 — tax_category is text on tenant_products and ALWAYS required.
    // (The task brief tagged this Q6 but data-model.md §3 / spec §16
    // anchors it to Q11 / R-5; Q6 is "defer variants".)
    expect(cols["taxCategory"]).toBeDefined();
    expect(cols["taxCategory"]?.name).toBe("tax_category");
    expect(cols["taxCategory"]?.getSQLType()).toBe("text");
    expect(cols["taxCategory"]?.notNull).toBe(true);
  });

  it("`retired_at` is a NULLABLE `timestamptz` soft-delete column (R-3 / PQ-5)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    expect(cols["retiredAt"]).toBeDefined();
    expect(cols["retiredAt"]?.name).toBe("retired_at");
    // Drizzle's `timestamp({ withTimezone: true })` yields
    // `timestamp with time zone` (PostgreSQL synonym for `timestamptz`).
    expect(cols["retiredAt"]?.getSQLType()).toBe("timestamp with time zone");
    expect(cols["retiredAt"]?.notNull).toBe(false);
  });

  it("does NOT declare any product-variant columns in v1 (Q6 — variants deferred)", () => {
    expect(tenantProducts).toBeDefined();
    const cols = getTableColumns(tenantProducts) as Record<string, unknown>;
    // Q6 — data-model.md §11 "Prohibited pre-implementations": variant
    // columns must NOT be added in this feature. They are reserved for the
    // future variants feature specification.
    expect(cols["parentProductId"]).toBeUndefined();
    expect(cols["variantGroupId"]).toBeUndefined();
    expect(cols["variantAttributes"]).toBeUndefined();
    // Defensive check on SQL column names too (in case Drizzle key naming
    // ever diverges from snake_case for new columns).
    const sqlNames = Object.values(cols).map(
      (c) => (c as { name: string }).name,
    );
    expect(sqlNames).not.toContain("parent_product_id");
    expect(sqlNames).not.toContain("variant_group_id");
    expect(sqlNames).not.toContain("variant_attributes");
  });
});
