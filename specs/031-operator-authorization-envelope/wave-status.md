# Wave Status — `031-operator-authorization-envelope`

> Human-readable summary of where the spec stands. 031 is the **D1+D2 operator-authorization
> envelope**: at POS-operator sign-in, DP-2 now **returns** the opaque `pos_operator` bearer
> envelope it already mints (it was previously generated and discarded), the three POS sale
> write routes (`captureSale` / `recordVoid` / `recordRefund`) are **re-wired** onto the
> canonical envelope-bearer guard, and the legacy Option-Y `PosOperatorSaleAuthGuard` is
> retired — with live revocation preserved per-request (Option B).

**Last updated:** 2026-06-12 by Ahmed Shaaban — **CLOSED.** Implementation shipped via
**PR #559 (`202d253`)** (squash-merged to `main`).
**Spec:** `031-operator-authorization-envelope` (`specs/031-operator-authorization-envelope/`)
**Base:** `main`.
**Status:** **CLOSED — all 10 tasks (T0–T10) complete.** The envelope is minted, returned,
documented in two `[GATED]` contracts, and the sale write routes are on the canonical
envelope-bearer path with the live revocation predicate intact. **No schema change** (OQ-1 =
1-A-i reuses the existing `auth_tokens` row — no migration, no-G3 held).

### What shipped (PR #559 `202d253`)

- **T1+T2 — envelope returned at sign-in + takeover-confirm (D1 issuance half, G-1).**
  `issueOperatorSessionRow` stops discarding `generateRawToken()` and returns it as
  `envelope`; `token_hash` + the `auth_tokens` row are unchanged. The sign-in / takeover
  response DTO (`PosOperatorSessionSummary`) carries a **nullable** `envelope` alongside
  `{ id, issued_at }` — null on replay (raw is hash-once, not recoverable). Raw is never
  logged or audited (G-7).
- **`[GATED]` contract surface #1** — `packages/contracts/openapi/pos-operators.openapi.yaml`:
  `PosOperatorSessionSummary` gains the nullable `envelope` field (G2).
- **T3+T5+T6 — re-wire + live predicate + retire Option-Y (D2 phantom + D1 use half).**
  The three sale write routes move off `PosOperatorSaleAuthGuard` (Option-Y) onto a new
  `PosOperatorEnvelopeSaleGuard` (canonical opaque `pos_operator` bearer auth +
  `reverify()`), which after accepting the envelope **re-resolves the live predicate**
  (membership not revoked/deleted · device active · store-access · role eligibility) via the
  existing `OperatorContextResolver` — restoring Option-Y's per-request liveness behind the
  envelope credential (G-4 / A-4). The guard **publishes `request.context`** from the
  envelope principal's server-side binding (never the body) after reverify passes. Option-Y
  is retired from the three routes; no parallel path retained (A-3, no DOC-3 mismatch).
- **`[GATED]` contract surface #2** — `packages/contracts/openapi/pos-sales/sales.yaml`:
  introduces the **new distinct** `operatorAuthorization` security scheme (opaque bearer, NO
  `bearerFormat` — the envelope is not a JWT) and applies it to the three sale routes,
  replacing `clerkJwt`. **NOT** 030's `operator-identity` (identity-proof-only). `operationId`s
  unchanged (no breaking rename) — OQ-5 / G2 / DOC-3 co-travel (028 §19).
- **Tests (T8/T9, TDD RED→GREEN watched).** Unit: sign-in returns a non-empty envelope;
  envelope → `findActiveByRawToken` → `pos_operator` principal satisfies the canonical guard;
  sign-out `revoked_at` invalidates it. Integration (RLS-aware, skip-guarded without Docker):
  capture/void/refund via the envelope succeed with the same membership/store/eligibility
  outcomes; device-only / provider-JWT-only rejected; provenance unchanged. The **G-4
  live-predicate regression** (T9): revoking membership / device / store-access mid-session
  stops further sales — fails a naive re-wire that omits T5, passes with it. Contract
  conformance gates both `[GATED]` files. Unit 20/20 + the new CTX-guard regression.

### Key resolved design decisions

- **T4 — G-4 live-predicate mechanism (was the load-bearing fork): RESOLVED → Option B for
  v1.** Code evidence (2026-06-12) showed **no** revocation→`auth_tokens` propagation exists
  on **any** axis — membership-revoke and store-access-pull never touch `auth_tokens`, and
  device-revoke has **no write path at all** (only reads `revoked_at IS NULL`). So Option A
  ("just wire it up") is actually a greenfield multi-surface reconciliation subsystem.
  Option B (re-resolve the predicate per request, reusing `OperatorContextResolver`) is the
  minimal delta that preserves today's liveness and keeps no-G3. **Option A is the documented
  end-state**, owned by the future **028 §9 event-driven reconciliation** spec — when it
  lands, this per-request re-resolution may be retired in favor of revoke-on-event.

### CodeRabbit / review

- PR #559 CodeRabbit review **SUCCESS**, no unresolved actionable findings.
- The mid-build fix (`fix(031): envelope guard must publish request.context`) closed a gap all
  green suites missed — the capture harness no-ops the guard + injects context globally, so
  the guard swap silently dropped `request.context` until the new CTX-guard unit test caught
  it. Regression-guarded.

### CI / merge

- First CI run failed `db-integration` on a **hosted-runner flake** (Postgres `57P01`,
  "terminating connection due to administrator command", on two suites — `memberships.controller`,
  `connector-sweep` — that 031 does **not** touch). The branch was also 2 commits behind
  `main`. Rebased onto `origin/main` (clean, no conflicts) → re-ran **fully green**
  (`fast` + `db-integration` + CodeRabbit) → squash-merged.

### Deferrals / downstream (recorded, NOT this slice — all cross-repo or future-spec)

- **D5** — POS adopts/presents the envelope on the three write routes. Hard-gated on D1
  (now shipped). **POS is a separate repo** — out of scope here.
- **D7** — the device token reverts to device-scoped once D5 lands. Follows D5.
- **D6** — POS offline-PIN re-anchor; needs 029 (D3, SHIPPED) + the D1/D5 envelope carrying
  `user_id`.
- **Option A end-state** — 028 §9 event-driven `auth_tokens` reconciliation; retires the
  per-request re-resolution. Future spec, not 031.

> **Boundary note:** 031 is the DP-2 (platform) half only. The POS-side adoption (D5/D6/D7)
> lives in the separate POS repo and is not tracked by this wave-status.
