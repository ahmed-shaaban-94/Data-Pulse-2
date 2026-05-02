/**
 * `tenants` — customer account / organization. (data-model.md §2)
 *
 * RLS-enabled: `tenants.id = current_setting('app.current_tenant')::uuid`
 * OR `current_setting('app.is_platform_admin') = 'true'`. Policy lives in
 * `drizzle/0000_initial.sql`.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type TenantStatus = "active" | "suspended" | "pending";
export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
