/**
 * `global_products` — Global Product Index. (data-model.md §2)
 *
 * Platform-curated reference catalog. Platform Admin is the sole writer.
 * Tenants adopt entries via copy-on-adopt snapshot (Q5); no FK from
 * `tenant_products.source_global_product_id` to this table.
 *
 * Reference-only — never authoritative for any tenant. NO `tenant_id`,
 * NO `store_id` columns. RLS allows authenticated reads of active rows
 * and restricts writes to Platform Admin (policy in `0001_catalog.sql`).
 */
import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const globalProducts = pgTable(
  "global_products",
  {
    id: uuid("id").primaryKey().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    suggestedCategory: text("suggested_category"),
    suggestedTaxCategory: text("suggested_tax_category"),
    defaultPrice: numeric("default_price", { precision: 19, scale: 4 }),
    defaultCurrencyCode: char("default_currency_code", { length: 3 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    check(
      "global_products_name_length",
      sql`length(${t.name}) BETWEEN 1 AND 500`,
    ),
    check(
      "global_products_currency_paired",
      sql`(${t.defaultPrice} IS NULL AND ${t.defaultCurrencyCode} IS NULL) OR (${t.defaultPrice} IS NOT NULL AND ${t.defaultCurrencyCode} IS NOT NULL)`,
    ),
    check(
      "global_products_suggested_tax_category_format",
      sql`${t.suggestedTaxCategory} IS NULL OR (length(${t.suggestedTaxCategory}) BETWEEN 1 AND 50)`,
    ),
    index("idx_global_products_active")
      .on(t.id)
      .where(sql`${t.retiredAt} IS NULL`),
    index("idx_global_products_suggested_category")
      .on(t.suggestedCategory)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type GlobalProductRow = typeof globalProducts.$inferSelect;
export type NewGlobalProductRow = typeof globalProducts.$inferInsert;
