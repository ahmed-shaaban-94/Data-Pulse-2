/**
 * Session and auth-token shape types shared by `apps/api` (and later
 * `apps/worker`). The DB schema is the source of truth — see
 * `specs/001-foundation-auth-tenant-store/data-model.md` §9 (sessions) and
 * §10 (auth_tokens).
 *
 * Naming uses snake_case to match DB column names (no mapper layer in v1).
 *
 * Branded primitives (`SessionId`, `AuthTokenId`, `RawToken`, `TokenHash`)
 * are nominal types: assigning a plain `string` to a `RawToken` is a
 * compile error, which prevents accidental persistence of the wire token in
 * place of its hash.
 */

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

// --- branded primitives ---

export type UserId = Brand<string, "UserId">;
export type TenantId = Brand<string, "TenantId">;
export type StoreId = Brand<string, "StoreId">;
export type SessionId = Brand<string, "SessionId">;
export type AuthTokenId = Brand<string, "AuthTokenId">;

/** The opaque bearer token as shown to a client exactly once. NEVER persisted. */
export type RawToken = Brand<string, "RawToken">;

/** SHA-256(rawToken) as a 32-byte Buffer. The form persisted server-side. */
export type TokenHash = Brand<Buffer, "TokenHash">;

// --- session ---

export type SessionRevocationReason =
  | "user_signout"
  | "admin_revoke"
  | "absolute_expiry"
  | "rotated";

/**
 * Mirror of the `sessions` row plus its derived liveness state.
 */
export interface Session {
  id: SessionId;
  user_id: UserId;
  active_tenant_id: TenantId | null;
  active_store_id: StoreId | null;
  issued_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  user_agent: string | null;
  ip_at_issue: string | null;
}

// --- auth tokens ---

export type AuthTokenScope = "dashboard_api" | "pos";

/**
 * Mirror of the `auth_tokens` row.
 *
 * Exactly one of `user_id` / `device_id` is non-null per the table CHECK
 * constraint. `device_id` is reserved for the future POS device entity and
 * is typed as `string | null` until the device entity ships.
 */
export interface AuthToken {
  id: AuthTokenId;
  token_hash: TokenHash;
  tenant_id: TenantId | null;
  user_id: UserId | null;
  device_id: string | null;
  store_id: StoreId | null;
  scope: AuthTokenScope;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * What a successful sign-in returns: the persisted record plus the wire
 * token. Carry this object only as long as needed to send the response;
 * the `raw` token must NEVER be logged or stored.
 */
export interface IssuedAuthToken {
  record: AuthToken;
  raw: RawToken;
}
