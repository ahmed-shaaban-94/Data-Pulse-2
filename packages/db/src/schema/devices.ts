/**
 * `devices` — per-terminal trust factor for POS operator sign-in.
 * Source of truth for the column shape: ADR 0001 D7.
 *
 * Tenant- and store-scoped; device tokens are stored as SHA-256 hashes only
 * (never plaintext). Revocation is supported via `revoked_at`. Sign-in
 * requires both a verified Clerk JWT (human identity) and a validated
 * device row (terminal trust).
 *
 * RLS is enabled by `tenant_id`; policy mirrors the standard tenant
 * isolation predicate. Partial active-token index, CHECK constraints, and
 * the `updated_at` trigger live in
 * `drizzle/0001_pos_operator_identity.sql`.
 */
import { customType, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id, { onDelete: "restrict" }),
  label: text("label"),
  tokenHash: bytea("token_hash").notNull().unique(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
