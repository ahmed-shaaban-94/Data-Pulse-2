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
import { connectorRegistration } from "./connector_registration";
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
  /**
   * Link to the stable connector-instance identity (018, migration 0021).
   * NULL for non-connector scopes; carries the `connector_registration_id`
   * for a connector-scoped credential so the identity survives rotation
   * (data-model.md Entity 2; research R1). FK → connector_registration(id)
   * ON DELETE RESTRICT.
   *
   * At-most-one-active invariant: a partial UNIQUE
   * `(connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL`
   * (declared in 0021) enforces at most one unrevoked connector credential per
   * registration (FR-010). The predicate is IMMUTABLE — expiry is deliberately
   * NOT in it (now() is STABLE, not IMMUTABLE; expiry is enforced at the guard).
   *
   * The connector-token consistency CHECK (scope='connector' iff this is NOT
   * NULL) is a DEFERRED follow-up (R3) — a legacy unlinked connector token
   * would violate it, pending a live backfill. See the 0021 migration header.
   */
  connectorRegistrationId: uuid("connector_registration_id").references(
    () => connectorRegistration.id,
    { onDelete: "restrict" },
  ),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * Scopes that are valid for general API bearer authentication.
 *
 * `connector` (015): the opaque, revocable MACHINE principal the ERPNext
 * connector (separate repo, ADR 0008) presents on the 012 posting-feed surface
 * (`connectorBearer`). It reuses the existing `auth_tokens` opaque-bearer path.
 * NOT a human/POS scope: only the connector feed/ack routes accept it.
 *
 * As of migration 0021 (018), `scope` is pinned by a DB CHECK
 * `auth_tokens_scope_valid` to exactly this six-member set — the free-TEXT gap
 * 018 targets is now closed. This union and the CHECK MUST stay in lockstep.
 */
export type BearerAuthScope =
  | "dashboard_api"
  | "pos"
  | "pos_operator"
  | "connector";
/** Scopes reserved for single-use workflow tokens (password reset, email verify). */
export type SingleUseTokenScope = "password_reset" | "email_verify";
export type AuthTokenScope = BearerAuthScope | SingleUseTokenScope;
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type NewAuthTokenRow = typeof authTokens.$inferInsert;
