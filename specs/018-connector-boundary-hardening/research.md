# Research — 018 Connector Boundary Hardening v1

Phase 0 output. No `NEEDS CLARIFICATION` remained after the brainstorm design + the Session 2026-06-06 clarifications; this records the load-bearing decisions, rationale, and rejected alternatives so planning reasons from settled ground.

## R1 — Connector instance identity model

**Decision:** A thin new `[GATED]` `connector_registration` table holds the stable connector-instance identity; credentials stay in the existing `auth_tokens` store, linked by a new nullable `connector_registration_id` FK (`ON DELETE RESTRICT`). (Approach A.)

**Rationale:** `auth_tokens` already carries the credential primitives (`token_hash`, `issued_at`, `expires_at`, `revoked_at`, tenant RLS, active-token index). What is missing is a *stable identity that survives credential rotation* — the thing operators, audits, and future surfaces (020/019/023) refer to. A separate registration row gives that cleanly: rotating the secret swaps the token, not the identity.

**Alternatives rejected:**
- *All-on-`auth_tokens`* (add connector_id/site/environment columns): pollutes a shared security-critical table with connector-only columns AND identity dies with the token (rotation loses the thread). Rejected (design §1, Option B).
- *Full connector-registry subsystem* (instances + credential history + status projections as first-class domain): over-built for a boundary-hardening v1 whose non-goals defer health/status (020) and stock view (019). YAGNI. Rejected (design §1, Option C).

## R2 — Credential lifecycle & rotation

**Decision:** Immediate-revoke, atomic rotation; **at-most-one active (unrevoked) credential per registration.** Rotate = (verify registration exists/tenant/not-disabled) → revoke existing unrevoked connector credential(s) → insert the new connector-scoped token linked to the same registration → audit → return the raw secret once; all in one transaction. If the insert fails, the transaction rolls back and the old credential stays active.

**Rationale:** 018 is boundary hardening, not zero-downtime automation. The connector is a controlled server the operator reconfigures during rotation, so an immediate cutover is acceptable; a grace window would add multi-active semantics, more audit complexity, and harder guard behavior for no v1 benefit.

**Invariant enforcement:** DB partial-unique `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL` — an **immutable** predicate. Expiry is deliberately NOT in the predicate (`now()` is STABLE, not IMMUTABLE — a partial-index predicate referencing it is rejected by Postgres). Expiry is enforced at the guard (reject expired) + lifecycle maintenance (revoke expired). This mirrors the 009 EXCLUDE-constraint approach (migration 0016).

**Alternative rejected:** grace-window / overlap rotation — deferred to a later explicit design if pilot ops prove it necessary.

## R3 — DB CHECKs, preflight-gated

**Decision:** Two CHECKs, each gated on a preflight that **STOPs for owner decision** on stray/legacy rows (never silent-normalize):
1. **Scope enum** — pin `auth_tokens.scope` to the known set (`dashboard_api`,`pos`,`pos_operator`,`connector`,`password_reset`,`email_verify`). Closes the free-TEXT gap. Preflight = distinct existing scope values.
2. **Connector-token consistency** — `scope='connector'` iff `connector_registration_id IS NOT NULL`. Preflight = existing connector tokens.

**Rationale:** `scope` is currently free TEXT (verified in `auth_tokens.ts`) — the looseness 018 targets. But blind CHECKs would break legacy rows. Preflight first; if clean, backfill-then-CHECK in the same gated slice; if not, the CHECK becomes a named follow-up. (Open questions 4/5 in the spec.)

## R4 — Guard tightening

**Decision:** `ConnectorAuthGuard` resolves + validates the full registration-linked usability rule via a **connector-only lookup** (`findActiveConnectorCredentialByRawToken`-style), attaches the calling instance identity to the request, and rejects all failures non-disclosingly. The generic dashboard/POS token path is untouched.

**Rationale:** Today the guard is binary (`scope==='connector'` → allow). Tightening it without a connector-specific path would risk changing dashboard/POS behavior (FR-019 forbids that). A separate lookup isolates the change.

## R5 — Auth primitive reuse

**Decision:** The connector secret is hashed and stored via the existing opaque-bearer mechanism (the `auth_tokens.token_hash` path). No new auth primitive.

**Rationale:** §III / spec assumption — reuse the proven, revocable opaque-bearer path; 018 adds identity + lifecycle on top.

## R6 — Admin surface form (open question, decided at task time)

**Recommendation:** REST admin endpoints under `cookieAuth`/`DashboardAuthGuard` (the 013/014/017 human-Tenant-Admin pattern), with a `[GATED]` OpenAPI contract (gate pre-approved). A CLI/seed-only path is the fallback if REST proves out of scope. Decided when the CONTRACT slice is dispatched.

**Rationale:** operators need a usable surface to register/issue/rotate/revoke; REST matches every other operator-facing DP2 feature. Deferred to task time only because it's the one place a forbidden-path (OpenAPI) artifact is conditional.

## R7 — Observability signal (clarification Q3)

**Decision:** An unlabeled counter for lifecycle actions (issue/rotate/revoke/disable + register) on the shared `api.metrics.ts` surface — no per-instance/tenant/secret labels.

**Rationale:** mirrors the 010 `catalog_unpriced_issue_rate` / 015 / 017 signal pattern (shared file, unlabeled, cardinality + §XIV safe). Audit covers evidence; this covers operational visibility.
