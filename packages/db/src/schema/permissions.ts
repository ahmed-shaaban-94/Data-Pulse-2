/**
 * `permissions` and `role_permissions` — fine-grained capability strings.
 * (data-model.md §7 + §8)
 *
 * Forward-compat empty in v1: the role-to-permission mapping is in code
 * (`apps/api/src/auth/roles.catalog.ts` — T202, future slice). These tables
 * exist so that adding fine-grained permissions later is a SEED operation,
 * not a schema migration.
 *
 * `permissions` has NO RLS (catalog is global).
 */
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionId: uuid("permission_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
  }),
);

export type PermissionRow = typeof permissions.$inferSelect;
export type NewPermissionRow = typeof permissions.$inferInsert;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type NewRolePermissionRow = typeof rolePermissions.$inferInsert;
