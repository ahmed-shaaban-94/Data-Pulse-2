# ADR 0001 — POS Operator Identity, Wave 1 Auth Alignment

**Status**: Accepted (documentation only — no implementation)
**Date**: 2026-05-06
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature**: `002-pos-operator-identity` (kickoff in [specs/002-pos-operator-identity/](../../../specs/002-pos-operator-identity/spec.md))

---

## Context

POS-Pulse 004 needs operator sign-in and sign-out endpoints served by Data-Pulse-2.
POS-Pulse PR #43 merged with an Endpoint 2 contract that uses Clerk JWT verified
via JWKS for operator identity. POS-Pulse PR #44 merged the POS-facing namespace
move to `/api/pos/v1/...`. POS-Pulse Sprint 1 is blocked until Data-Pulse-2 Wave 1
is available.

Data-Pulse-2 today carries two human-identity surfaces:

- **Dashboard humans** authenticate with email + password (argon2id) and receive
  an httpOnly cookie session. This is the existing internal flow and continues
  unchanged.
- **API/POS callers** authenticate with opaque bearer tokens stored hashed in
  `auth_tokens`. The `device_id` column is currently reserved (nullable) and the
  table enforces `(user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1`.

Wave 1 alignment was approved with two key answers:

- **Q1 = Yes** — Data-Pulse-2 adopts Clerk JWT verification for POS-facing operator
  endpoints.
- **Q2 = path (b)** — POS-Pulse holds the Clerk JWT and Data-Pulse-2 verifies it
  via JWKS at the API edge.

This ADR records the decisions that follow from those two answers, and the gates
that must hold before any implementation slice begins.

---

## Decisions

### D1. Endpoint namespace

Data-Pulse-2 supports POS-facing operator/session endpoints under
`/api/pos/v1/operators/...`. Wave 1 surface:

- `POST /api/pos/v1/operators/sign-in`
- `POST /api/pos/v1/operators/sign-out`

This matches the foundation's reserved `/api/pos/v1/*` namespace
([specs/001-foundation-auth-tenant-store/contracts/README.md](../../../specs/001-foundation-auth-tenant-store/contracts/README.md))
and the POS-Pulse contract of record after PR #44.

### D2. POS-facing human identity is Clerk-backed

Clerk is the identity provider for POS-Pulse manager / admin / operator sign-in.
Data-Pulse-2 does not receive or handle Clerk passwords for POS flows. POS-Pulse
holds the Clerk JWT; Data-Pulse-2 verifies it.

### D3. Clerk JWT verification

Data-Pulse-2 verifies the Clerk JWT at the API edge using a vetted Clerk
verification approach against Clerk's JWKS endpoint:

- Preferred library: `@clerk/backend` if compatible with the Data-Pulse-2 runtime.
- Fallback: `jose` only if `@clerk/backend` is unsuitable.
- Library choice and dependency add are gated behind PR-2 (dependency-only PR).
- **Resolved in PR-2**: `@clerk/backend@3.4.5` selected. Compatibility verdict:
  Node engine `>=20.9.0` satisfied by the repo's Node 20 LTS pin; pure-JS dual
  CJS/ESM build with no native compilation; zero peer dependencies. Fallback to
  `jose` not needed. Added to `@data-pulse-2/auth` (the package that already
  owns auth primitives such as argon2id and the SHA-256 token-hash helper).

Verification policy: validate signature, `iss`, `aud`, `exp`, `nbf`, `iat`; cache
JWKS with a short TTL; refresh on `kid` miss once before failing; fail closed on
JWKS fetch failure. The Clerk JWT is verified at the API boundary and is **not**
propagated past the verifier — never logged, never persisted, never enqueued onto
BullMQ, never written to the database, never used as the long-lived in-system
credential.

### D4. Stable `clerk_user_id` mapping

Data-Pulse-2 introduces a stable `users.clerk_user_id` mapping in a later
schema-only PR (PR-3). The Clerk subject (`sub`) claim is the durable identifier;
email is informational only.

Wave 1 fails closed when no mapping exists: if a Clerk JWT verifies but no local
user is mapped, the request returns the generic refusal envelope. There is no JIT
provisioning at sign-in. Operator provisioning is a separate flow with its own
audit trail and tenant-assignment story.

