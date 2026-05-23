# Contracts — Unknown Items Review Queue (Obligations only)

**Feature ID**: 006
**Spec**: [../spec.md](../spec.md)
**Plan**: [../plan.md](../plan.md)
**Created**: 2026-05-23

> **No OpenAPI YAML in 006.** Per the spec's product-level discipline (spec §0, §3) and the plan's deferral (plan §9), the dashboard-facing contracts that the review queue requires are authored in a **separate future API feature** ("the future API feature") on its own `[GATED]` slice under `packages/contracts/openapi/`. This README documents the **obligations** that the future API feature's contracts must honor, derived from spec §5–§7. Nothing here is a contract definition; everything here is a contract constraint the future API feature's contracts will be reviewed against.

---

## 1. Anticipated operationIDs (the future API feature authors them)

the future API feature's contract slice is expected to introduce, at minimum, the following dashboard-facing operationIDs (exact YAML paths, request schemas, and response schemas are the future API feature's decision):

| operationId (anticipated) | Spec source | Purpose |
|---|---|---|
| `tenantAdminListUnknownItems` | US1, US3, FR-001..005, FR-030..036 | Paginated list of `pending` unknown items in actor's scope, with filter / sort / group support. |
| `tenantAdminGetUnknownItem` | US4, FR-020..022, FR-021a, FR-080 | Detail view for one unknown item, with in-scope candidate-match hints; no descriptive metadata in v1. |
| `tenantAdminLinkUnknownItem` | US5, FR-040..043 | Link a `pending` item to an in-scope, active tenant product. |
| `tenantAdminCreateProductFromUnknownItem` | US6, FR-050..052 | Create a new tenant product from a `pending` item and bind the captured identifier as an alias. |
| `tenantAdminDismissUnknownItem` | US7, FR-060 | Dismiss a single `pending` item. |
| `tenantAdminBulkDismissUnknownItems` | FR-070, SC-008 | Dismiss up to 200 `pending` items in one request, all-or-nothing at the ceiling boundary. |
| `tenantAdminReopenUnknownItem` | US8, FR-061..063, FR-062a | **Tenant-wide actors only.** Create a fresh `pending` record via 005 FR-005; prior `dismissed` row preserved. |
| `tenantAdminListResolvedUnknownItems` | FR-001, FR-001a | Filtered list of `resolved` items; product-identity suppression per actor authority. |
| `tenantAdminListDismissedUnknownItems` | FR-001, FR-001a | Filtered list of `dismissed` items. |

the future API feature MAY merge several of these into a single endpoint with state filters (e.g., a unified list operationId with a `state` query parameter). 006 takes no position on shape — only on safety boundaries below.

---

## 2. Contract obligations

### 2.1 Authorization & object safety (Constitution §XII + spec §7)

- Every operationId MUST require an authenticated principal. Anonymous access MUST fail closed (per Constitution §XII default deny + 006 SI-008).
- `tenant_id`, `store_id`, `lifecycle_state`, `resolved_at`, `dismissed_at`, `resolved_by`, `correlation_id`, `idempotency_key`, and any audit-field MUST NOT be assignable from request bodies (mass-assignment forbidden per Constitution §XII).
- Path parameters (`unknown_item_id`) MUST be resolved server-side against the actor's authority before any read or write.
- `tenantAdminReopenUnknownItem` MUST additionally check that the principal is a tenant-wide actor (Tenant Admin / Tenant Owner) per FR-062a. Store-scoped operators MUST receive a non-disclosing rejection (see §2.3 below).

### 2.2 Multi-tenant isolation (Constitution §II + spec §7)

