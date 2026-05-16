/**
 * `price_history` — Immutable audit trail of price changes. (data-model.md §7)
 *
 * Every price change to `tenant_products.default_price` or
 * `store_product_overrides.price` writes a new row here. Rows are NEVER
 * edited or deleted (RLS denies UPDATE / DELETE). Corrections are new rows.
 *
 * NO `retired_at` column — rows are immutable and not soft-deleted.
 *
 * Q1: `price` is `numeric(19,4) NOT NULL`.
 * Q2: `currency_code` is `char(3) NOT NULL` — every row stores money.
 * Q9: `effective_from` / `effective_to` track validity intervals. At most
 *     one open interval per scope:
 *       - `UQ_idx_price_history_tenant_open` — tenant-level (store_id IS NULL)
 *       - `UQ_idx_price_history_store_open`  — store-level (store_id IS NOT NULL)
 *
 * RLS-enabled by `tenant_id`. INSERT-only at the app + RLS level.
 * Policy lives in `0001_catalog.sql`.
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

export const priceHistory = pgTable(
  "price_history",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => tenantProducts.id, { onDelete: "restrict" }),
    storeId: uuid("store_id").references(() => stores.id, {
      onDelete: "restrict",
    }),
    price: numeric("price", { precision: 19, scale: 4 }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    changedBy: uuid("changed_by").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "price_history_interval_order",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check("price_history_price_positive", sql`${t.price} >= 0`),
    uniqueIndex("UQ_idx_price_history_tenant_open")
      .on(t.tenantId, t.productId)
      .where(sql`${t.storeId} IS NULL AND ${t.effectiveTo} IS NULL`),
    uniqueIndex("UQ_idx_price_history_store_open")
      .on(t.tenantId, t.productId, t.storeId)
      .where(sql`${t.storeId} IS NOT NULL AND ${t.effectiveTo} IS NULL`),
    index("idx_price_history_product_timeline").on(
      t.tenantId,
      t.productId,
      t.effectiveFrom,
    ),
    index("idx_price_history_store_timeline")
      .on(t.tenantId, t.productId, t.storeId, t.effectiveFrom)
      .where(sql`${t.storeId} IS NOT NULL`),
  ],
);

export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type NewPriceHistoryRow = typeof priceHistory.$inferInsert;