**Resolved in PR-3**: `users.clerk_user_id` is `TEXT NULL` with a non-empty
CHECK and a partial UNIQUE index on `(clerk_user_id) WHERE clerk_user_id IS
NOT NULL`. Existing dashboard / argon2id users keep `NULL`; only Clerk-mapped
users carry a value. Migration: `0001_pos_operator_identity.sql`.

### D5. `branch_id` stays in POS-facing surface

`branch_id` is the stable POS-Pulse-facing identifier and remains in POS-facing
DTOs and the OpenAPI contract. Data-Pulse-2 maps `branch_id` to internal
`store_id` / `active_store_id` only at the DTO/service boundary. POS-Pulse-facing
contracts are not renamed to `store_id`. `branch_id` does not appear in Drizzle
queries, RLS contexts, audit rows, BullMQ payloads, or worker code.

### D6. Existing internal auth is preserved

The existing argon2id + cookie session auth for dashboard / internal flows
continues unchanged. Wave 1 adds a parallel POS path; it does not replace,
weaken, or alter any existing auth behavior. No code in `apps/api/src/auth/` is
modified to support POS sign-in.

### D7. `device_token` / terminal attestation is a separate trust factor

Device trust is orthogonal to human identity. Sign-in requires both:

- A verified Clerk JWT (human identity), and
- A validated device token (terminal trust).

Wave 1 uses a `devices` table with hashed device tokens, tenant/store scope, and
revocation support. The schema lands in PR-3. There is no temporary allow-list.

**Resolved in PR-3**: `devices` table created with columns `id` (UUID PK),
`tenant_id` (FK → `tenants(id)` ON DELETE RESTRICT, NOT NULL), `store_id`
(FK → `stores(id)` ON DELETE RESTRICT, NOT NULL), `label` (TEXT NULL,
non-empty CHECK), `token_hash` (BYTEA NOT NULL UNIQUE), `revoked_at`
(TIMESTAMPTZ NULL), `created_at`, `updated_at`. RLS + FORCE RLS enabled with
the standard `tenant_id = current_setting('app.current_tenant',true)::uuid OR
platform-admin` policy (same shape as `stores` / `memberships`). Active-token
index `devices_active_idx ON (tenant_id, store_id) WHERE revoked_at IS NULL`.
`updated_at` trigger reuses the shared `set_updated_at()` function.

### D8. Internal POS operator session token (operator-session state only)

When sign-in succeeds, Data-Pulse-2 may issue an internal opaque POS operator
session token. This token is operator-session state only:

- It is derived from a verified Clerk JWT, the mapped local user, the validated
  device token, and the resolved tenant + store.
- It is not a human identity token.
- It does not replace Clerk identity.
- It is not long-lived or refreshable in Wave 1. When it expires, the POS app
  re-runs sign-in (which re-verifies Clerk JWT + device).
- Its scope is `pos_operator`. It is rejected on non-POS routes by a route guard.

### D9. `auth_tokens` schema — scope-aware CHECK

The current `auth_tokens` CHECK forbids both `user_id` and `device_id` being
populated on the same row. The POS operator session token requires both.

Resolution: a scope-aware CHECK lands in PR-3. The `pos_operator` scope permits
both `user_id` and `device_id` populated; every other scope keeps the current
"exactly one" invariant. Existing token constraints are not weakened globally.

**Resolved in PR-3**: the original `auth_tokens_principal_xor` CHECK is
dropped and replaced (not extended) by `auth_tokens_principal_by_scope`:

```sql
CHECK (
  (scope = 'pos_operator' AND user_id IS NOT NULL AND device_id IS NOT NULL)
  OR
  (scope <> 'pos_operator'
     AND (user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1)
)
```

A fresh constraint name was chosen so a future grep for `principal_xor` does
not return a stale, no-longer-XOR predicate. PR-3 also closes the
FR-POS-SEAM-1 reservation by adding FK
`auth_tokens.device_id → devices(id) ON DELETE RESTRICT` (simple FK,
matching the table's existing `user_id` / `store_id` pattern; tenant
consistency for `pos_operator` rows is enforced at the application layer
in PR-5).

**Rollback hazard documented**: the DOWN migration MUST delete `scope =
'pos_operator'` rows from `auth_tokens` before re-adding the original XOR
CHECK, because the restored predicate forbids rows where both `user_id` and
`device_id` are populated. Once PR-5 ships and live operator sessions exist,
rolling back PR-3 invalidates every active POS operator session token. The
DOWN file documents this destructive step inline; production rollback
should be scheduled in a maintenance window.

