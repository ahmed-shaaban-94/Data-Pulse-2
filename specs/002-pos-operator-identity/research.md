# Phase 0 — Research: POS Operator Identity Wave 1

**Feature**: 002 — pos-operator-identity
**Spec**: [spec.md](./spec.md)
**ADR**: [.specify/memory/decisions/0001-pos-operator-identity-wave1.md](../../.specify/memory/decisions/0001-pos-operator-identity-wave1.md)
**Status**: Draft (no code, no migrations)
**Created**: 2026-05-06

This document records the technical decisions for Wave 1, in the
**Decision / Rationale / Alternatives** format used by the foundation feature's
research note.

---

## R-1 — POS-facing namespace

**Decision**: `/api/pos/v1/operators/...` for Wave 1 endpoints.

**Rationale**:
- POS-Pulse PR #44 moved POS-facing endpoints to `/api/pos/v1/...`. Data-Pulse-2
  must mirror this exactly to keep contract parity.
- The foundation feature explicitly reserved this namespace
  ([specs/001-foundation-auth-tenant-store/contracts/README.md](../../001-foundation-auth-tenant-store/contracts/README.md)).

**Alternatives considered**:
- Bare `/v1/operators/...` (the original POS-Pulse PR #43 shape, before #44).
  Rejected as both repos now agree on `/api/pos/v1/...`.
- Publishing both prefixes during transition. Rejected — clutters the namespace
  and creates two surfaces to keep in sync.

---

## R-2 — Clerk JWT verification library

**Decision**: prefer `@clerk/backend` if compatible with the Data-Pulse-2 Node
runtime; otherwise fall back to `jose`. The dependency add is gated behind PR-2
(dependency-only) and is **not** added in PR-1.

**Resolved in PR-2**: `@clerk/backend@3.4.5` selected (exact pin, matches the
repo's pinned-dependency convention). Engine requirement `node >=20.9.0` is
satisfied by the Node 20 LTS pin in `package.json`; the package ships dual
CJS/ESM with no native compilation and no peer dependencies. The fallback to
`jose` was not needed. The dependency is added to `@data-pulse-2/auth`, which
already owns argon2id and the SHA-256 token-hash helper; no source code, no
controllers/services/guards, no contracts, and no schema land in PR-2.

**Rationale**:
- `@clerk/backend` is Clerk-vendored, bundles JWKS fetch + caching, exposes
  `verifyToken(...)` directly, handles `kid` rotation, and aligns with the
  POS-Pulse choice of Clerk as IdP.
- `jose` is a peer-reviewed JWT/JWKS library with a smaller surface and zero
  vendor coupling. Suitable if `@clerk/backend` pulls in incompatible runtime
  assumptions.
- Verification must happen server-side at the API edge. Symmetric secret-based
  validation libraries are rejected because Clerk uses asymmetric keys served
  via JWKS.

**Verification policy** (regardless of library):
- Validate signature, `iss` (Clerk-issued), `aud` (Data-Pulse-2 expected
  audience), `exp` (not past), `nbf` (not future), `iat` (reasonable).
- Cache JWKS with a short TTL (e.g., 5–10 minutes). Force one JWKS refresh on
  `kid` miss before failing.
- Fail closed on JWKS fetch failure — no allow-list shortcut, no cached "last
  known good".
- All verification failures → identical generic 401 envelope. The reason is
  logged server-side with `request_id`.

**Alternatives considered**:
- `jsonwebtoken` (`node-jsonwebtoken`). Rejected — no first-class JWKS handling;
  would require hand-rolling JWKS fetch and caching.
- `passport-jwt` / `passport-clerk`. Rejected — adds a Passport dependency we
  don't otherwise need; couples auth to Passport's strategy abstraction.

---

## R-3 — Stable Clerk-user mapping

**Decision**: introduce `users.clerk_user_id` (nullable, unique when set) in
PR-3. Use Clerk `sub` as the durable identifier. Email is informational only.

**Rationale**:
- `sub` is immutable per Clerk user; email can change.
- A column on `users` is the smallest schema change consistent with the
  existing identity model. The "external identities" table pattern is heavier
  and unnecessary for a single IdP.
- A partial unique index (`UNIQUE WHERE clerk_user_id IS NOT NULL`) lets
  legacy users coexist with `NULL`.

**Alternatives considered**:
- Dedicated `external_identities` table keyed by `(provider, external_id)`.
  Rejected for Wave 1 — flexibility we don't yet need; raises migration surface.
- Encoding `clerk_user_id` into existing `users.email` or `users.id`. Rejected
  — conflates identifiers and breaks the "stable id ≠ contact email" invariant.

**Wave 1 unmapped behaviour**: fail closed. A verified Clerk JWT for which no
local user mapping exists returns the generic refusal envelope. Operator
provisioning is a separate flow.

---

## R-4 — `branch_id` ↔ `store_id` mapping

**Decision**: `branch_id` is the POS-facing identifier and stays in POS-Pulse-
facing DTOs / contracts. Internally Data-Pulse-2 maps `branch_id` to `store_id`
/ `active_store_id` at the DTO/service boundary. POS-facing contracts are not
renamed.

**Rationale**:
- POS-Pulse already uses `branch_id` as its stable external identifier.
  Renaming the contract would break the consumer.
- Data-Pulse-2 already uses `store_id` internally everywhere — RLS, audit,
  BullMQ, Drizzle, schema. Renaming the internal vocabulary is a much larger
  blast radius than mapping at the boundary.
- A single translation point (the DTO resolver) is easy to audit.

**Resolution rule**: at the API boundary, `branch_id` is resolved to a
`stores.id` via a single tenant-scoped lookup. Whether the resolver matches on
`stores.id` (UUID) or `stores.code` (tenant-unique short code) depends on the
shape POS-Pulse chose for `branch_id` in the merged PR #43 contract; this is
confirmed in PR-4 when the OpenAPI YAML mirrors the POS-Pulse contract.

**Hard rule**: `branch_id` does not appear in Drizzle queries, RLS GUCs, audit
rows, BullMQ payloads, or worker code. The DTO resolver is the only translation
point.

---

## R-5 — Device-trust model

**Decision**: a `devices` table with hashed device tokens, tenant/store scope,
and revocation support. No allow-list. The schema lands in PR-3.

**Schema sketch (lands in PR-3)**:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Stable device identifier. |
| `tenant_id` | UUID NOT NULL FK → tenants(id) | RLS-scoped. |
| `store_id` | UUID NOT NULL FK → stores(id) | The terminal lives in exactly one store. |
| `device_token_hash` | BYTEA NOT NULL UNIQUE | SHA-256 of the raw device token. |
| `device_label` | TEXT | Human-readable label for ops. |
| `paired_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `revoked_at` | TIMESTAMPTZ | NULL = active. |

**Rationale**:
- A table-backed device record gives revocation, audit, and per-device scope
  enforcement, none of which a config-file allow-list can do safely.
- Hashed token with `UNIQUE` constraint mirrors the existing `auth_tokens`
  hashing pattern.
- Tenant + store scope on the device record means the sign-in path can verify
  in a single lookup that the device is permitted for the resolved
  `(tenant_id, store_id)`.

**Alternatives considered**:
- Bootstrap allow-list (env-config). Rejected — accepted only as an explicitly
  approved pilot scope, which the team has not authorised. Decision 5 in the
  ADR forbids it without explicit later approval.

---

## R-6 — Internal POS operator session token

**Decision**: an opaque random string (32 bytes base64url) hashed at rest in
`auth_tokens` with `scope = 'pos_operator'`. Returned to the POS app exactly
once. Re-uses the existing `generateRawToken()` / `hashToken()` utilities and
`AuthTokenRepository` from `packages/auth/` and `apps/api/src/auth/`.

**Rationale**:
- Re-using the existing hashing + repository surface avoids parallel code paths
  and keeps revocation centralized.
- The opaque token is server-state only. POS-Pulse never parses it; it just
  echoes it on `Authorization: Bearer ...` for subsequent backend calls.
- The token is **not** a refresh token. When it expires, POS re-runs sign-in,
  which re-verifies the Clerk JWT and the device. This is the explicit Wave 1
  policy from the ADR (D8) — "not long-lived or refreshable in Wave 1".

**Alternatives considered**:
- A signed JWT (Data-Pulse-2 issuing JWTs). Rejected — requires a signing key
  rotation story, breaks the existing instant-revocation model, and risks the
  token being mistaken for a human-identity assertion.
- A separate `operator_sessions` table. Rejected for Wave 1 — duplicates the
  `auth_tokens` surface (lookup by hash, scope-based filtering, revocation).
  The scope-aware CHECK on `auth_tokens` (R-7) makes the existing table fit.

---

## R-7 — `auth_tokens` CHECK constraint

**Decision**: scope-aware CHECK. The `pos_operator` scope permits both `user_id`
and `device_id` populated; every other scope keeps the current "exactly one"
invariant. Lands in PR-3.

**Sketch (subject to migration review)**:

```
CHECK (
  (scope = 'pos_operator' AND user_id IS NOT NULL AND device_id IS NOT NULL)
  OR
  (scope <> 'pos_operator'
     AND ((user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1))
)
```

**Rationale**:
- Preserves the original "exactly one of user-vs-device" invariant for
  dashboard and machine bearer tokens.
- Carves out `pos_operator` explicitly so the dual-bound shape is intentional
  and reviewable, not an accident.
- No new table, no new lookup path.

**Alternatives considered**:
- Globally relax to "at least one of user-vs-device". Rejected — weakens the
  invariant for unrelated scopes.
- Drop the CHECK entirely. Rejected — silently accepts both nulls, which has no
  legitimate use case.
- Separate `operator_sessions` table. Rejected (see R-6).

---

## R-8 — Generic refusal envelope

**Decision**: every Wave 1 sign-in / sign-out failure cause produces an
identical response: the canonical `{ error: { code, message, request_id } }`
shape from the foundation, at a single status code (401; 429 only if mirrored
from POS-Pulse PR #43 for rate limit). Server-side logs carry the actual
reason; the response body never does.

**Rationale**:
- Inherits FR-ISO-4 from the foundation. Consistent with the existing
  `AuthGuard` behaviour.
- Removes the most common surface for credential-stuffing and account
  enumeration attacks against the POS sign-in endpoint.

**Alternatives considered**:
- Distinguishable `device_invalid` vs `clerk_invalid` etc. for client-side
  UX. Rejected — the POS app does not need to distinguish at the network layer;
  any "show a helpful message" UX lives in POS-Pulse's local Clerk + device
  validation, before the request is sent.

---

## R-9 — Cashier PIN architectural rule

**Decision**: cashier PIN values never cross the backend boundary. This is the
primary protection. Defense-in-depth (e.g., adding `"pin"` to the audit
metadata blocked-key list in `apps/worker/src/audit/audit-fanout.processor.ts`)
is a future defensive measure and does not substitute for the rule.

**Rationale**:
- PIN verification is a terminal-local operation. There is no backend use case
  for receiving the PIN value.
- A redaction filter is best-effort (depends on field naming, on the `metadata`
  shape, and on every code path correctly routing through the filter). The
  architectural rule — "the PIN is never sent" — is checkable with a single
  contract review.

**Wave 1 enforcement**:
- The PR-4 OpenAPI contract has no PIN field on any operator endpoint.
- The PR-5 sign-in DTO has no PIN field.
- The PR-5 sign-in service has no PIN-handling code.
- Reviewer rule (cross-cutting): reject any line of code, comment, schema
  column, or contract field on the Data-Pulse-2 side that introduces a PIN
  concept.

---

## R-10 — Existing internal auth preservation

**Decision**: the existing argon2id + httpOnly cookie session auth for
dashboard / internal flows is preserved unchanged. Wave 1 introduces a parallel
POS path under `/api/pos/v1/operators/...`, served by a new module
(`PosOperatorsModule`), with no edits to `apps/api/src/auth/auth.controller.ts`,
`auth.service.ts`, `auth.guard.ts`, `auth-token.repository.ts`,
`session.repository.ts`, or `rate-limit.ts`.

**Rationale**:
- The dashboard auth path is a working, audited surface. Modifying it to
  accommodate Clerk would risk regressions on a flow that has nothing to do
  with POS.
- A separate module keeps the POS path's review surface small and isolated.

**Alternatives considered**:
- Routing POS sign-in through `AuthService.signIn(...)` with a Clerk fork
  inside. Rejected — couples two unrelated identity providers, makes the auth
  service's responsibilities ambiguous, and broadens the blast radius of any
  POS-related change.

---

## Open questions (resolved in subsequent PRs)

- **Q-A**: Carrier of the Clerk JWT (header vs body) — mirrored from POS-Pulse
  PR #43 in PR-4.
- **Q-B**: Operator-session token TTL — deployment config; not a contract
  decision.
- **Q-C**: Rate-limit status code (401 vs 429) — mirrored from POS-Pulse PR #43
  in PR-4.
- **Q-D**: Whether Wave 1 routes pre-emptively carry `@Auditable(...)`
  decorators — decided in PR-5.

---

## References

- ADR: [.specify/memory/decisions/0001-pos-operator-identity-wave1.md](../../.specify/memory/decisions/0001-pos-operator-identity-wave1.md)
- Spec: [spec.md](./spec.md)
- Foundation research: [specs/001-foundation-auth-tenant-store/research.md](../001-foundation-auth-tenant-store/research.md)
- Constitution: [.specify/memory/constitution.md](../../.specify/memory/constitution.md) v3.0.0
