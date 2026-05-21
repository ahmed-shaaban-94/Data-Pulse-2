/**
 * T322 — Drizzle schema shape: `product_aliases`.
 *
 * RED-failing schema-shape tests for the future `productAliases` Drizzle
 * table. The schema module does not exist yet (T320 gated); these tests
 * intentionally fail at import time until the schema is authored.
 *
 * Source of truth: specs/003-catalog-foundation/data-model.md §6.
 *
 * Q-binding asserted here:
 *   - Q4 — identifier-type-specific alias uniqueness is enforced by THREE
 *          partial unique indexes (tenant-wide / external_pos_id /
 *          store-scoped). See data-model.md §6.
 */
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { Index } from "drizzle-orm/pg-core";

import { productAliases } from "../../../src/schema/catalog/product-aliases";

const dialect = new PgDialect();

/**
 * `PgDialect.sqlToQuery` emits PostgreSQL with quoted identifiers
 * (e.g. `"product_aliases"."source_system" is null`). Strip the double
 * quotes for assertion matching so simple `\s+` regexes still work —
 * we are verifying the structural shape of the predicate, not the
 * rendering convention.
 */
function normalizeRenderedSql(sql: string): string {
  return sql.replaceAll('"', "");
}

function renderCheckValue(value: import("drizzle-orm").SQL): string {
  return normalizeRenderedSql(dialect.sqlToQuery(value).sql);
}

function findColumn(name: string) {
  const cfg = getTableConfig(productAliases);
  return cfg.columns.find((c) => c.name === name);
}

function findIndex(name: string): Index | undefined {
  const cfg = getTableConfig(productAliases);
  return cfg.indexes.find((i) => i.config.name === name);
}

function renderWhere(idx: Index): string {
  if (!idx.config.where) {
    throw new Error(
      `Index ${idx.config.name ?? "<unnamed>"} has no WHERE clause — partial uniqueness lost.`,
    );
  }
  return normalizeRenderedSql(dialect.sqlToQuery(idx.config.where).sql);
}

function indexColumnNames(idx: Index): string[] {
  return idx.config.columns.map((c) => {
    // IndexedColumn instances carry .name; SQL chunks would not — but the
    // partial-UQ indexes in data-model.md §6 use plain columns only.
    const anyCol = c as { name?: unknown };
    if (typeof anyCol.name === "string") return anyCol.name;
    throw new Error(
      "Encountered a non-column entry in index columns; partial-UQ indexes are expected to use plain columns.",
    );
  });
}