- Every read and write MUST be executed under a resolved tenant context (`runWithTenantContext(...)` from 001's helpers).
- Cross-tenant access MUST surface as the canonical `404` "resource does not exist" response — never `403`, never any distinct error (per Constitution §II + SI-004).
- Store-scoped operators MUST see only items captured at stores within their scope. Counters, pagination metadata, filter dropdowns, and empty states MUST respect scope.

### 2.3 Canonical error envelope (Constitution §III)

Per Constitution §III, every error MUST use the envelope `{ error: { code, message, request_id, details? } }`. The `code` field MUST be one of the following closed set (revised 2026-05-24 per [../research.md §R4](../research.md) — 006 contributes one new value `forbidden`; the originally proposed `already-terminal` was collapsed into `already-reconciled` with a `details.prior_state` discriminator):

| `error.code` | Status class | When |
|---|---|---|
| `validation` | 4xx (client) | Malformed body, unknown keys, body exceeds bulk-dismiss ceiling (FR-070), invalid product fields on create-new. |
| `target-unavailable` | 4xx (client) | Target product is retired / deleted / inactive (FR-051). |
| `alias-conflict` | 4xx (client) | Reconciliation would violate alias uniqueness (FR-041, 005 §6.5). |
| `idempotency-token-mismatch` | 4xx (client) | 001's idempotency token reused with a different payload (rare for dashboard surface; 005-style). |
| `already-reconciled` | 4xx (client) | Two cases — disambiguated via optional `details.prior_state` ∈ `{resolved, dismissed}`: (1) concurrent reconciliation race; another actor won. (2) dismiss / reopen attempt against a row already in a terminal state (US7 #3, US8 #3). |
| `not-found` | 4xx (client) | Cross-tenant or out-of-scope lookup; OR resource genuinely does not exist. **MUST be indistinguishable from cross-tenant access per SI-004.** |
| `forbidden` | 4xx (client) | Actor is authenticated, has resolved tenant context, has read authority for the target, but lacks the role required for the action. Canonical case: FR-062a in-scope reopen by a store-scoped operator. Constitution §II / §XII explicitly permit this status class for "insufficient-role within an already-resolved active tenant." |
| `system-failure` | 5xx (server) | Internal failure; safe to retry (per FR-102 + Constitution §III). |

The exact HTTP status code (e.g., 400 vs 409 vs 422 vs 403; 500 vs 503) is the future API feature's contract decision. 006 fixes only (a) the closed `code` vocabulary above, (b) the 4xx-vs-5xx class, and (c) the constitutional mappings (`forbidden` → 403-class, `not-found` → 404 per Constitution §II / SI-004).

### 2.4 Audit emission (Constitution §XIII + spec FR-110..113)

Every successful action AND every failed action whose category 005 FR-082 audits (conflict, target-unavailable, race-loser, static-state-mismatch `already-reconciled` per FR-111, `forbidden` per FR-062a) MUST emit through the existing audit pipe with at minimum:

- `tenant_id`, `store_id` (when applicable)
- `actor` (`user_id` + `actor_type`)
- `subject` (per 005 plan §3.3 — one of `unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.dismissed`, `unknown_item.reconciliation_conflict_rejected`, plus reopen-related subjects the future API feature names)
- `target` (`unknown_item_id` and target product reference where applicable)
- `correlation_id` (propagated from `request_id`)
- `timestamp`, `outcome` (success / failure + reason class)

006 introduces **no new audit subject** — the future API feature names any reopen-specific subject if it chooses to, but the audit pipe is unchanged.

### 2.5 Idempotency (Constitution §XI + spec §6)

The future API contract MAY apply 001's request-level idempotency token to mutating operationIds. 006 takes no position; if applied, the token semantics MUST be consistent with 005 FR-021a / FR-021b / FR-021c (24h TTL, fail-closed mismatch).

### 2.6 No raw entity exposure (Constitution §IV)

Per Constitution §IV "API responses MUST NOT return raw database entities," every response body MUST be an explicit projection (e.g., `toBody()` from a service-layer response object). Internal-only fields, soft-delete fields, descriptive metadata from `sale_context jsonb` (per FR-021a), and audit fields MUST never appear in responses.

### 2.7 No descriptive-metadata exposure in v1

Per FR-021a / FR-022, the v1 contract MUST NOT expose any field derived from `unknown_items.sale_context jsonb` — not in listing, not in inspection, not in any nested object. This is testable: a contract conformance test SHOULD assert that the response schema for `tenantAdminGetUnknownItem` does not declare a `sale_context` or descriptive-metadata field.

### 2.8 Candidate-match hint surface (FR-080)

`tenantAdminGetUnknownItem`'s response MUST include a `candidate_matches` array (possibly empty) sourced strictly within the actor's authorized scope. The contract:

- MUST declare the field as an array (never null when no candidates exist — empty array per FR-080).
- MUST NOT include a "no candidates found globally" indicator.
- MUST NOT rank candidates using any out-of-scope signal.
- MUST be advisory: the contract MUST NOT carry a pre-selection field; the client must explicitly call `tenantAdminLinkUnknownItem` with a chosen `target_product_id` to commit.

### 2.9 Bulk-dismiss bounds (FR-070)

`tenantAdminBulkDismissUnknownItems` MUST:

- Enforce a hard maximum of 200 items per submission.
- Reject above-ceiling submissions with `validation` (per §2.3 and FR-070); no partial-success at the ceiling boundary.
- Within a ≤ 200 submission, per-item failures (`already-reconciled` for already-terminal siblings via `details.prior_state`, `not-found` for out-of-scope siblings, etc.) are reported per FR-100 alongside the successful sibling outcomes (per SC-008).

---

## 3. What the future API feature's contract slice MUST NOT do

To stay consistent with 006:

- ❌ MUST NOT introduce a "force-link" or "override-conflict" action (SI-005).
- ❌ MUST NOT expose any field from `unknown_items.sale_context jsonb` (FR-021a, §2.7 above).
- ❌ MUST NOT introduce a new lifecycle state beyond `pending` / `resolved` / `dismissed` (FR-010, FR-011).
- ❌ MUST NOT introduce a parallel audit channel (FR-112).
- ❌ MUST NOT introduce a parallel authority / membership shape (FR-092, SI-003).
- ❌ MUST NOT distinguish "does not exist" from "exists but you cannot see it" in any response (SI-004, FR-090).

---

## 4. Conformance testing obligations (for the future API feature)

Per Constitution §IV "conformance MUST be enforced by automated contract tests," the future API feature's contract slice MUST land contract tests that verify:

1. Every operationId returns the canonical error envelope on every error path.
2. The closed set of `error.code` values matches §2.3 — no rogue codes.
3. `candidate_matches` is always an array (possibly empty); never null; never includes out-of-scope products.
4. Bulk-dismiss above 200 items returns `validation`.
5. Cross-tenant lookups return `not-found` indistinguishably from genuine not-founds.
6. Response schemas declare no `sale_context` or descriptive-metadata field.

These conformance tests are the future API feature's responsibility — 006 only enumerates them as obligations.

---

## Summary

006 produces **zero contract YAML**. the future API feature's `[GATED]` contract slice will author the YAML against the obligations above. This README is the bridge: it gives the future API feature's contract author a complete checklist of what 006's product-level spec requires the contracts to encode, and a complete checklist of what the contracts MUST NOT do.
