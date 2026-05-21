/**
 * T319 — `tenant_product_categories` Drizzle schema shape (RED).
 *
 * This test is authored BEFORE the catalog schema files exist (T320 is
 * `[GATED]` and has not run yet). The future schema file
 * `packages/db/src/schema/catalog/tenant-product-categories.ts` must be
 * re-exported by the schema barrel (T331) and satisfy the assertions below.
 *
 * Source of truth for column shape: `specs/003-catalog-foundation/data-model.md`
 * §4 (`tenant_product_categories`).
 *
 * Q-coverage anchors (spec §16):
 *   - Q7 → flat (non-hierarchical) category taxonomy. There must be NO
 *          `parent_id` column. The unique constraint on `(tenant_id, name)`
 *          is a partial unique index filtered by `retired_at IS NULL`, so
 *          a retired category does not block re-use of the same name.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "../../../src/schema";

type DrizzleTable = Parameters<typeof getTableConfig>[0];

interface SchemaShape {
  tenantProductCategories?: DrizzleTable;
}

const s = schema as unknown as SchemaShape;
const tenantProductCategories = s.tenantProductCategories as DrizzleTable;

/**
 * Render a Drizzle SQL fragment to a comparable Postgres string. Drizzle
 * 0.45.x exposes `PgDialect.sqlToQuery()` for this purpose. We extract just
 * the `sql` text since the `WHERE` predicate has no driver parameters.
 *
 * `PgDialect` emits quoted identifiers like `"tenant_product_categories"."retired_at"`,
 * which breaks simple regexes that expect `\s+` between a column name and an
 * operator. We strip the double quotes for assertion purposes only — the
 * structural shape (token order, operators, NULL/NOT NULL) is what these
 * tests are verifying, not the rendering convention.
 */
function renderSql(sql: import("drizzle-orm").SQL): string {
  const dialect = new PgDialect();
  return normalizeRenderedSql(dialect.sqlToQuery(sql).sql);
}

function normalizeRenderedSql(sql: string): string {
  return sql.replaceAll('"', "");
}

describe("schema/catalog/tenant_product_categories (T319)", () => {
  it("is exported from the schema barrel", () => {
    // RED: future schema not yet authored (T320 gated).
    expect(s.tenantProductCategories).toBeDefined();
  });

  it("is named `tenant_product_categories` at the SQL layer", () => {
    expect(tenantProductCategories).toBeDefined();
    expect(getTableName(tenantProductCategories)).toBe(
      "tenant_product_categories",
    );
  });

  it("`tenant_id` column exists and is NOT NULL (Constitution §2)", () => {
    expect(tenantProductCategories).toBeDefined();
    const cols = getTableColumns(tenantProductCategories) as Record<
      string,
      { name: string; notNull: boolean; getSQLType: () => string }
    >;
    expect(cols["tenantId"]).toBeDefined();
    expect(cols["tenantId"]?.name).toBe("tenant_id");
    expect(cols["tenantId"]?.getSQLType()).toBe("uuid");
    expect(cols["tenantId"]?.notNull).toBe(true);
  });

  it("`name` column exists and is NOT NULL", () => {
    expect(tenantProductCategories).toBeDefined();
    const cols = getTableColumns(tenantProductCategories) as Record<
      string,
      { name: string; notNull: boolean; getSQLType: () => string }
    >;
    expect(cols["name"]).toBeDefined();
    expect(cols["name"]?.name).toBe("name");
    expect(cols["name"]?.getSQLType()).toBe("text");
    expect(cols["name"]?.notNull).toBe(true);
  });

  it("does NOT declare a `parent_id` column (Q7 — flat categories, no hierarchy)", () => {
    expect(tenantProductCategories).toBeDefined();
    const cols = getTableColumns(tenantProductCategories) as Record<
      string,
      { name: string }
    >;
    // Q7 — data-model.md §4 "Why there is no `parent_id` (Q7)": a hierarchical
    // tree is deferred from v1. `parent_id` must not be added until the
    // tree-categories feature is specified and gated. Its absence is
    // intentional, not an oversight.
    expect(cols["parentId"]).toBeUndefined();
    const sqlNames = Object.values(cols).map((c) => c.name);
    expect(sqlNames).not.toContain("parent_id");
    expect(sqlNames).not.toContain("parent_category_id");
  });

  it("`retired_at` is a NULLABLE `timestamptz` soft-delete column (R-3 / PQ-5)", () => {
    expect(tenantProductCategories).toBeDefined();
    const cols = getTableColumns(tenantProductCategories) as Record<
      string,
      { name: string; getSQLType: () => string; notNull: boolean }
    >;
    expect(cols["retiredAt"]).toBeDefined();
    expect(cols["retiredAt"]?.name).toBe("retired_at");
    expect(cols["retiredAt"]?.getSQLType()).toBe("timestamp with time zone");
    expect(cols["retiredAt"]?.notNull).toBe(false);
  });

  it("declares a partial UNIQUE index on `(tenant_id, name) WHERE retired_at IS NULL` (Q7 — active-name uniqueness)", () => {
    expect(tenantProductCategories).toBeDefined();
    const cfg = getTableConfig(tenantProductCategories);

    // data-model.md §4 — partial unique index
    // `UQ_idx_tenant_product_categories_tenant_name` on `(tenant_id, name)`
    // `WHERE retired_at IS NULL`. The active-name uniqueness rule means a
    // retired category does not block re-use of the same name.
    const partialUniqueIdx = cfg.indexes.find((idx) => {
      if (!idx.config.unique) return false;
      const colNames = idx.config.columns
        .map((c) => (c as { name?: string }).name)
        .filter((n): n is string => typeof n === "string");
      const hasTenantAndName =
        colNames.includes("tenant_id") && colNames.includes("name");
      if (!hasTenantAndName) return false;
      if (!idx.config.where) return false;
      const whereSql = renderSql(idx.config.where);
      return /retired_at\s+IS\s+NULL/i.test(whereSql);
    });

    expect(partialUniqueIdx).toBeDefined();

    // Tighten — confirm the index column ORDER is (tenant_id, name) and
    // that no extra columns sneak in.
    const idxColNames = partialUniqueIdx!.config.columns
      .map((c) => (c as { name?: string }).name)
      .filter((n): n is string => typeof n === "string");
    expect(idxColNames).toEqual(["tenant_id", "name"]);
    expect(partialUniqueIdx!.config.unique).toBe(true);
    const whereSql = renderSql(partialUniqueIdx!.config.where!);
    expect(whereSql).toMatch(/retired_at\s+IS\s+NULL/i);
  });
});
