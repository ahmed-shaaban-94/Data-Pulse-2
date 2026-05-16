/**
 * `product_aliases` — Alias registry for barcodes, SKUs, PLUs, supplier
 * codes, and external POS IDs attached to `tenant_products`. (data-model.md §6)
 *
 * Q4: Uniqueness rules are identifier-type-specific. THREE partial unique
 * indexes encode the three scopes:
 *   1. `UQ_idx_product_aliases_tenant_wide` — tenant-wide non-POS aliases.
 *   2. `UQ_idx_product_aliases_external_pos_id` — external POS ids
 *      uniqueness scoped by `source_system`.
 *   3. `UQ_idx_product_aliases_store_scoped` — store-scoped aliases.
 *
 * Constitution §11: `external_pos_id` rows require `source_system` (POS
 * idempotency pattern). Other identifier types must have NULL `source_system`.
 *
 * RLS-enabled by `tenant_id`. Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

export const productAliases = pgTable(
  "product_aliases",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => tenantProducts.id, { onDelete: "restrict" }),
    identifierType: text("identifier_type").notNull(),
    value: text("value").notNull(),
    sourceSystem: text("source_system"),
    storeId: uuid("store_id").references(() => stores.id, {
      onDelete: "restrict",
    }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
    correlationId: uuid("correlation_id"),
  },
  (t) => [
    check(
      "product_aliases_identifier_type_valid",
      sql`${t.identifierType} IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')`,
    ),
    check(
      "product_aliases_value_length",
      sql`length(${t.value}) BETWEEN 1 AND 200`,
    ),
    check(
      "product_aliases_source_system_required",
      sql`(${t.identifierType} = 'external_pos_id' AND ${t.sourceSystem} IS NOT NULL) OR (${t.identifierType} <> 'external_pos_id' AND ${t.sourceSystem} IS NULL)`,
    ),
    check(
      "product_aliases_store_scope_consistency",
      sql`${t.storeId} IS NULL OR ${t.identifierType} <> 'external_pos_id'`,
    ),
    uniqueIndex("UQ_idx_product_aliases_tenant_wide")
      .on(t.tenantId, t.identifierType, t.value)
      .where(
        sql`${t.storeId} IS NULL AND ${t.identifierType} <> 'external_pos_id' AND ${t.retiredAt} IS NULL`,
      ),
    uniqueIndex("UQ_idx_product_aliases_external_pos_id")
      .on(t.tenantId, t.sourceSystem, t.value)
      .where(
        sql`${t.identifierType} = 'external_pos_id' AND ${t.retiredAt} IS NULL`,
      ),
    uniqueIndex("UQ_idx_product_aliases_store_scoped")
      .on(t.tenantId, t.storeId, t.identifierType, t.value)
      .where(sql`${t.storeId} IS NOT NULL AND ${t.retiredAt} IS NULL`),
    index("idx_product_aliases_lookup")
      .on(t.tenantId, t.identifierType, t.value)
      .where(sql`${t.retiredAt} IS NULL`),
    index("idx_product_aliases_product")
      .on(t.tenantId, t.productId)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type ProductAliasRow = typeof productAliases.$inferSelect;
export type NewProductAliasRow = typeof productAliases.$inferInsert;
