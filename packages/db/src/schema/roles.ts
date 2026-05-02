/**
 * `roles` — named bundle of capabilities. v1 is predefined per-tenant
 * (seeded at tenant creation). (data-model.md §6)
 *
 * Constraints declared in SQL (`drizzle/0000_initial.sql`):
 *   - UNIQUE `(tenant_id, code)`  (NULL `tenant_id` means platform-scope)
 *   - UNIQUE `(tenant_id, id)`    (composite-FK target for `memberships`)
 *   - CHECK   `code ~ '^[a-z][a-z0-9_]{1,40}$'`
 *
 * RLS-enabled. Policy: `tenant_id IS NULL` (platform) OR matches GUC.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, {
    onDelete: "restrict",
  }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  isBuiltIn: boolean("is_built_in").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BuiltInRoleCode =
  | "owner"
  | "tenant_admin"
  | "store_manager"
  | "store_staff"
  | "platform_admin";

export type RoleRow = typeof roles.$inferSelect;
export type NewRoleRow = typeof roles.$inferInsert;
