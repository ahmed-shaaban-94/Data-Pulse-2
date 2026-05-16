/**
 * `unknown_items` — Capture table for POS/import identifiers that do not
 * resolve to any product in the resolved store catalog. (data-model.md §8)
 *
 * Q10: NO auto-resolve path. Resolution requires a human actor recorded in
 *      `resolved_by`. The `CHK unknown_items_resolved_fields_consistent`
 *      enforces that resolution fields are fully set or fully NULL together.
 *      No `auto_resolve` / `auto_create` / `auto_resolved` flag exists.
 *
 * `sale_context jsonb NULL` carries opaque POS-supplied context. MUST be
 * redacted at all logger boundaries per Constitution §14.
 *
 * RLS-enabled by `tenant_id` + `store_id`. Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

export const unknownItems = pgTable(
  "unknown_items",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    identifierType: text("identifier_type").notNull(),
    value: text("value").notNull(),
    sourceSystem: text("source_system"),
    encounteredAt: timestamp("encountered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    saleContext: jsonb("sale_context"),
    resolutionStatus: text("resolution_status").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolutionAction: text("resolution_action"),
    resolvedProductId: uuid("resolved_product_id").references(
      () => tenantProducts.id,
      { onDelete: "set null" },
    ),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "unknown_items_identifier_type_valid",
      sql`${t.identifierType} IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')`,
    ),
    check(
      "unknown_items_value_length",
      sql`length(${t.value}) BETWEEN 1 AND 200`,
    ),
    check(
      "unknown_items_resolution_status_valid",
      sql`${t.resolutionStatus} IN ('pending', 'resolved', 'dismissed')`,
    ),
    check(
      "unknown_items_resolution_action_valid",
      sql`${t.resolutionAction} IS NULL OR ${t.resolutionAction} IN ('linked', 'created', 'dismissed')`,
    ),
    check(
      "unknown_items_resolved_fields_consistent",
      sql`(${t.resolutionStatus} = 'pending' AND ${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolutionAction} IS NULL) OR (${t.resolutionStatus} <> 'pending' AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolutionAction} IS NOT NULL)`,
    ),
    check(
      "unknown_items_linked_product_present",
      sql`(${t.resolutionAction} IN ('linked', 'created') AND ${t.resolvedProductId} IS NOT NULL) OR (${t.resolutionAction} = 'dismissed' AND ${t.resolvedProductId} IS NULL) OR ${t.resolutionAction} IS NULL`,
    ),
    check(
      "unknown_items_source_system_required",
      sql`(${t.identifierType} = 'external_pos_id' AND ${t.sourceSystem} IS NOT NULL) OR (${t.identifierType} <> 'external_pos_id' AND ${t.sourceSystem} IS NULL)`,
    ),
    index("idx_unknown_items_pending")
      .on(t.tenantId, t.storeId)
      .where(sql`${t.resolutionStatus} = 'pending'`),
    index("idx_unknown_items_lookup_value")
      .on(t.tenantId, t.identifierType, t.value)
      .where(sql`${t.resolutionStatus} = 'pending'`),
    index("idx_unknown_items_encountered_at").on(t.tenantId, t.encounteredAt),
  ],
);

export type UnknownItemRow = typeof unknownItems.$inferSelect;
export type NewUnknownItemRow = typeof unknownItems.$inferInsert;
