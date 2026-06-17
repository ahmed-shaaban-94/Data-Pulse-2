---

description: "Task list — DP-012 posting-feed settlement extension"
---

# Tasks: DP-012 Posting-Feed Settlement Extension

**Input**: Design documents from `/specs/036-settlement-posting-feed-extension/`

**Prerequisites**: plan.md ✅, spec.md ✅. (research.md / data-model.md / quickstart.md are Phase-1 follow-ons; this tasks.md is authored at the spec→plan→tasks depth ratified by AD-SALE-SETTLEMENT-3 Option A.)

> **GATED-BOUNDARY NOTE — read before executing anything.** Per Orchestrator decision **AD-SALE-SETTLEMENT-3 (RATIFIED Option A)** this feature is authorized to **spec/plan/tasks only — STOP before `implement`.** Tasks below are tagged:
> - **`[SPEC]`** — in-scope now (design/requirements artifacts; no production code).
> - **`[GATED-CONTRACT]`** — authoring `posting-feed.yaml`; requires a *separate* owner approval (crosses the no-OpenAPI gate). **DO NOT execute in this feature.**
> - **`[GATED-IMPL]`** — DTO/projection/migration/test code; requires the contract merged **and** the SIGNED `011-DR-POSTING-R1` lifted. **DO NOT execute in this feature.**
>
> Executing any `[GATED-*]` task without its named approval is a STOP-and-raise condition.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 from spec.md

---

## Phase 1: Spec-level design (in scope — `[SPEC]`)

- [ ] T001 `[SPEC]` Author **research.md**: record the decision that the extension is additive to 012 (not a new transport); cite `posting-feed.yaml:46-52` deferral promise; confirm 035 as the settlement-side payments-model candidate.
- [ ] T002 `[SPEC]` In research.md, **scope R1 gate #1** (FR-009): does the 035 settlement model satisfy R1's "DP2 tender/payment fact model" *as written* (R1 was at-sale/015 context)? Record fitness verdict OR named residual — **decision feeds the owner's R1 lift; does not lift R1.**
- [ ] T003 `[SPEC]` In research.md, **scope R1 gate #4** (FR-010): payment repair/reconciliation semantics (017 boundary extended to payment outcomes). Decide own-here vs. dedicated follow-up feature; name it as an R1-lift prerequisite either way.
- [ ] T004 `[SPEC]` Author **data-model.md**: describe the settlement work-item **fields** at requirement level (payer/debtor ref, amount+currency [exact-decimal], business date, receivable/sale provenance, target ERP Sales-Invoice ref, idempotency anchor) and their meaning — **NOT** YAML/schema. State exact-decimal money + no-`tenant_id`-on-wire + no-credentials invariants.
- [ ] T005 `[SPEC]` Author **quickstart.md**: how a conformance/projection test would exercise US1–US3 (emit settlement item; old-consumer backward-compat; fail-to-DLQ; idempotency) — described, not coded.
- [ ] T006 `[SPEC]` Record the **R1 four-gate status table** (gate #2 → "spec'd by 036"; #1/#3/#4 each named owner + status) so the owner can make the lift decision from a complete picture (SC-004).

**Checkpoint:** Phase 1 complete = the spec-level deliverable AD-3 Option A authorized. **STOP HERE** until the owner approves crossing the contract gate.

---

## Phase 2: Contract authoring (`[GATED-CONTRACT]` — separate owner approval required)

- [ ] T007 `[GATED-CONTRACT]` US1 Add the additive settlement `kind` value + payload schema to `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` (versioned, backward-compatible).
- [ ] T008 `[GATED-CONTRACT]` US3 Bump the contract version + extend the conformance suite so pre-extension consumer expectations still pass (backward-compat proof, SC-001).
- [ ] T009 `[GATED-CONTRACT]` US1 Define the settlement work-item's `ackOutcome` shape (Payment-Entry ERP references returned) within the existing `connectorAckOutcome`.

---

## Phase 3: Projection + DLQ runtime (`[GATED-IMPL]` — contract merged AND R1 lifted)

- [ ] T010 `[GATED-IMPL]` US1 Project an approved 035 settlement event into a settlement work-item on the feed (only from approved/settled state — FR-004).
- [ ] T011 `[GATED-IMPL]` US2 Fail-to-DLQ in DP-2 when a settlement work-item is unresolvable (no invoice target / unresolved payer) **before** offering it (FR-005).
- [ ] T012 `[GATED-IMPL]` US1 Supply the wire idempotency anchor so re-projection collapses to one logical posting (FR-006; exactly-one Payment Entry downstream).
- [ ] T013 `[GATED-IMPL]` US1/US2 Tests: projection emits for resolvable, DLQs for unresolvable (SC-002); idempotency collapses duplicates (SC-003).
- [ ] T014 `[GATED-IMPL]` Verify no `tenant_id`/credentials on the wire; RLS fail-closed on the projection read (Constitution II/III).

---

## Phase 4: R1-lift prerequisites tracking (cross-feature — owner-owned)

- [ ] T015 `[SPEC]` Hand the completed R1 four-gate status (T006) to the owner as the input to the **R1 rider amendment** decision. **This feature does not sign the amendment.**

---

## Dependencies & Gating Summary

- **Phase 1 (`[SPEC]`)** is the only phase in scope now.
- **Phase 2 (`[GATED-CONTRACT]`)** blocked on: owner approval to cross the no-OpenAPI gate.
- **Phase 3 (`[GATED-IMPL]`)** blocked on: Phase 2 merged on `origin/main` + **`011-DR-POSTING-R1` lifted** (owner-signed amendment confirming gates #1–#4).
- **Connector-009** (separate repo) blocked on Phase 3 merged + R1 lifted — out of scope here.
