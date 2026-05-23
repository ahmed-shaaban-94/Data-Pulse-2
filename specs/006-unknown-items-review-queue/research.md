# Phase 0 Research: Unknown Items Review Queue

**Feature ID**: 006
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Created**: 2026-05-23

> **Scope reminder**: 006 is a product-level UX spec. The research below confirms what 006 consumes from other specs and what downstream features must produce — it does **not** investigate implementation patterns for 006 itself.

---

## R1 — 005 Wave 1 / Wave 2 readiness

**Question**: What of 005 is on `main` today (2026-05-23), and what remains the implementability gate for 006's downstream features?

**Decision**: Treat 005 Wave 1 as the *capture-path* dependency (in progress, with module skeleton + metric registration + allowlist all merged), and 005 Wave 2 (reconciliation) as the *implementation* gate for 006's downstream API + UI features. 006's spec and plan land now; 006's downstream features wait for 005 Wave 2 (which itself waits for 003 PHASE3_RED_WAVE — particularly `T350_TENANT_CATALOG_CREATE_RED` and `T383_PRODUCT_ALIASES_UNIQUENESS_RED`).

**Rationale**:

- 005's spec is merged on `main` (PR #293, `9d835eb`). Its lifecycle, idempotency, conflict, and audit semantics are stable and citable.
- 005 Wave 1 closeout (PR #305) is merged. Capture-path service code lands slice-by-slice under that wave plan.
- 005 plan §8.2 explicitly schedules Wave 2 (reconciliation) as blocked on PHASE3_RED_WAVE — that block is unchanged.
- 006's product-level guarantees consume 005's *spec*, not 005's *code*. As long as the spec is stable, 006 can be specced and planned.
- 006 introduces no schema, contract, or code, so it cannot itself bump up against the gate.

**Alternatives considered**:

- *Wait for 005 Wave 2 to ship before writing 006's spec*: rejected. The 005 spec is already settled; 006 has no reason to wait for code to author a downstream brief.
- *Make 006 a single combined feature that includes the API + UI work*: rejected. The spec brief explicitly bounded 006 as product-level only (spec §0, §3). Combining would re-introduce all the UI / API / contract churn the spec discipline holds back.

**Implication for downstream features**:

- the future API feature (future API feature) must verify, at *its* planning time, that 005 Wave 2's service surface (`TenantCatalogService.create`, `ProductAliasesService`, reconciliation services) is mergeable.
- the future UI feature (future UI feature) must verify that the future API feature's contracts are merged and stable before opening Impeccable rounds.

---

## R2 — Impeccable workflow integration

**Question**: What does the eventual `/impeccable shape` brief need from 006 to begin UI design, and what artifacts in this 006 spec PR serve that purpose?

**Decision**: The 006 spec is **the** input to `/impeccable shape`. Specifically: spec §5 (user stories with acceptance scenarios), §6 (functional requirements with FR-001a, FR-021a, FR-080 fixing the v1 surface boundaries), §7 (isolation requirements), and the [quickstart.md](./quickstart.md) walkthrough together form the product brief Impeccable consumes. No additional design-handoff document is required from 006 itself.

**Rationale**:

- Impeccable's `shape` phase converts product brief into screen structure + UX flow. It needs (a) what the user is trying to accomplish, (b) the safe boundaries the design must respect, (c) the action set with their pre- and post-conditions, and (d) the failure surface vocabulary. All four are present in 006's spec.
- spec §11 already pins the routing rule: `shape → critique → audit → polish → clarify`. No further routing meta-document is needed in 006.
- The four resolved clarifications (Session 2026-05-23) explicitly *de-scope* chrome (page size, latency, color, motion, copy) to Impeccable. This is the right boundary: 006 sets safety floors; Impeccable sets visual / interaction quality.

**Alternatives considered**:

- *Author a separate "design brief" document in 006 alongside the spec*: rejected as duplicative. The spec is the design brief once §5 / §6 / §7 / §11 / quickstart.md are read together.
- *Pre-run `/impeccable shape` from 006 to get a head-start*: rejected. spec §3 forbids UI implementation in 006; running `shape` even speculatively would create design artifacts in this PR's scope.

**Implication**:

- When the future UI feature opens, it loads spec.md + quickstart.md, then runs `/impeccable shape`. No 006-side prep work is required.

---

## R3 — Test harness extension obligations

**Question**: What test surfaces will the future API feature (the future API feature) need to extend in order to validate 006's product-level guarantees?

**Decision**: the future API feature inherits and extends three existing harnesses. Each gets a new test file family scoped to the review queue's operations. The list below is **prescriptive for the future API feature's plan**, not for 006:

1. **Isolation harness** (003 T340 pattern, located at `apps/api/test/catalog/__support__/isolation-harness.ts`) — extend with review-queue cases:
   - Cross-tenant queue list (SC-002): tenant T's admin cannot list T''s unknown items by any means.
   - Cross-store queue list (FR-001..005, SI-002): store operator at S1 sees only S1's items; counters, filters, empty states all respect scope.
   - Cross-store action attempt (US2 #2, US7 #4, US8 #5): non-disclosing not-found.
   - Reopen authority probe (FR-062a / US8 #4): store-scoped operator's reopen attempt within their scope is refused with a non-disclosing authority outcome.
   - Resolved-item product-identity suppression (FR-001a): a `resolved` item whose linked product is now unreadable to the actor shows the resolution action but suppresses the product identity.

2. **Audit-query harness** (001's audit-fanout test surface, located at `apps/worker/test/audit/**` and `apps/api/test/audit/**`) — extend with review-queue subjects:
   - All six audit subjects 005 plan §3.3 anticipates (`unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.dismissed`, `unknown_item.reconciliation_conflict_rejected`, plus the implicit `unknown_item.captured` from a reopen-triggered fresh-pending creation).
   - Reopen action: the reopen audit event and the fresh-pending capture event are both linkable to the same `correlation_id` (US8 #6).
   - Static-state-mismatch rejection on dismiss / reopen of a terminal row: surfaced as `already-reconciled` with `details.prior_state` per FR-100 (revised 2026-05-24); audit emits as a failed-attempt subject per FR-111.
   - In-scope authority failure on reopen by a store-scoped operator: surfaced as `forbidden` per FR-062a + FR-100; audit emits as a failed-attempt subject per FR-111.

3. **Contract harness** (per Constitution §IV / 005 plan §3.2 row VI) — the future API feature's `[GATED]` contract slice will need contract conformance tests for each of the operationIDs 006 plan §4.3 anticipates. 006 itself contributes the **failure-category vocabulary** that those contract tests must validate against (per [contracts/README.md](./contracts/README.md)).

**Rationale**:

- 006's SC-001..008 are measured against the existing harnesses; extending them is the canonical path.
- Constitution §VI requires Testcontainers-based isolation + RLS bypass probe + cross-tenant / cross-store sweep — these are non-negotiable for any 005 / 006 surface.

**Alternatives considered**:

- *Author standalone E2E tests for 006*: rejected. The product-level guarantees are best validated at the API-integration tier where RLS and audit emission are real, not at a mock E2E tier.

**Implication**:

- the future API feature's tasks.md must include a slice for each of the three harness extensions before any service code lands (RED-then-GREEN per Constitution §VI).

---

## R4 — Failure category vocabulary

**Question**: Is the failure category set 006 commits to (FR-100) consistent with Constitution §III's canonical error envelope and 005 FR-091's set?

**Decision** *(revised 2026-05-24 after external review)*: Consistent. 006 inherits 005 FR-091's seven categories verbatim and adds **exactly one** new category: `forbidden`. The originally proposed `already-terminal` category was **collapsed back into `already-reconciled`** with a `details` discriminator (see "Revision history" below for the reasoning). No envelope-shape change is needed; only the closed set of `error.code` values grows by one value.

**Rationale**:

- Constitution §III mandates `{ error: { code, message, request_id, details? } }` as the canonical envelope. The category vocabulary lives in `error.code`; the `details?` field is the right place for variant data within a category. Adding a new category enum value is additive and forward-compatible.
- 005 FR-091's seven categories are:
  1. `validation`
  2. `target-unavailable`
  3. `alias-conflict`
  4. `idempotency-token-mismatch`
  5. `already-reconciled`
  6. `not-found`
  7. `system-failure`
- 006 adds:
  - 8. `forbidden` — emitted when an actor is authenticated, has a resolved tenant context, and has read authority for the target row, but lacks the specific role required for the requested action. The canonical example is FR-062a: a store-scoped operator attempting to reopen an in-scope dismissed item. Constitution §II / §XII explicitly permit `403` semantics in this case ("insufficient-role within an already-resolved active tenant"). For out-of-scope targets, the platform still returns `not-found` per SI-004 — `forbidden` is used only when the actor has already proven they can see the row.
- `already-reconciled` now absorbs two sub-cases (the concurrent-write race AND the static-state-mismatch on dismiss/reopen of an already-terminal row). The response MAY carry a `details` object indicating prior state (`details.prior_state ∈ {resolved, dismissed}`) so clients can distinguish, but the closed-set vocabulary stays at one value. From the user's perspective both cases admit the same remedy (refresh, observe new state, decide if a sibling action applies), so a single category with optional discriminator is the right granularity.
- All categories continue to emit through 005 FR-082's failed-attempt audit path (per FR-111).

**Alternatives considered**:

- *Keep `already-terminal` as a distinct category*: rejected on external-review reconsideration. The case admits the same user remedy as `already-reconciled`; propagating a distinct enum value through every contract consumer (controller, conformance test, error-mapping table) is cost without benefit.
- *Reuse `validation` for the in-scope authority failure (FR-062a)*: rejected. `validation` is for malformed input; FR-062a's case is well-formed input against an authorization gate. Constitution §III's mapping is explicit on this — 403 belongs to authorization failures, not validation.
- *Reuse `not-found` for both out-of-scope AND in-scope-no-authority cases*: rejected. The in-scope case is observable to the actor (they just listed the row), so a `not-found` would contradict the actor's own evidence. Using `forbidden` is the constitutionally-sanctioned alternative.

**Implication**:

- the future API feature's contract slice must add `forbidden` to the dashboard-facing error-code enum.
- the future API feature's audit tests must verify both `forbidden` and `already-reconciled` rejections emit failed-attempt audit events with appropriate subjects.
- 006's spec FR-100 (revised) lists eight categories: 005 FR-091's seven + `forbidden`.

**Revision history**:

- *2026-05-23 (initial)*: introduced `already-terminal` as an 8th category, kept FR-062a using `validation`.
- *2026-05-24 (external review)*: collapsed `already-terminal` into `already-reconciled` with `details` discriminator; replaced `validation` with `forbidden` for FR-062a's in-scope authority case; added `forbidden` to the closed set. Net: still +1 category vs 005, but a more honest one.

---

## Summary

| ID | Topic | Status |
|---|---|---|
| R1 | 005 Wave 1 / Wave 2 readiness | Resolved — 005 spec stable; Wave 2 is the downstream implementation gate |
| R2 | Impeccable workflow integration | Resolved — spec.md + quickstart.md are the inputs; no additional handoff doc |
| R3 | Test harness extension obligations | Resolved — three harness extensions enumerated for the future API feature |
| R4 | Failure category vocabulary | Resolved (revised 2026-05-24) — `forbidden` is the only category addition; `already-terminal` collapsed into `already-reconciled` with `details.prior_state`; canonical envelope unchanged |

No `NEEDS CLARIFICATION` markers remain. All Phase 0 research items are resolved.
