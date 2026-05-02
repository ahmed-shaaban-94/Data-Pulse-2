/**
 * `stores` — branch / location within a tenant. (data-model.md §3)
 *
 * Composite UNIQUE `(tenant_id, id)` exists in SQL to support the composite
 * FK from `store_access` that enforces Invariant I-3.
 *
 * RLS-enabled by `tenant_id`. Policy lives in `drizzle/0000_initial.sql`.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

export const stores = pgTable("stores", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type StoreRow = typeof stores.$inferSelect;
export type NewStoreRow = typeof stores.$inferInsert;
