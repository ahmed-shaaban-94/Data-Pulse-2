/**
 * `auth_tokens` — opaque bearer tokens for API consumers and (future) POS
 * devices. (data-model.md §10)
 *
 * Constraints declared in SQL:
 *   - UNIQUE `token_hash` (full lookup key — never store the raw token).
 *   - CHECK `(user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1`
 *     — exactly one of user-vs-device per row.
 *   - Partial index for active tokens.
 *
 * `device_id` is the FR-POS-SEAM-1 reservation: column exists today, FK to
 * the (future) `devices` table is added in the POS slice.
 *
 * RLS-enabled by `tenant_id`. Platform-scoped tokens (`tenant_id IS NULL`)
 * are visible only to platform admins.
 */
import {
  customType,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const authTokens = pgTable("auth_tokens", {
  id: uuid("id").primaryKey(),
  tokenHash: bytea("token_hash").notNull().unique(),
  tenantId: uuid("tenant_id").references(() => tenants.id, {
    onDelete: "restrict",
  }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
  /**
   * Future POS device identifier. The FK is added when the `devices` table
   * ships; for v1 the column is reserved and nullable. (FR-POS-SEAM-1)
   */
  deviceId: uuid("device_id"),
  storeId: uuid("store_id").references(() => stores.id, {
    onDelete: "restrict",
  }),
  scope: text("scope").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type AuthTokenScope = "dashboard_api" | "pos";
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type NewAuthTokenRow = typeof authTokens.$inferInsert;
