import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RAW_TOKEN_BYTES = 32;
export const TOKEN_HASH_BYTES = 32;

/**
 * Generate a fresh opaque bearer token.
 *
 * Returns the URL-safe base64 string of 32 random bytes (43 chars, no
 * padding). The caller MUST hash this with {@link hashToken} before storing
 * it; the raw value is shown to the user exactly once and never persisted
 * server-side (per data-model `auth_tokens.token_hash`).
 */
export function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

/**
 * Hash a bearer token with SHA-256. Returns a 32-byte Buffer suitable for
 * storage in the `auth_tokens.token_hash` BYTEA column.
 */
export function hashToken(token: string | Buffer): Buffer {
  const h = createHash("sha256");
  if (typeof token === "string") {
    h.update(token, "utf8");
  } else {
    h.update(token);
  }
  return h.digest();
}

/**
 * Constant-time comparison of two token-hash buffers. Returns false (never
 * throws) on length mismatch or zero-length input, so callers can treat the
 * boolean as the only signal.
 */
export function tokenHashesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
