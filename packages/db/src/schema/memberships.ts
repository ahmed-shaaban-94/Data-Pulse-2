/**
 * `memberships` — user's relationship to a tenant. (data-model.md §4)
 *
 * Constraints declared in SQL (`drizzle/0000_initial.sql`):
 *   - Partial UNIQUE `(tenant_id, user_id)` WHERE `deleted_at IS NULL`
 *     enforces Invariant I-2.
 *   - Composite UNIQUE `(tenant_id, id)` is the target for the composite FK
 *     from `store_access` enforcing Invariant I-3.
 *   - CHECK `store_access_kind IN ('all','specific')`.
 *
 * RLS-enabled by `tenant_id`.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { tenants } from "./tenants";
import { users } from "./users";

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "restrict" }),
  storeAccessKind: text("store_access_kind").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type StoreAccessKind = "all" | "specific";
export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;
