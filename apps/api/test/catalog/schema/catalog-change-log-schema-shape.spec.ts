/**
 * apps/api/test/catalog/schema/catalog-change-log-schema-shape.spec.ts
 *
 * Slice 010-SCHEMA (T012) — Drizzle schema-shape test for catalog_change_log.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in `packages/db/__tests__/migration/0015-pos-catalog-read-down.spec.ts`.
 * It introspects the Drizzle table object exported from `@data-pulse-2/db/schema`
 * and asserts the data-model.md §3 column inventory (R1/R9):
 *   - the single monotonic `sequence` (bigint, PK);
 *   - `tenant_id` NOT NULL (cursor + RLS scope);
 *   - `store_id` NULLABLE (NULL = tenant-wide sentinel event — R9);
 *   - `product_id` NOT NULL (provenance);
 *   - `op` (the upsert | remove_from_sellable signal);
 *   - `occurred_at` (diagnostics only);
 *   - the (tenant_id, sequence) delta-read index;
 *   - load-bearing NEGATIVES: NO payload column (the resolved row is computed at
 *     read, not stored — R9), NO `version` column (append-only).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`catalogChangeLog` not yet exported) — the intended T012 RED. Once
 * T013 lands the schema + barrel re-export, the import resolves and assertions
 * pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new export
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { catalogChangeLog } from "@data-pulse-2/db/schema";

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  columnType: string;
};

function columns(table: unknown): Map<string, ColumnInfo> {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  const out = new Map<string, ColumnInfo>();
  for (const col of cfg.columns) {
    const c = col as unknown as {
      name: string;
      notNull: boolean;
      dataType: string;
      columnType: string;
    };
    out.set(c.name, {
      name: c.name,
      notNull: c.notNull,
      dataType: c.dataType,
      columnType: c.columnType,
    });
  }
  return out;
}

function indexNames(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.indexes.map(
    (ix) => (ix as { config?: { name?: string } }).config?.name ?? "",
  );
}

// ===========================================================================
// catalog_change_log — the append-only read-down change-log (data-model.md §3)
// ===========================================================================
describe("catalog read-down schema shape — catalog_change_log", () => {
  const cols = columns(catalogChangeLog);

  it("carries the data-model.md §3 column inventory", () => {
    for (const name of [
      "sequence",
      "tenant_id",
      "store_id",
      "product_id",
      "op",
      "occurred_at",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("sequence is the bigint PK monotonic cursor (R9)", () => {
    const c = cols.get("sequence");
    // mode: "bigint" → PgBigInt64 (full 64-bit; never loses precision at high
    // sequence values, unlike PgBigInt53 / mode "number").
    expect(c?.columnType).toBe("PgBigInt64");
    expect(c?.notNull).toBe(true);
  });

  it("tenant_id is NOT NULL (cursor + RLS scope)", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
  });

  it("store_id is NULLABLE — NULL = tenant-wide (sentinel) event (R9)", () => {
    const c = cols.get("store_id");
    expect(c).toBeDefined();
    expect(c?.notNull).toBe(false);
  });

  it("product_id is NOT NULL (provenance — resolved payload computed at read)", () => {
    expect(cols.get("product_id")?.notNull).toBe(true);
  });

  it("op is a NOT NULL text signal (upsert | remove_from_sellable)", () => {
    const c = cols.get("op");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgText");
  });

  it("has the (tenant_id, sequence) delta-read index (R9)", () => {
    expect(indexNames(catalogChangeLog)).toContain(
      "idx_catalog_change_log_tenant_sequence",
    );
  });

  it("stores NO resolved payload — the row is computed at read time (R9)", () => {
    // Load-bearing negative: the change-log carries only product_id + op, never
    // price / name / sku / aliases. Write-time fan-out pre-resolves nothing.
    for (const forbidden of [
      "price",
      "amount",
      "currency_code",
      "name",
      "sku",
      "aliases",
      "tax_category",
      "payload",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });

  it("has NO `version` column (append-only change-log)", () => {
    expect(cols.has("version")).toBe(false);
  });
});
