/**
 * `users` — human identity. Tenant-agnostic (no `tenant_id`).
 * Source of truth for the column shape: data-model.md §1.
 *
 * RLS is NOT applied at the table level (per spec); access is gated at the
 * application layer (only platform admins or the user themselves).
 *
 * The Drizzle definition below documents the column types so query builders
 * stay type-safe. Partial unique indexes, CHECK constraints, and triggers
 * live in `drizzle/0000_initial.sql`.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
