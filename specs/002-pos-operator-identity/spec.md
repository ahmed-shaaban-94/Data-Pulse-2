# Feature Specification: POS Operator Identity — Wave 1

**Feature ID**: 002
**Short name**: pos-operator-identity
**Status**: Kickoff (no implementation)
**Created**: 2026-05-06
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.0
**ADR**: [.specify/memory/decisions/0001-pos-operator-identity-wave1.md](../../.specify/memory/decisions/0001-pos-operator-identity-wave1.md)

---

## 1. Background & Why

POS-Pulse 004 requires backend operator sign-in / sign-out endpoints served by
Data-Pulse-2. POS-Pulse PR #43 set the contract of record to use Clerk JWT
verified via JWKS for operator identity. POS-Pulse PR #44 set the namespace at
`/api/pos/v1/...`. POS-Pulse Sprint 1 is blocked until Data-Pulse-2 Wave 1
ships.

Wave 1 alignment was approved with two key decisions: Clerk JWT verification at
the Data-Pulse-2 edge (Q1 = Yes), with POS-Pulse holding the Clerk JWT and
Data-Pulse-2 verifying it via JWKS (Q2 = path b). Cashier PIN remains terminal-
local and never crosses the backend boundary.

This is **specification-only** — no application code, no migrations, no OpenAPI
YAML. Implementation lands in subsequent gated PRs.

---

## 2. Goals (Wave 1)

- Provide two endpoints for POS-facing operator session lifecycle:
  `POST /api/pos/v1/operators/sign-in` and `POST /api/pos/v1/operators/sign-out`.
- Verify Clerk JWT via JWKS at the Data-Pulse-2 API edge.
- Establish a stable mapping between Clerk users and Data-Pulse-2 users via
  `users.clerk_user_id`.
- Enforce device-trust validation alongside human identity at sign-in.
- Issue an internal opaque POS operator session token whose scope is
  `pos_operator` and whose role is operator-session state only.
- Preserve the existing argon2id + cookie session auth for dashboard / internal
  flows. Wave 1 must not weaken or alter that path.

## 3. Non-Goals

- Operator roster (`GET /api/pos/v1/operators/roster`).
- Operator takeover (`POST /api/pos/v1/operators/takeover/confirm`).
- Operator active-session lookup (`GET /api/pos/v1/operators/active-session`).
- POS-originated audit ingestion (`POST /api/pos/v1/audit-events`).
- Forced shift close.
- Sales, cart, payment, refund, or any retail-domain endpoints.
- Cashier PIN handling of any kind on the backend.
- Refresh-token semantics for the operator session token.
- JIT operator provisioning at sign-in.
- Dashboard / frontend / analytics / billing.

---

## 4. Actors

| Actor | Description |
|---|---|
| **Operator** | A human cashier or floor staffer authenticated through Clerk on the POS terminal. |
| **POS terminal** | A registered device whose `device_token` is paired to a specific tenant + store. |
| **POS-Pulse client** | The POS application that holds the Clerk JWT and the device token, and calls Data-Pulse-2 sign-in / sign-out on the operator's behalf. |

Cashier PIN is **not** an actor in this spec. It does not cross the backend
boundary in any form.

---

## 5. Wave 1 endpoints

### 5.1 `POST /api/pos/v1/operators/sign-in`

**Inputs (POS-facing names)**:
- Clerk JWT (carrier — header vs body — must match the merged POS-Pulse PR #43
  contract verbatim; PR-4 will mirror it).
- `branch_id` — POS-facing identifier; mapped to `store_id` internally.
- `device_token` — opaque per-terminal token.

**Behaviour**:
1. Verify Clerk JWT against Clerk JWKS (signature, `iss`, `aud`, `exp`, `nbf`,
   `iat`). Cache JWKS short-TTL; force one refresh on `kid` miss; fail closed on
   JWKS fetch error.
2. Extract the stable Clerk subject (`sub`) → look up `users.clerk_user_id`. No
   JIT provisioning. Unmapped → generic refusal envelope.
3. Resolve `branch_id` → `store_id` and its parent `tenant_id`.
4. Verify the operator has an active membership for the resolved `tenant_id`
   that permits the resolved `store_id`.
5. Verify the device token: hash, look up in `devices` for the resolved
   `(tenant_id, store_id)`, ensure it is not revoked. Constant-time hash
   comparison.
6. Issue an internal opaque POS operator session token (scope `pos_operator`)
   bound to the operator user, the device, and the resolved `(tenant_id,
   store_id)`. Returned exactly once. Hashed at rest.

**Failure**: any failure returns the generic refusal envelope. The response
body does not distinguish causes (FR-ISO-4 inheritance).

### 5.2 `POST /api/pos/v1/operators/sign-out`

**Inputs**: `Authorization: Bearer <operator_session_token>`.

**Behaviour**: revoke the bearer token. Idempotent — already-revoked tokens
return the generic refusal envelope. Clerk session lifecycle is Clerk's;
Data-Pulse-2 does not attempt to revoke the Clerk session.

---

## 6. Functional requirements (selected)

