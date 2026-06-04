/**
 * apps/api/test/catalog/schema/erpnext-item-map-schema-shape.spec.ts
 *
 * Slice 013-SCHEMA (T012a) — Drizzle schema-shape test for erpnext_item_map.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in `packages/db/__tests__/migration/0017-erpnext-item-map.spec.ts`.
 * It introspects the Drizzle table object exported from `@data-pulse-2/db/schema`
 * and asserts the 013 data-model.md §2 column inventory + the load-bearing
 * NEGATIVES (no UOM / price / store column — OQ-3/OQ-4 resolved as no-column).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to even
 * import (`erpnextItemMap` not yet exported) — the intended T012a RED. Once the
 * schema + barrel re-export land, the import resolves and assertions pass.
 *
 * Note: `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so
 * the db package must be built before this spec sees the new export
 * (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { erpnextItemMap } from "@data-pulse-2/db/schema";

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
// erpnext_item_map — the product-master identity mapping (data-model.md §2)
// ===========================================================================
describe("product-master schema shape — erpnext_item_map", () => {
  const cols = columns(erpnextItemMap);

  it("carries the data-model.md §2 column inventory", () => {
    for (const name of [
      "id",
      "tenant_id",
      "tenant_product_id",
      "erpnext_item_ref",
      "state",
      "suggestion_source",
      "suggested_by",
      "suggested_at",
      "confirmed_by",
      "confirmed_at",
      "version",
      "retired_at",
      "created_at",
      "updated_at",
      "correlation_id",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  it("tenant_id + tenant_product_id are NOT NULL (scope + the 1:1 mapped product)", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("tenant_product_id")?.notNull).toBe(true);
  });

  it("erpnext_item_ref is a NOT NULL text reference (DP2-terms, version-independent — no FK)", () => {
    const c = cols.get("erpnext_item_ref");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgText");
  });

  it("state defaults to 'suggested' (NOT NULL) — the suggest→confirm lifecycle", () => {
    const c = cols.get("state");
    expect(c?.notNull).toBe(true);
    expect(c?.hasDefault).toBe(true);
  });

  it("confirmed_by + confirmed_at are NULLABLE (paired with state by the DB CHECK)", () => {
    expect(cols.get("confirmed_by")?.notNull).toBe(false);
    expect(cols.get("confirmed_at")?.notNull).toBe(false);
  });

  it("version is a NOT NULL integer (§III optimistic-concurrency token)", () => {
    const c = cols.get("version");
    expect(c?.notNull).toBe(true);
    expect(c?.columnType).toBe("PgInteger");
    expect(c?.hasDefault).toBe(true);
  });

  it("has the 1:1 active-mapping unique + the review-queue + reverse-lookup indexes", () => {
    const ix = indexNames(erpnextItemMap);
    expect(ix).toContain("UQ_idx_erpnext_item_map_active");
    expect(ix).toContain("idx_erpnext_item_map_unconfirmed");
    expect(ix).toContain("idx_erpnext_item_map_item_ref");
  });

  it("stores NO UOM / price / price-list / store column (OQ-3/OQ-4 resolved as no-column)", () => {
    // Load-bearing negatives: identity-only table. UOM is a connector/015
    // concern; DP2 amounts stay authoritative (no ERPNext repricing); the
    // mapping is tenant-wide (no store axis — data-model §6).
    for (const forbidden of [
      "uom",
      "unit",
      "conversion_factor",
      "price",
      "amount",
      "currency_code",
      "price_list",
      "price_list_ref",
      "store_id",
    ]) {
      expect(cols.has(forbidden)).toBe(false);
    }
  });
});
