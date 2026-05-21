/**
 * T324 — Drizzle schema shape test for `unknown_items`.
 *
 * RED-first authoring under TDD. The catalog schema files are gated under
 * T320 and do not yet exist on disk; importing them here is intentional
 * and must fail the suite with a module-resolution error until T320 lands.
 * Once T320 lands, the assertions below must pass exactly as written —
 * they encode the data-model.md §8 contract for `unknown_items`.
 *
 * Contract anchors (data-model.md §8, spec §6.3):
 *   - Q10  Resolution is MANUAL only. No auto-resolve flag, column, or path.
 *          `resolved_by` is the required actor reference; the consistency
 *          CHECK constraint enforces that `resolved_at` and `resolved_by`
 *          are either both NULL (pending) or both NOT NULL (resolved).
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import { unknownItems } from "../../../src/schema/catalog/unknown-items";

const dialect = new PgDialect();

function renderSQL(value: unknown): string {
  if (value == null) return "";
  return dialect.sqlToQuery(value as SQL).sql;
}

describe("unknown_items Drizzle schema (T324)", () => {
  it("maps to the SQL table name 'unknown_items'", () => {
    expect(getTableName(unknownItems)).toBe("unknown_items");
  });

  // ---------------------------------------------------------------------------
  // Column presence + nullability
  // ---------------------------------------------------------------------------
  describe("columns", () => {
    it("declares the documented column set with no extras", () => {
      const cols = getTableColumns(unknownItems);
      // data-model.md §8 documents exactly these columns.
      expect(Object.keys(cols).sort()).toEqual(
        [
          "id",
          "tenantId",
          "storeId",
          "identifierType",
          "value",
          "sourceSystem",
          "encounteredAt",
          "saleContext",
          "resolutionStatus",
          "resolvedAt",
          "resolvedBy",
          "resolutionAction",
          "resolvedProductId",
          "correlationId",
          "createdAt",
        ].sort(),
      );
    });

    it("does NOT declare any auto-resolve flag / column / boolean — Q10 (manual only)", () => {
      // Q10
      const cols = getTableColumns(unknownItems);
      const forbidden = [
        "autoResolve",
        "auto_resolve",
        "autoResolved",
        "auto_resolved",
        "autoCreate",
        "auto_create",
        "autoCreated",
        "auto_created",
        "isAutoResolved",
        "is_auto_resolved",
      ];
      for (const name of forbidden) {
        expect(Object.prototype.hasOwnProperty.call(cols, name)).toBe(false);
      }
    });

    it("id is a NOT NULL uuid primary key", () => {
      const cols = getTableColumns(unknownItems);
      const id = cols["id"]!;
      expect(id.name).toBe("id");
      expect(id.notNull).toBe(true);
      expect(id.primary).toBe(true);
      expect(String(id.columnType).toLowerCase()).toContain("uuid");
    });

    it("tenant_id is uuid NOT NULL", () => {
      const cols = getTableColumns(unknownItems);
      const t = cols["tenantId"]!;
      expect(t.name).toBe("tenant_id");
      expect(t.notNull).toBe(true);
      expect(String(t.columnType).toLowerCase()).toContain("uuid");
    });

    it("store_id is uuid NOT NULL — unknown items are always observed at a specific store", () => {
      const cols = getTableColumns(unknownItems);
      const s = cols["storeId"]!;
      expect(s.name).toBe("store_id");
      expect(s.notNull).toBe(true);
      expect(String(s.columnType).toLowerCase()).toContain("uuid");
    });

    it("identifier_type is text NOT NULL", () => {
      const cols = getTableColumns(unknownItems);
      const it = cols["identifierType"]!;
      expect(it.name).toBe("identifier_type");
      expect(it.notNull).toBe(true);
      expect(String(it.columnType).toLowerCase()).toContain("text");
    });

    it("value is text NOT NULL (the observed identifier value)", () => {
      const cols = getTableColumns(unknownItems);
      const v = cols["value"]!;
      expect(v.name).toBe("value");
      expect(v.notNull).toBe(true);
      expect(String(v.columnType).toLowerCase()).toContain("text");
    });

    it("source_system is text NULL — required only when identifier_type='external_pos_id'", () => {
      const cols = getTableColumns(unknownItems);
      const ss = cols["sourceSystem"]!;
      expect(ss.name).toBe("source_system");
      // Nullable at the column level; the CHECK constraint
      // `unknown_items_source_system_required` enforces presence conditional
      // on identifier_type.
      expect(ss.notNull).toBe(false);
      expect(String(ss.columnType).toLowerCase()).toContain("text");
    });

    it("encountered_at is timestamptz NOT NULL with default now()", () => {
      const cols = getTableColumns(unknownItems);
      const e = cols["encounteredAt"]!;
      expect(e.name).toBe("encountered_at");
      expect(e.notNull).toBe(true);
      expect(e.hasDefault).toBe(true);
      const colType = String(e.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = e as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });

    it("sale_context is jsonb NULL (opaque POS context snapshot — redacted at logger boundaries)", () => {
      const cols = getTableColumns(unknownItems);
      const sc = cols["saleContext"]!;
      expect(sc.name).toBe("sale_context");
      expect(sc.notNull).toBe(false);
      expect(String(sc.columnType).toLowerCase()).toContain("json");
    });

    it("resolution_status is text NOT NULL with default 'pending'", () => {
      const cols = getTableColumns(unknownItems);
      const rs = cols["resolutionStatus"]!;
      expect(rs.name).toBe("resolution_status");
      expect(rs.notNull).toBe(true);
      expect(rs.hasDefault).toBe(true);
      expect(String(rs.columnType).toLowerCase()).toContain("text");
    });

    it("resolved_at is timestamptz NULL — NULL until manual resolution — Q10", () => {
      // Q10
      const cols = getTableColumns(unknownItems);
      const ra = cols["resolvedAt"]!;
      expect(ra.name).toBe("resolved_at");
      expect(ra.notNull).toBe(false);
      const colType = String(ra.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = ra as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });

    it("resolved_by is uuid NULL — actor reference; CHECK couples it to resolved_at — Q10", () => {
      // Q10
      const cols = getTableColumns(unknownItems);
      const rb = cols["resolvedBy"]!;
      expect(rb.name).toBe("resolved_by");
      // Column nullability is NULL at rest; the CHECK constraint
      // `unknown_items_resolved_fields_consistent` enforces that whenever
      // resolved_at IS NOT NULL, resolved_by IS NOT NULL also. Manual
      // resolution is required (Q10) — no auto-resolve path may set
      // resolved_at without setting resolved_by.
      expect(rb.notNull).toBe(false);
      expect(String(rb.columnType).toLowerCase()).toContain("uuid");
    });

    it("resolution_action is text NULL — one of 'linked' / 'created' / 'dismissed' when set — Q10", () => {
      // Q10
      const cols = getTableColumns(unknownItems);
      const ra = cols["resolutionAction"]!;
      expect(ra.name).toBe("resolution_action");
      expect(ra.notNull).toBe(false);
      expect(String(ra.columnType).toLowerCase()).toContain("text");
    });

    it("resolved_product_id is uuid NULL — FK to tenant_products when linked/created", () => {
      const cols = getTableColumns(unknownItems);
      const rp = cols["resolvedProductId"]!;
      expect(rp.name).toBe("resolved_product_id");
      expect(rp.notNull).toBe(false);
      expect(String(rp.columnType).toLowerCase()).toContain("uuid");
    });

    it("correlation_id is uuid NOT NULL (links to the original lookup request)", () => {
      const cols = getTableColumns(unknownItems);
      const ci = cols["correlationId"]!;
      expect(ci.name).toBe("correlation_id");
      expect(ci.notNull).toBe(true);
      expect(String(ci.columnType).toLowerCase()).toContain("uuid");
    });

    it("created_at is timestamptz NOT NULL with default now()", () => {
      const cols = getTableColumns(unknownItems);
      const ca = cols["createdAt"]!;
      expect(ca.name).toBe("created_at");
      expect(ca.notNull).toBe(true);
      expect(ca.hasDefault).toBe(true);
      const colType = String(ca.columnType).toLowerCase();
      expect(colType).toContain("timestamp");
      const col = ca as unknown as { withTimezone?: boolean };
      expect(col.withTimezone).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Foreign keys (composition only)
  // ---------------------------------------------------------------------------
  describe("foreign keys", () => {
    it("declares FKs from tenant_id, store_id, and resolved_product_id", () => {
      const cfg = getTableConfig(unknownItems);
      const fkRefs = cfg.foreignKeys.map((fk) => {
        const ref = fk.reference();
        return getTableName(ref.foreignTable);
      });
      // Three FKs expected: tenants, stores, tenant_products (resolved link).
      expect(fkRefs.sort()).toEqual(
        ["stores", "tenant_products", "tenants"].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints (data-model §8)
  // ---------------------------------------------------------------------------
  describe("check constraints", () => {
    it("declares unknown_items_identifier_type_valid", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_identifier_type_valid",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      // Predicate must enumerate the documented set.
      for (const t of [
        "barcode",
        "sku",
        "plu",
        "supplier_code",
        "external_pos_id",
      ]) {
        expect(expr).toContain(t);
      }
    });

    it("declares unknown_items_value_length (1..200)", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find((c) => c.name === "unknown_items_value_length");
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("length");
      expect(expr).toContain("value");
      expect(expr).toContain("200");
    });

    it("declares unknown_items_resolution_status_valid — pending/resolved/dismissed", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_resolution_status_valid",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("pending");
      expect(expr).toContain("resolved");
      expect(expr).toContain("dismissed");
    });

    it("declares unknown_items_resolution_action_valid — NULL or linked/created/dismissed", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_resolution_action_valid",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("linked");
      expect(expr).toContain("created");
      expect(expr).toContain("dismissed");
    });

    it("declares unknown_items_resolved_fields_consistent — resolved_at and resolved_by are paired — Q10", () => {
      // Q10
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_resolved_fields_consistent",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      // The predicate must reference resolved_at and resolved_by together so
      // resolution cannot record `resolved_at` without `resolved_by` (Q10:
      // resolution is manual — a human actor must always be recorded).
      expect(expr).toContain("resolved_at");
      expect(expr).toContain("resolved_by");
      expect(expr).toContain("resolution_status");
      expect(expr).toContain("resolution_action");
      expect(expr).toContain("pending");
    });

    it("declares unknown_items_linked_product_present — resolved_product_id presence matches action", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_linked_product_present",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("resolved_product_id");
      expect(expr).toContain("linked");
      expect(expr).toContain("created");
      expect(expr).toContain("dismissed");
    });

    it("declares unknown_items_source_system_required — source_system iff external_pos_id", () => {
      const cfg = getTableConfig(unknownItems);
      const ck = cfg.checks.find(
        (c) => c.name === "unknown_items_source_system_required",
      );
      expect(ck).toBeDefined();
      const expr = renderSQL((ck as unknown as { value: unknown }).value).toLowerCase();
      expect(expr).toContain("source_system");
      expect(expr).toContain("external_pos_id");
    });
  });

  // ---------------------------------------------------------------------------
  // Indexes (data-model §8)
  // ---------------------------------------------------------------------------
  describe("indexes", () => {
    it("declares idx_unknown_items_pending — partial on resolution_status='pending'", () => {
      const cfg = getTableConfig(unknownItems);
      const idx = cfg.indexes.find(
        (i) => i.config.name === "idx_unknown_items_pending",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
        where?: unknown;
      };
      expect(config.unique).toBeFalsy();
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "store_id",
      ]);
      const whereStr = renderSQL(config.where).toLowerCase();
      expect(whereStr).toContain("resolution_status");
      expect(whereStr).toContain("pending");
    });

    it("declares idx_unknown_items_lookup_value — partial on pending, scoped by identifier", () => {
      const cfg = getTableConfig(unknownItems);
      const idx = cfg.indexes.find(
        (i) => i.config.name === "idx_unknown_items_lookup_value",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
        where?: unknown;
      };
      expect(config.unique).toBeFalsy();
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "identifier_type",
        "value",
      ]);
      const whereStr = renderSQL(config.where).toLowerCase();
      expect(whereStr).toContain("resolution_status");
      expect(whereStr).toContain("pending");
    });

    it("declares idx_unknown_items_encountered_at — time-ordered view", () => {
      const cfg = getTableConfig(unknownItems);
      const idx = cfg.indexes.find(
        (i) => i.config.name === "idx_unknown_items_encountered_at",
      );
      expect(idx).toBeDefined();
      const config = idx!.config as {
        unique?: boolean;
        columns: Array<{ name: string }>;
      };
      expect(config.unique).toBeFalsy();
      expect(config.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "encountered_at",
      ]);
    });
  });
});
