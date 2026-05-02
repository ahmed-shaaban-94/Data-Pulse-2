/**
 * `invitations` — pending offer to join a tenant. (data-model.md §11)
 *
 * Constraints declared in SQL:
 *   - UNIQUE `token_hash`.
 *   - CHECK `status IN ('pending','accepted','expired','revoked')`.
 *   - CHECK `store_access_kind IN ('all','specific')`.
 *
 * RLS-enabled by `tenant_id`.
 */
import {
  customType,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

const uuidArray = customType<{ data: string[]; default: false }>({
  dataType() {
    return "uuid[]";
  },
});

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "restrict" }),
  storeAccessKind: text("store_access_kind").notNull(),
  invitedStoreIds: uuidArray("invited_store_ids").notNull().default([]),
  invitedByUserId: uuid("invited_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  tokenHash: bytea("token_hash").notNull().unique(),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";
export type InvitationRow = typeof invitations.$inferSelect;
export type NewInvitationRow = typeof invitations.$inferInsert;
