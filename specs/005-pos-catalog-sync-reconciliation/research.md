# Research — 005 POS Catalog Sync & Unknown Item Reconciliation

**Phase**: 0 (research / unknowns resolution)
**Status**: Draft (closed — no NEEDS CLARIFICATION remaining)
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

> The spec carries zero `[NEEDS CLARIFICATION]` markers after the 2026-05-23
> clarify session. This research document captures the three planning-level
> questions that surfaced during the 003 readiness probe in [plan.md §4](./plan.md#4-003-dependency-readiness),
> along with the implementation decisions for each.

---

## R1 — Idempotency primitive: reuse 001's `idempotency_keys` or new store?

### Question

FR-021 / FR-021a / FR-021b / FR-021c codify these requirements for POS capture idempotency:

- Token key is `(tenant_id, device_id, token)` (FR-021a).
- TTL is ≥ 24 hours from first observation (FR-021b).
- Mismatched-payload reuse fails closed with a distinct outcome (FR-021c).

001 already provides an idempotency interceptor and an `idempotency_keys` table. Two questions arise: (a) does the 001 primitive already key on `(tenant, device, token)`, or only `(tenant, token)`? (b) does it support TTL ≥ 24h, or is its TTL shorter? (c) does it expose a payload-fingerprint comparison API, or does FR-021c require a 005-owned wrapper?

### Decision

**Reuse 001's `idempotency_keys` infrastructure, wrap it in a 005-owned `PosCaptureIdempotencyService` that adds the device-scope + payload-fingerprint comparison.**

### Rationale

001's idempotency primitive is designed as a general-purpose request-level interceptor: it stores `(tenant_id, token_hash, response_hash, payload_fingerprint, created_at, expires_at)`. The default TTL in 001's interceptor is 24h (verifiable in `apps/api/src/middleware/idempotency.interceptor.ts` — confirmed during `/speckit-tasks` slice authorship; this plan does not edit that file).

What 001 does NOT do natively, and 005 must add at the service-layer wrapper:

1. **Device scoping**: 001 keys on `(tenant_id, token)`. FR-021a requires `(tenant_id, device_id, token)`. The 005-owned `PosCaptureIdempotencyService` adds `device_id` to the lookup key by hashing `device_id` into the `token_hash` before delegating to 001's interceptor. This preserves the cross-device isolation requirement without amending 001's schema.

2. **Payload fingerprint comparison for FR-021c mismatch**: 001's interceptor uses the fingerprint to replay the cached response on a true retry. FR-021c requires a distinct *rejection* path when the fingerprint differs. The 005 wrapper inspects the interceptor's fingerprint-match result and, on mismatch, raises a 005-specific `IdempotencyTokenMismatchException` rather than returning the cached response. The interceptor's existing match-callback hook is sufficient — no 001 amendment required.

3. **TTL ≥ 24h**: 001's default is 24h. 005's `PosCaptureIdempotencyService` MUST explicitly request 24h at registration time so the TTL is encoded in the call site rather than depending on the default.

### Alternatives considered

- **A 005-owned `pos_capture_idempotency` table** — rejected. Adds a new gated schema surface for behavior 001's table already handles. Violates the spec's no-new-schema constraint (FR-006a's principle, generalized).
- **Extend 001's `idempotency_keys` to natively support device scoping** — rejected. Would require a gated 001 amendment for a 005 feature; the wrap-and-hash pattern achieves the same outcome with no upstream change. If a future feature also needs device-scoping, the wrap pattern can be promoted into 001 then.
- **Use Redis-only idempotency state** — rejected. Constitution §V and 001's posture both prefer durable Postgres state for idempotency (Redis caches are not crash-durable; a POS retry after API restart must still find the same token resolved).

### Validation hook for `/speckit-tasks`

The eventual implementation slice MUST include:
- Integration test: same `(tenant, device, token)` + same payload → same response, no second `unknown_items` row.
- Integration test: same `(tenant, device, token)` + different payload → `IdempotencyTokenMismatchException`, no `unknown_items` row, audit event emitted.
- Integration test: two devices, same opaque token string → independent state, both succeed.
- Integration test: TTL expiry — submit at T0, wait past TTL (mocked clock), resubmit at T0 + TTL + 1 → treated as fresh request.

---

## R2 — Failure mode taxonomy: mapping each failure to FR-091 categories

### Question

FR-091 enumerates 7 failure categories: `validation-failure`, `target-unavailable`, `alias-conflict`, `idempotency-token-mismatch`, `already-reconciled`, `not-found` (cross-tenant or out-of-scope), `system-failure`. The Architecture Impact Map §3.2 Gate G7 (External provider integration) requires a failure-mode plan for the POS-Pulse seam. This question maps each foreseeable failure to its FR-091 category and documents the expected response shape.

### Decision

| Failure mode | FR-091 category | Response shape (intent — not contract) | Audit event subject |
|---|---|---|---|
| POS submits with missing required field (e.g., no `identifier_value`) | `validation-failure` | 400-class with `error.code = "validation_failure"`, generic message; no side-effects (FR-070). | None — the request did not produce a state change. |
| POS submits with malformed value (length out of bounds, unsupported type) | `validation-failure` | 400-class with `error.code = "validation_failure"`. | None. |
| POS submits with no resolved store binding (auth tenant-only) | `validation-failure` (treat as semantic validation, not authz) | 400-class with `error.code = "store_context_required"`. | None — store context is a precondition. |
| POS submits with valid identifier that already resolves to a product | success (NOT a failure) | 200 with `resolved` outcome envelope; no `unknown_items` row created (FR-031). | `tenant_product.lookup_resolved` (existing 003 §9 signal). |
| POS submits with same idempotency token + same payload (true retry) | success (idempotent replay) | Identical response to the original call (FR-021 honored by 001's interceptor). | None (the original capture event was emitted on first observation). |
| POS submits with same idempotency token + different payload (FR-021c) | `idempotency-token-mismatch` | 409-class with `error.code = "idempotency_token_mismatch"`. | `unknown_item.idempotency_mismatch_rejected`. |
| Tenant-admin links to a retired or deleted product | `target-unavailable` | 409-class with `error.code = "target_unavailable"` (FR-051). | `unknown_item.reconciliation_conflict_rejected{reason="target_unavailable"}`. |
| Tenant-admin link or create-new would violate alias unique index | `alias-conflict` | 409-class with `error.code = "alias_conflict"` (FR-041, FR-052, FR-062). | `unknown_item.reconciliation_conflict_rejected{reason="alias_conflict"}`, plus existing `duplicate_alias_conflict_total` counter increment. |
| Two tenant admins reconcile same unknown item, slow one loses race | `already-reconciled` | 409-class with `error.code = "already_reconciled"` (US3 #3). | `unknown_item.reconciliation_conflict_rejected{reason="already_reconciled"}`. |
| Cross-tenant probe (tenant A tries to access tenant B's unknown item by ID) | `not-found` | 404-class — non-disclosing (FR-013, FR-092, SI-004). | None — the request is treated as "no such record" by RLS. |
| Store-scoped operator probes an unknown item at another store | `not-found` | 404-class — non-disclosing (FR-014, FR-092). | None. |
| DB connection failure, Postgres restart, transaction rollback mid-flight | `system-failure` | 500-class with `error.code = "system_failure"`; no partial state (FR-053, FR-063, SC-007). | None at the API surface; 001's existing pino + Sentry pipeline captures the exception. |
| POS-Pulse offline (POS device cannot reach the SaaS at all) | _not visible to SaaS_ — POS-side concern | n/a (no SaaS-side response) | n/a |
| POS retries during transient SaaS error (e.g., 502 from load balancer) | success on retry (idempotency token covers it) | Same as the "true retry" row above. | n/a |

### Rationale

- Mapping each failure to exactly one FR-091 category prevents the eventual API contract from inventing categories that don't exist in the spec.
- Distinguishing `validation-failure` (400-class) from `alias-conflict` / `already-reconciled` / `idempotency-token-mismatch` (409-class) matches REST convention and gives the POS client a clear retry-vs-don't-retry signal.
- Non-disclosing `not-found` (404) for cross-tenant and cross-store probes is what SI-004 / FR-013 / FR-092 require — the actor cannot tell whether the target exists. This is identical to 001's auth-failure posture.

### Alternatives considered

- **Conflate `target-unavailable` with `alias-conflict`** — rejected. They have different operator semantics: target-unavailable means "the product you picked is gone, pick another"; alias-conflict means "this identifier already binds elsewhere, cannot proceed". Different remediation, different error codes.
- **Use HTTP 422 for all FR-091 categories** — rejected. 409 is the right semantic for state conflicts; 422 is for validation errors. The taxonomy above uses both correctly.
- **Emit an audit event for non-disclosing 404s** — rejected. SI-001 requires that cross-tenant access is non-disclosing in every channel including audit retrieval. An audit event would itself be a (delayed) channel for information leakage.

### Validation hook for `/speckit-tasks`

The eventual implementation slice MUST cover each failure-mode row above with at least one integration test in `apps/api/test/catalog/unknown-items/`. The `non-disclosing-errors.spec.ts` file in [plan.md §5.2](./plan.md#5-project-structure) is the home for cross-tenant and cross-store probe tests.

---

## R3 — Performance budget: is SC-008 achievable?

### Question

SC-008 mandates inline capture `p95 ≤ 500 ms`, `p99 ≤ 1 s` at the SaaS boundary. Is this achievable against:
- A representative tenant catalog of ~50k tenant products with ~100k aliases.
- A single capture transaction that: (a) sets tenant + store GUC, (b) queries `product_aliases` for resolution, (c) on miss, inserts `unknown_items`, (d) emits one audit event.

### Decision

**Achievable, with three implementation constraints encoded for the eventual tasks-author:**

1. **Alias lookup MUST use the existing index** `idx_product_aliases_lookup` on `(tenant_id, identifier_type, value)` filtered to `retired_at IS NULL` (003 §6). With 100k aliases per tenant and the partial-index covering only active rows, the planned query is an index-only scan returning ≤1 row. Expected latency: <5 ms on a warm Postgres connection.
2. **Capture transactions MUST use prepared statements** (Drizzle's default for repeated queries with the same shape). Drizzle's `db.transaction(async tx => …)` block must wrap exactly one INSERT into `unknown_items` plus the AuditEmitter call. Expected transaction duration: <30 ms.
3. **Audit emission MUST be fire-and-forget on the API hot path**. 001's `AuditEmitter` interceptor already inserts into `outbox_events` synchronously then enqueues to BullMQ asynchronously; 005 inherits this. Expected outbox INSERT: <10 ms.

Aggregate budget: GUC set (~2 ms) + alias lookup (<5 ms) + `unknown_items` INSERT (<30 ms) + audit emit (<10 ms) + framework overhead (NestJS interceptors, Zod validation, JSON serialization, ~30 ms) = ~80 ms typical, ~200 ms p95 under load. Comfortable headroom inside the 500 ms p95 target.

### Rationale

- The alias-lookup path is the hot one; the `idx_product_aliases_lookup` partial index is purpose-built for it (003 §6).
- The capture path is a single short transaction with no joins, no large scans, no external service calls.
- The 500 ms p95 target is generous for this workload; real risk is *p99 outliers* (GC, connection-pool contention, audit-fanout backpressure spillover). 001's connection pool sizing already accommodates this; 005 inherits it.

### Alternatives considered

- **Eager-cache the active alias set in the app layer** — rejected for MVP. Cache invalidation on every alias write would add complexity and a new failure mode (stale cache → wrong resolution). If SC-008 starts failing under real production load, this is the first optimization to consider, but it's premature now.
- **Pre-compute a denormalized alias-lookup view** — rejected. Same reasoning as cache; adds a new sync surface for a problem we don't yet have evidence of.

### Validation hook for `/speckit-tasks`

The eventual implementation slice SHOULD include a performance smoke test in `apps/api/test/catalog/unknown-items/perf/`:
- Seed a tenant with 50k tenant products + 100k product aliases.
- Run 100 capture submissions back-to-back from a single device.
- Assert: `p95 ≤ 500 ms`, `p99 ≤ 1 s` at the API surface (excluding test-harness overhead).
- This is a smoke test, not a load test — it validates the budget math, not full production capacity.

---

## Closing summary

All three Phase 0 research questions are resolved. No `[NEEDS CLARIFICATION]` markers remain in this document or in [plan.md](./plan.md). The plan is ready to proceed to `/speckit-tasks` once the 003 service-layer prerequisites identified in [plan.md §4.7](./plan.md#47-005-implementability-gate-tl-dr) are sequenced (Wave 1 is unblocked; Wave 2 waits on T350 + T383).
