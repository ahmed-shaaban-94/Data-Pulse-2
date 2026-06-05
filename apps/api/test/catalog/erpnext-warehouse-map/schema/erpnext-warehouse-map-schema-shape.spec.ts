/**
 * apps/api/test/catalog/erpnext-warehouse-map/schema/erpnext-warehouse-map-schema-shape.spec.ts
 *
 * Slice 014-SCHEMA (T012a) — Drizzle schema-shape test for erpnext_warehouse_map.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in
 * `packages/db/__tests__/migration/0018-erpnext-warehouse-map.spec.ts`. It
 * introspects the Drizzle table object exported from `@data-pulse-2/db/schema`
 * and asserts the 014 data-model.md §2 column inventory + the load-bearing
 * NEGATIVES (no Bin-quantity / valuation / on-hand column — OQ-1, the rejected
 * read-down look-alike).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`erpnextWarehouseMap` not yet exported) — the intended T012a RED.
 * Once the schema + barrel re-export land, the import resolves and assertions
 * pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new export
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { erpnextWarehouseMap } from "@data-pulse-2/db/schema";

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  columnType: string;
  hasDefault: boolean;
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
      hasDefault: boolean;
    };
    out.set(c.name, {
      name: c.name,
      notNull: c.notNull,
      dataType: c.dataType,
      columnType: c.columnType,
      hasDefault: c.hasDefault,
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
// erpnext_warehouse_map — the store↔warehouse mapping (data-model.md §2)
// ===========================================================================
describe("warehouse-map schema shape — erpnext_warehouse_map", () => {
  const cols = columns(erpnextWarehouseMap);

  it("carries the data-model.md §2 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "store_id",
      "purpose",
      "erpnext_warehouse_ref",
      "set_by",
      "set_at",
      "version",
      "retired_at",
      "created_at",
      "updated_at",
      "correlation_id",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("tenant_id + store_id are NOT NULL (scope + the mapped store)", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
  });

  it("purpose defaults to 'stock' (NOT NULL) — the OQ-2 forward-compat discriminator", () => {
    const c = cols.get("purpose");
    expect(c?.notNull).toBe(true);
    expect(c?.hasDefault).toBe(true);
  });

  it("erpnext_warehouse_ref is a NOT NULL text reference (DP2-terms, version-independent — no FK)", () => {
    const c = cols.get("erpnext_warehouse_ref");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgText");
  });

  it("version is a NOT NULL integer (§III optimistic-concurrency token)", () => {
    const c = cols.get("version");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgInteger");
    expect(c?.hasDefault).toBe(true);
  });

  it("retired_at is NULLABLE (soft-delete; null = active)", () => {
    expect(cols.get("retired_at")?.notNull).toBe(false);
  });

  it("has the purpose-grain active-mapping unique + the reverse-lookup index", () => {
    const ix = indexNames(erpnextWarehouseMap);
    expect(ix).toContain("UQ_idx_erpnext_warehouse_map_active");
    expect(ix).toContain("idx_erpnext_warehouse_map_ref");
  });

  it("stores NO Bin-quantity / valuation / cost / on-hand column (OQ-1, no read-down mirror)", () => {
    // Load-bearing negatives: mapping-only table. A standing DP2 copy of
    // ERPNext stock is the rejected read-down look-alike (OQ-1); valuation/cost
    // is ERPNext's authority; on-hand is computed-on-read from 009.
    for (const forbidden of [
      "quantity",
      "bin_quantity",
      "qty",
      "on_hand",
      "on_hand_qty",
      "valuation",
      "valuation_rate",
      "cost",
      "stock_value",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });
});
