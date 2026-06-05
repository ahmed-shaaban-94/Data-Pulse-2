/**
 * `erpnext_warehouse_map` — Store↔ERPNext-Warehouse mapping (014 data-model.md §2).
 *
 * Links a DP2 `stores` row to an ERPNext **Warehouse** reference so ERPNext can
 * VALUE the same physical stock a store holds, and so the reconciliation (017)
 * + future posting (015) target the right warehouse. This is a PURE MAPPING
 * table — it carries NO stock authority (OQ-1, §IX, the SIGNED stock-impact
 * decision): DP2's 009 ledger stays the OPERATIONAL on-hand authority; ERPNext
 * owns VALUATION; read-down is rejected.
 *
 * Key invariants (014 data-model.md):
 *   - OQ-2 forward-compat: the active-uniqueness is on
 *     (tenant_id, store_id, PURPOSE) — NOT bare (tenant_id, store_id) — via a
 *     PARTIAL unique index WHERE retired_at IS NULL. v1 only ever writes
 *     `purpose='stock'`, so it behaves strictly 1:1 per store; the `purpose`
 *     grain admits a future `returns`/expired warehouse row WITHOUT a breaking
 *     migration. Retired rows accumulate as history (mirrors 013/003 partial
 *     uniques).
 *   - §III: `version` is the optimistic-concurrency token (a DELIBERATE,
 *     justified divergence from the 003 catalog tables' last-write-wins — a
 *     warehouse re-point is an explicit, low-volume admin trust action where a
 *     silent overwrite is unacceptable; the retire/update API uses
 *     `... WHERE id = $1 AND version = $2`, incrementing version; a mismatch
 *     is a 409). version >= 1.
 *   - `erpnext_warehouse_ref` is the ERPNext Warehouse reference in DP2 TERMS
 *     (e.g. the Warehouse name as text). NO FK — ERPNext is external, reached
 *     only via the connector (012 O-6 version-independence); mirrors the 013
 *     `erpnext_item_ref` / 003 `source_global_product_id` no-FK rationale
 *     (never couple DP2 row lifecycle to an out-of-DP2 catalogue). The ERPNext
 *     major is UNCONFIRMED (assumption A-1); the reference is version-independent.
 *   - NO ERPNext-quantity / Bin-mirror column (OQ-1 — the rejected read-down
 *     look-alike), NO valuation / cost column (ERPNext authority), NO on-hand
 *     column (computed-on-read from 009). Mapping only.
 *
 * Mutable tenant-owned resource: SELECT + INSERT + UPDATE RLS policies
 * (set -> updated -> retired). Re-point is append-only (retire old + insert
 * new), never an in-place identity rewrite. Policy lives in the
 * 0018_erpnext_warehouse_map.sql migration. RLS-enabled by `tenant_id`. This
 * is a TENANT-only table — `store_id` is a tenant-local FK, not a second RLS
 * axis (no store-axis bypass to probe, unlike 003's store-override table).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";

export const erpnextWarehouseMap = pgTable(
  "erpnext_warehouse_map",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // OQ-2 forward-compat discriminator. v1 only ever writes 'stock'.
    purpose: text("purpose").notNull().default("stock"),
    // ERPNext Warehouse reference in DP2 terms. NO FK — external, version-independent.
    erpnextWarehouseRef: text("erpnext_warehouse_ref").notNull(),
    setBy: uuid("set_by"),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    // §III optimistic-concurrency token.
    version: integer("version").notNull().default(1),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    correlationId: uuid("correlation_id"),
  },
  (t) => [
    check(
      "erpnext_warehouse_map_purpose_valid",
      sql`${t.purpose} IN ('stock', 'returns')`,
    ),
    check(
      "erpnext_warehouse_map_ref_length",
      sql`length(${t.erpnextWarehouseRef}) BETWEEN 1 AND 180`,
    ),
    check("erpnext_warehouse_map_version_positive", sql`${t.version} >= 1`),
    // OQ-2 forward-compat 1:1 — at most one ACTIVE mapping per (tenant, store, purpose).
    uniqueIndex("UQ_idx_erpnext_warehouse_map_active")
      .on(t.tenantId, t.storeId, t.purpose)
      .where(sql`${t.retiredAt} IS NULL`),
    // Reverse lookup — which store(s) point at an ERPNext Warehouse (reconciliation/audit).
    index("idx_erpnext_warehouse_map_ref")
      .on(t.tenantId, t.erpnextWarehouseRef)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type ErpnextWarehouseMapRow = typeof erpnextWarehouseMap.$inferSelect;
export type NewErpnextWarehouseMapRow = typeof erpnextWarehouseMap.$inferInsert;
