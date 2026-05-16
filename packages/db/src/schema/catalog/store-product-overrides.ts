/**
 * `store_product_overrides` — Store Override layer. (data-model.md §5)
 *
 * Authoritative for branch-level deviations from the Tenant Catalog.
 *
 * Q8: Overrideable fields in v1 are EXACTLY four: `price`, `currency_code`,
 *     `is_active`, `tax_category`. NO `name`, NO `category_id` — product
 *     identity remains tenant-level truth.
 * Q1: `price` is `numeric(19,4)`.
 * Q2: `currency_code` is `char(3) NULL`. NULL only when `price` is NULL
 *     (paired by CHECK). Q2 preserved: rows storing a monetary value carry
 *     an explicit currency code.
 * Q11: `tax_category` is `text NULL`; NULL means inherit tenant default.
 *
 * Partial UQ on `(tenant_id, store_id, product_id) WHERE retired_at IS NULL`:
 * at most one active override per product per store.
 *
 * RLS-enabled by `tenant_id` + `store_id`. Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

export const storeProductOverrides = pgTable(
  "store_product_overrides",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => tenantProducts.id, { onDelete: "restrict" }),
    price: numeric("price", { precision: 19, scale: 4 }),
    currencyCode: char("currency_code", { length: 3 }),
    isActive: boolean("is_active"),
    taxCategory: text("tax_category"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    correlationId: uuid("correlation_id"),
  },
  (t) => [
    check(
      "store_product_overrides_currency_paired",
      sql`(${t.price} IS NULL AND ${t.currencyCode} IS NULL) OR (${t.price} IS NOT NULL AND ${t.currencyCode} IS NOT NULL)`,
    ),
    check(
      "store_product_overrides_tax_category_length",
      sql`${t.taxCategory} IS NULL OR (length(${t.taxCategory}) BETWEEN 1 AND 50)`,
    ),
    check(
      "store_product_overrides_at_least_one_override",
      sql`NOT (${t.price} IS NULL AND ${t.isActive} IS NULL AND ${t.taxCategory} IS NULL)`,
    ),
    index("idx_store_product_overrides_store_active")
      .on(t.tenantId, t.storeId)
      .where(sql`${t.retiredAt} IS NULL`),
    index("idx_store_product_overrides_product")
      .on(t.tenantId, t.productId)
      .where(sql`${t.retiredAt} IS NULL`),
    uniqueIndex("UQ_idx_store_product_overrides_product_store")
      .on(t.tenantId, t.storeId, t.productId)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type StoreProductOverrideRow =
  typeof storeProductOverrides.$inferSelect;
export type NewStoreProductOverrideRow =
  typeof storeProductOverrides.$inferInsert;
