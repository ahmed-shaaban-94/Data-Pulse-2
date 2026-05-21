/**
 * T321 — Drizzle schema shape: `store_product_overrides`.
 *
 * RED-failing schema-shape tests for the future `storeProductOverrides`
 * Drizzle table. The schema module does not exist yet (T320 gated); these
 * tests intentionally fail at import time until the schema is authored.
 *
 * Source of truth: specs/003-catalog-foundation/data-model.md §5.
 *
 * Q-bindings asserted here:
 *   - Q1  — monetary values are `numeric(19,4)`; never floating point.
 *   - Q2  — currency code is `char(3)`; `NULL` only when no price is stored.
 *   - Q8  — overrideable fields in v1 are limited to price, currency_code,
 *           is_active, tax_category (no name, no category_id).
 *   - Q11 — CHK enforces price/currency are both NULL or both NOT NULL.
 */
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { Check } from "drizzle-orm/pg-core";

import { storeProductOverrides } from "../../../src/schema/catalog/store-product-overrides";

const dialect = new PgDialect();

/**
 * `PgDialect.sqlToQuery` emits PostgreSQL with quoted identifiers
 * (e.g. `"store_product_overrides"."price" is null`). Strip the double
 * quotes for assertion matching so simple `\s+` regexes still work —
 * we are verifying the structural shape of the predicate, not the
 * rendering convention.
 */
function normalizeRenderedSql(sql: string): string {
  return sql.replaceAll('"', "");
}

function renderCheck(check: Check): string {
  return normalizeRenderedSql(dialect.sqlToQuery(check.value).sql);
}

function findColumn(name: string) {
  const cfg = getTableConfig(storeProductOverrides);
  return cfg.columns.find((c) => c.name === name);
}

describe("schema/store_product_overrides — T321 / Q8 overrideable-field whitelist", () => {
  it("is registered as the SQL table `store_product_overrides`", () => {
    const cfg = getTableConfig(storeProductOverrides);
    expect(cfg.name).toBe("store_product_overrides");
  });

  // ---------------------------------------------------------------------------
  // Tenant + store scoping (Constitution §2 / §12)
  // ---------------------------------------------------------------------------
  it("requires NOT NULL tenant_id", () => {
    const col = findColumn("tenant_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    // tenant_id is uuid per data-model.md §5.
    expect(col?.getSQLType()).toMatch(/^uuid$/i);
  });

  it("requires NOT NULL store_id", () => {
    const col = findColumn("store_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toMatch(/^uuid$/i);
  });

  it("declares product_id (FK to tenant_products)", () => {
    const col = findColumn("product_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toMatch(/^uuid$/i);

    const fks = getTableConfig(storeProductOverrides).foreignKeys;
    const productFk = fks.find((fk) =>
      fk.reference().foreignTable
        ? getTableConfig(fk.reference().foreignTable).name === "tenant_products"
        : false,
    );
    expect(productFk).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Overrideable-field whitelist (Q8): only price, currency_code, is_active,
  // tax_category. NO `name`, NO `category_id`.
  // ---------------------------------------------------------------------------
  it("forbids a `name` column at the store-override layer", () => {
    // Q8 — product name is not overrideable at the store layer.
    expect(findColumn("name")).toBeUndefined();
  });

  it("forbids a `category_id` column at the store-override layer", () => {
    // Q8 — category is not overrideable at the store layer.
    expect(findColumn("category_id")).toBeUndefined();
  });

  it("exposes exactly the four overrideable fields: price, currency_code, is_active, tax_category", () => {
    // Q8 — overrideable fields in v1 are exactly these four.
    expect(findColumn("price")).toBeDefined();
    expect(findColumn("currency_code")).toBeDefined();
    expect(findColumn("is_active")).toBeDefined();
    expect(findColumn("tax_category")).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Q1 — monetary type
  // ---------------------------------------------------------------------------
  it("declares `price` as numeric(19,4) and nullable (NULL = inherit)", () => {
    const col = findColumn("price"); // Q1
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    // numeric(precision, scale) per Q1; case-insensitive to tolerate
    // Drizzle's casing of the SQL type.
    expect(col?.getSQLType()).toMatch(/^numeric\s*\(\s*19\s*,\s*4\s*\)$/i);
  });

  // ---------------------------------------------------------------------------
  // Q2 — currency code type and nullability
  // ---------------------------------------------------------------------------
  it("declares `currency_code` as char(3) and nullable", () => {
    const col = findColumn("currency_code"); // Q2
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    // Q2 / Q11 — char(3) when present; nullable only when no price is stored.
    expect(col?.getSQLType()).toMatch(/^char\s*\(\s*3\s*\)$/i);
  });

  // ---------------------------------------------------------------------------
  // Q11 — price/currency pairing CHK constraint
  // ---------------------------------------------------------------------------
  it("enforces a CHK that price and currency_code are both NULL or both NOT NULL", () => {
    const checks = getTableConfig(storeProductOverrides).checks; // Q11
    const pairedCheck = checks.find(
      (c) =>
        c.name === "store_product_overrides_currency_paired" ||
        /currency.*paired/i.test(c.name),
    );
    expect(pairedCheck).toBeDefined();

    const rendered = renderCheck(pairedCheck!).toLowerCase();
    // Both halves of the pair must be expressed: "price IS NULL AND currency_code IS NULL"
    // OR "price IS NOT NULL AND currency_code IS NOT NULL". Tolerate
    // whitespace and ordering variations; the substantive constraint is
    // that both columns appear with paired NULL/NOT NULL tests.
    expect(rendered).toMatch(/price\s+is\s+null/);
    expect(rendered).toMatch(/price\s+is\s+not\s+null/);
    expect(rendered).toMatch(/currency_code\s+is\s+null/);
    expect(rendered).toMatch(/currency_code\s+is\s+not\s+null/);
  });

  // ---------------------------------------------------------------------------
  // tax_category — NULL means inherit (Q8 / Q11)
  // ---------------------------------------------------------------------------
  it("declares `tax_category` as text and nullable (NULL = inherit tenant default)", () => {
    const col = findColumn("tax_category");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toMatch(/^text$/i);
  });

  // ---------------------------------------------------------------------------
  // is_active — nullable (NULL = inherit) per Q8
  // ---------------------------------------------------------------------------
  it("declares `is_active` as boolean and nullable", () => {
    const col = findColumn("is_active");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toMatch(/^boolean$/i);
  });
});
