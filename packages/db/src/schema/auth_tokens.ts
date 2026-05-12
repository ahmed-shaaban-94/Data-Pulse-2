/**
 * `auth_tokens` — opaque bearer tokens for API consumers and POS terminals.
 * (data-model.md §10)
 *
 * Constraints declared in SQL:
 *   - UNIQUE `token_hash` (full lookup key — never store the raw token).
 *   - CHECK `auth_tokens_principal_by_scope`
 *       - `pos_operator` rows MUST have both `user_id` and `device_id`
 *         (operator-session tokens carry both identities).
 *       - Every other scope keeps the original "exactly one of
 *         user_id / device_id" invariant.
 *   - FK `auth_tokens.device_id → devices(id)` (PR-3 closes the FR-POS-SEAM-1
 *     reservation now that `devices` exists).
 *   - Partial index for active tokens.
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
import { devices } from "./devices";
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
   * POS device / terminal identifier. FK to `devices(id)` added in PR-3.
   * Required for `pos_operator` scope rows; NULL for any other scope.
   */
  deviceId: uuid("device_id").references(() => devices.id, {
    onDelete: "restrict",
  }),
  storeId: uuid("store_id").references(() => stores.id, {
    onDelete: "restrict",
  }),
  scope: text("scope").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** Scopes that are valid for general API bearer authentication. */
export type BearerAuthScope = "dashboard_api" | "pos" | "pos_operator";
/** Scopes reserved for single-use workflow tokens (password reset, email verify). */
export type SingleUseTokenScope = "password_reset" | "email_verify";
export type AuthTokenScope = BearerAuthScope | SingleUseTokenScope;
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type NewAuthTokenRow = typeof authTokens.$inferInsert;