describe("schema/product_aliases — T322 / Q4 identifier-type-scoped uniqueness", () => {
  it("is registered as the SQL table `product_aliases`", () => {
    const cfg = getTableConfig(productAliases);
    expect(cfg.name).toBe("product_aliases");
  });

  // ---------------------------------------------------------------------------
  // Column shape per data-model.md §6.
  // ---------------------------------------------------------------------------
  it("requires NOT NULL tenant_id", () => {
    const col = findColumn("tenant_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toMatch(/^uuid$/i);
  });

  it("declares product_id (FK to tenant_products) NOT NULL", () => {
    const col = findColumn("product_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toMatch(/^uuid$/i);

    const fks = getTableConfig(productAliases).foreignKeys;
    const productFk = fks.find((fk) =>
      fk.reference().foreignTable
        ? getTableConfig(fk.reference().foreignTable).name === "tenant_products"
        : false,
    );
    expect(productFk).toBeDefined();
  });

  it("declares identifier_type as a NOT NULL constrained text column", () => {
    const col = findColumn("identifier_type");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    // data-model.md §6: `identifier_type text NOT NULL` with a CHK constraint
    // restricting values to {barcode, sku, plu, supplier_code, external_pos_id}.
    expect(col?.getSQLType()).toMatch(/^text$/i);

    const checks = getTableConfig(productAliases).checks;
    const typeCheck = checks.find(
      (c) =>
        c.name === "product_aliases_identifier_type_valid" ||
        /identifier_type/i.test(c.name),
    );
    expect(typeCheck).toBeDefined();
    const rendered = renderCheckValue(typeCheck!.value).toLowerCase();
    expect(rendered).toMatch(/'barcode'/);
    expect(rendered).toMatch(/'sku'/);
    expect(rendered).toMatch(/'plu'/);
    expect(rendered).toMatch(/'supplier_code'/);
    expect(rendered).toMatch(/'external_pos_id'/);
  });

  it("declares value as a NOT NULL text column", () => {
    const col = findColumn("value");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.getSQLType()).toMatch(/^text$/i);
  });

  it("declares source_system as a nullable text column required only for external_pos_id rows", () => {
    const col = findColumn("source_system");
    expect(col).toBeDefined();
    // data-model.md §6: `source_system text NULL`; the requirement for
    // external_pos_id is enforced by `CHK product_aliases_source_system_required`.
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toMatch(/^text$/i);

    const checks = getTableConfig(productAliases).checks;
    const srcCheck = checks.find(
      (c) =>
        c.name === "product_aliases_source_system_required" ||
        /source_system/i.test(c.name),
    );
    expect(srcCheck).toBeDefined();
    const rendered = renderCheckValue(srcCheck!.value).toLowerCase();
    expect(rendered).toMatch(/identifier_type/);
    expect(rendered).toMatch(/'external_pos_id'/);
    expect(rendered).toMatch(/source_system\s+is\s+(?:not\s+)?null/);
  });

  it("declares store_id as a nullable uuid (tenant-wide aliases allowed)", () => {
    const col = findColumn("store_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.getSQLType()).toMatch(/^uuid$/i);
  });

  it("declares retired_at as a nullable timestamptz (soft-deactivation)", () => {
    const col = findColumn("retired_at");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    // data-model.md §1: `timestamptz NULL` for soft-delete.
    expect(col?.getSQLType()).toMatch(/timestamp\s+with\s+time\s+zone/i);
  });

  // ---------------------------------------------------------------------------
  // Q4 — three partial unique indexes
  // ---------------------------------------------------------------------------

  it("declares `UQ_idx_product_aliases_tenant_wide` as a partial unique index on (tenant_id, identifier_type, value) for non-POS tenant-wide rows", () => {
    // Q4 — Index 1: tenant-wide barcode/sku/etc uniqueness.
    const idx = findIndex("UQ_idx_product_aliases_tenant_wide");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(indexColumnNames(idx!)).toEqual(["tenant_id", "identifier_type", "value"]);

    const where = renderWhere(idx!).toLowerCase();
    // data-model.md §6 Index 1 WHERE:
    //   store_id IS NULL AND identifier_type <> 'external_pos_id' AND retired_at IS NULL
    expect(where).toMatch(/store_id\s+is\s+null/);
    expect(where).toMatch(/identifier_type\s*<>\s*'external_pos_id'/);
    expect(where).toMatch(/retired_at\s+is\s+null/);
  });

  it("declares `UQ_idx_product_aliases_external_pos_id` as a partial unique index on (tenant_id, source_system, value) for external_pos_id rows", () => {
    // Q4 — Index 2: external POS id uniqueness scoped by source_system.
    const idx = findIndex("UQ_idx_product_aliases_external_pos_id");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(indexColumnNames(idx!)).toEqual(["tenant_id", "source_system", "value"]);

    const where = renderWhere(idx!).toLowerCase();
    // data-model.md §6 Index 2 WHERE:
    //   identifier_type = 'external_pos_id' AND retired_at IS NULL
    expect(where).toMatch(/identifier_type\s*=\s*'external_pos_id'/);
    expect(where).toMatch(/retired_at\s+is\s+null/);
  });

  it("declares `UQ_idx_product_aliases_store_scoped` as a partial unique index on (tenant_id, store_id, identifier_type, value) for store-scoped rows", () => {
    // Q4 — Index 3: store-scoped alias uniqueness.
    const idx = findIndex("UQ_idx_product_aliases_store_scoped");
    expect(idx).toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(indexColumnNames(idx!)).toEqual([
      "tenant_id",
      "store_id",
      "identifier_type",
      "value",
    ]);

    const where = renderWhere(idx!).toLowerCase();
    // data-model.md §6 Index 3 WHERE:
    //   store_id IS NOT NULL AND retired_at IS NULL
    expect(where).toMatch(/store_id\s+is\s+not\s+null/);
    expect(where).toMatch(/retired_at\s+is\s+null/);
  });
});
