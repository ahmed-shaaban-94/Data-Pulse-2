/**
 * Clerk JWT primitives — thin re-export of `@clerk/backend`'s
 * `verifyToken`. This keeps the `@clerk/backend` dependency contained to
 * `@data-pulse-2/auth` (the package that already owns auth primitives —
 * argon2id, SHA-256 token hashing — per ADR 0001 D3 / PR-2). Consumers
 * (`apps/api`, future `apps/worker`) import only from here, so a future
 * library swap (e.g. to `jose` per the ADR fallback) is a one-file
 * change.
 *
 * The verifier behaviour itself (audience, issuer, JWKS caching, fail-
 * closed semantics) is configured at the call site by the consumer; this
 * file ships only the primitive.
 */
export { verifyToken } from "@clerk/backend";