- **FR-POS-AUTH-1**: Wave 1 sign-in requires a verifiable Clerk JWT. Failure to
  verify returns the generic refusal envelope.
- **FR-POS-AUTH-2**: Sign-in requires a valid `device_token` paired to the
  resolved `(tenant_id, store_id)`. Failure returns the generic refusal envelope.
- **FR-POS-AUTH-3**: The operator's `users.clerk_user_id` must be pre-mapped.
  Unmapped Clerk users return the generic refusal envelope. There is no JIT
  provisioning at sign-in.
- **FR-POS-AUTH-4**: The internal POS operator session token has scope
  `pos_operator` and is rejected on non-POS routes by a scope guard. Conversely,
  dashboard cookies and non-POS bearer tokens are rejected on POS routes.
- **FR-POS-AUTH-5**: The POS operator session token is operator-session state
  only. It is not refreshable in Wave 1, not used as a human identity carrier,
  and does not replace Clerk identity.
- **FR-POS-AUTH-6**: Every Wave 1 sign-in / sign-out failure produces an
  identical response envelope. The actual cause is logged server-side with
  `request_id` and never returned to the client.
- **FR-POS-AUTH-7**: `branch_id` is the POS-facing identifier. It is mapped to
  internal `store_id` only at the DTO/service boundary and never appears in
  Drizzle queries, RLS contexts, audit rows, or BullMQ payloads.
- **FR-POS-AUTH-8**: Cashier PIN values must never be sent to, received by,
  stored by, logged by, audited by, or included in any worker payload of
  Data-Pulse-2.
- **FR-POS-AUTH-9**: Existing argon2id + cookie auth for dashboard / internal
  flows is preserved unchanged. No code in `apps/api/src/auth/` is altered for
  Wave 1.
- **FR-POS-AUTH-10**: The Clerk JWT is verified at the API edge and is not
  propagated past the verifier. It must not be logged, persisted, enqueued, or
  used as the long-lived in-system credential.

---

## 7. Out of scope for Wave 1 (explicit)

- Roster, takeover, active-session lookup, audit-events ingestion, forced-close.
- Sales / cart / payments.
- Dashboard / frontend.
- Analytics / reports / dbt.
- Billing.
- Any change to existing argon2id / cookie session auth behaviour.

---

## 8. Wave 1 implementation gates (PR sequence)

1. **PR-1** (this PR) — ADR + spec kickoff.
2. **PR-2** — dependency-only Clerk verifier.
3. **PR-3** — schema-only (`users.clerk_user_id`, `devices` table, scope-aware
   `auth_tokens` CHECK, FK).
4. **PR-4** — OpenAPI contract-only (`pos-operators.openapi.yaml`).
5. **PR-5** — sign-in implementation.
6. **PR-6** — sign-out implementation + scope-leakage probe.

POS-Pulse Sprint 1 unblocks at PR-6 merge.

---

## 9. Open questions (deferred to subsequent PRs)

- Carrier of the Clerk JWT in the request (header vs body) — must mirror the
  merged POS-Pulse PR #43 contract verbatim. **Resolved in PR-4**: header.
  `Authorization: Bearer <clerk_jwt>` on `POST /api/pos/v1/operators/sign-in`,
  modelled in OpenAPI as the `clerkJwt` security scheme (HTTP bearer, JWT
  format). Sign-out uses an analogous `posOperatorSession` bearer scheme.
  The Clerk JWT never appears in the request body.
- Operator session token TTL — deployment configuration decision; not a Wave 1
  contract decision.
- Rate-limit response code (401 vs 429) — must mirror POS-Pulse contract.
  **Resolved in PR-4**: 401 for every Wave 1 sign-in / sign-out refusal,
  including rate-limit exhaustion. Returning a single status code keeps the
  response body and status line both minimum-disclosure (FR-POS-AUTH-6 +
  FR-ISO-4 inheritance) — a 429 would itself disclose "rate-limited" as a
  distinct cause. Server-side back-pressure remains free to log
  rate-limited refusals separately by `request_id`.
- Whether to pre-emptively decorate Wave 1 routes with `@Auditable(...)` so they
  light up automatically once `AuditModule` ships. Decision deferred to PR-5.

---

## 10. References

- ADR: [.specify/memory/decisions/0001-pos-operator-identity-wave1.md](../../.specify/memory/decisions/0001-pos-operator-identity-wave1.md).
- Owner-approved plan: [specs/pos-pulse-004-backend-wave1-plan.md](../pos-pulse-004-backend-wave1-plan.md) — local planning artifact, untracked.
- PR sequence: [specs/pos-pulse-004-backend-wave1-pr-sequence.md](../pos-pulse-004-backend-wave1-pr-sequence.md) — local planning artifact, untracked.
- Foundation feature: [specs/001-foundation-auth-tenant-store/spec.md](../001-foundation-auth-tenant-store/spec.md).
- Constitution: [.specify/memory/constitution.md](../../.specify/memory/constitution.md) v3.0.0.
- POS-Pulse PR #43 (Endpoint 2 contract — merged) and POS-Pulse PR #44
  (namespace move to `/api/pos/v1/...` — merged).