### D10. Generic refusal envelope

Every Wave 1 sign-in / sign-out failure returns the same canonical
`{ error: { code, message, request_id } }` envelope at the same status code. The
response body does not distinguish between:

- invalid Clerk JWT (signature, audience, issuer, expiry),
- missing or unmapped local user,
- disabled / deleted local user,
- no active membership,
- `branch_id` does not resolve to any store,
- store not in the operator's allowed set,
- device token invalid / unknown / revoked / mismatched tenant or store,
- rate limit exhausted.

The actual reason is logged server-side with `request_id`. This inherits
FR-ISO-4 from the foundation.

### D11. Cashier PIN never crosses the backend boundary

Cashier PIN is local to the POS terminal. PIN values must never:

- be sent to any Data-Pulse-2 endpoint,
- appear in any request body, response body, error body, or header,
- appear in any log line (structured or unstructured),
- appear in any audit `metadata` field, action, or target,
- appear in any BullMQ job payload or worker code path,
- appear in any token, hash, schema column, or migration.

The architectural rule above is the primary protection. Defense-in-depth (e.g.,
adding `"pin"` to the audit metadata blocked-key list) is a future defensive
measure and does not substitute for the rule.

---

## Wave 1 implementation gates

Implementation cannot start until all of the following hold:

1. **PR-1 (this ADR + spec kickoff)** is merged.
2. **PR-2 (dependency-only Clerk verifier)** is approved and merged.
3. **PR-3 (schema-only)** is approved and merged.
4. **PR-4 (OpenAPI contract-only)** is approved and merged.

PR-5 (sign-in implementation) and PR-6 (sign-out implementation) are gated
behind the four prerequisite PRs.

---

## Approved PR sequence

| # | PR | Type | Gate |
|---|----|------|------|
| **PR-1** | ADR + spec kickoff (this PR) | docs-only | none |
| **PR-2** | Dependency-only Clerk verifier (`@clerk/backend` preferred, `jose` fallback) | dep-only | package.json + lockfile |
| **PR-3** | Schema-only: `users.clerk_user_id`, `devices` table, scope-aware CHECK on `auth_tokens`, FK | schema-only | DB schema + SQL migration |
| **PR-4** | OpenAPI contract-only: `pos-operators.openapi.yaml` mirroring POS-Pulse Endpoint 2 | contract-only | OpenAPI |
| **PR-5** | Sign-in implementation | code-only | none (after PR-2/3/4) |
| **PR-6** | Sign-out implementation + scope-leakage probe | code-only | none (after PR-5) |

Each Constitution-VIII-gated change (PR-2, PR-3, PR-4) is isolated into its own
single-focus reviewer pass. POS-Pulse Sprint 1 unblocks at PR-6 merge.

---

## Hard out-of-scope (Wave 1)

The following are explicitly not part of Wave 1 and not part of this ADR:

- Any cashier-PIN handling.
- Any operator roster, takeover, active-session lookup, or audit-events query
  endpoint.
- Any forced-close shift action.
- Any sales / cart / payment endpoint.
- Any dashboard / frontend work.
- Any analytics / reports / dbt work.
- Any billing or subscription work.
- Any change to existing argon2id / cookie session auth behaviour.

---

## References

- POS-Pulse PR #43 — Endpoint 2 contract (Clerk JWT via JWKS) — merged.
- POS-Pulse PR #44 — namespace move to `/api/pos/v1/...` — merged.
- [specs/pos-operator-identity-preflight.md](../../../specs/pos-operator-identity-preflight.md) — earlier accepted local pre-flight (untracked).
- [specs/pos-pulse-004-backend-wave1-plan.md](../../../specs/pos-pulse-004-backend-wave1-plan.md) — owner-approved Wave 1 plan (untracked).
- [specs/pos-pulse-004-backend-wave1-pr-sequence.md](../../../specs/pos-pulse-004-backend-wave1-pr-sequence.md) — approved PR sequence (untracked).
- [.specify/memory/constitution.md](../constitution.md) — v3.0.0.
- [specs/001-foundation-auth-tenant-store/contracts/README.md](../../../specs/001-foundation-auth-tenant-store/contracts/README.md) — foundation contracts conventions, including the `/api/pos/v1/*` reserved namespace.
