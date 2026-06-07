---
description: "Task list for 019 — ERPNext live stock-view (Bin) read contract"
---

# Tasks: ERPNext live stock-view (Bin) read contract

**Input**: Design documents from `/specs/019-erpnext-stock-view-contract/`

**Prerequisites**: plan.md, spec.md (user stories), research.md, data-model.md

**Constitution**: v3.0.1

**Tests**: Test tasks ARE included — §VI mandates test-first, and the buildable
deliverable is a contract + its conformance test (RED→GREEN).

**Organization**: Tasks grouped by user story. **The buildable, in-repo scope of
019 is the `[GATED]` CONTRACT slice + its conformance spec.** The DP2-facing
feed/report **runtime** and the **017-rewire** are downstream/future slices —
listed so the plan is complete, marked non-dispatchable / future, NOT built in the
019 contract slice (the 012 precedent: ship + pin the contract first).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (or SETUP / FUTURE)
- **[GATED]**: touches a forbidden surface (`packages/contracts/openapi/**`) — requires explicit approval

## Path Conventions

- Contract YAML: `packages/contracts/openapi/erpnext-connector/stock-view.yaml` **[GATED]**
- Conformance spec: `apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts`
- (Future) DP2 surface: `apps/api/src/connector/...` ; (future) 017 rewire: `apps/worker/src/erpnext-reconciliation/...`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the planning chain + grounding before authoring the contract.

- [ ] T001 [SETUP] Confirm the planning chain (spec/plan/research/data-model/tasks/analysis/review) is internally consistent and the dependency artifacts are on `main`: 014 `0018` `erpnext_warehouse_map`, 013 `0017` `erpnext_item_map`, 009 `0014` `stock_movements`, 017 `0020` reconciliation tables, 012 `posting-feed.yaml`, 018 `connectorBearer`/`ConnectorAuthGuard`. (Read-only check; no code.)
- [ ] T002 [SETUP] Re-read `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` + `apps/api/test/erpnext-connector/contract/posting-feed.contract.spec.ts` to lock the YAML conventions to mirror (strict schemas, canonical Error, `connectorBearer`, explicit-`dir` non-recursive loader). (Read-only.)

**Checkpoint**: Conventions + dependencies confirmed; contract authoring can begin under `[GATED]` approval.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The contract YAML is the foundation every user story's behavior is
expressed in. It is a single `[GATED]` artifact; the per-story acceptance is then
verified by the conformance spec.

**⚠️ CRITICAL**: The `[GATED]` CONTRACT task (T010) requires explicit approval
before authoring (Constitution §VIII, standing-rules forbidden paths). Until
approved, STOP after T002 and report.

- [ ] T010 **[GATED]** [US1] Author `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (OpenAPI 3.1) per data-model.md §2–§3: two operations — `binViewPullRequests` (`GET /api/connector/v1/erpnext/bin-view-requests`) + `binViewReportSnapshot` (`POST .../{requestRef}/snapshot`, `x-idempotency: required`); schemas `BinViewRequest`, **`BinViewItemWindow`** (the ≤500-item per-request slice — §2.1a, so the report 500-cap is a safe invariant, NOT a truncation risk), `BinViewPage`, `BinViewSnapshotReport`, `BinEntry` (incl. **`stockUom`** — the ERPNext `Item.stock_uom`, so 017 surfaces unit mismatches distinctly), `ErpnextItemRef`, `RecordedBinView` (incl. echoed **`erpnextWarehouseRef` + `readAt`** per spec US3 §2), canonical `Error`; `connectorBearer` security on both; closed error set `validation_failure | snapshot_required | idempotency_key_conflict | not_found | system_failure` (+401); exact-decimal `quantity` (no float); **no valuation/cost/price field anywhere**; `additionalProperties: false` throughout; no `tenant_id` echoed. **APPROVAL REQUIRED before this task.**

**Checkpoint**: Contract YAML exists (pending approval) — the connector repo can build against a pinned surface.

---

## Phase 3: User Story 1 - Connector reports a store's Bin view (Priority: P1) 🎯 MVP

**Goal**: The contract expresses the pull-feed + snapshot-report happy path with
correct shapes, auth, idempotency, and exact-decimal quantities.

**Independent Test**: The conformance spec loads `stock-view.yaml` (explicit `dir`)
and asserts both operations + schemas + security + the closed error set are
structurally present and well-formed; quantity is a string (never number); no
valuation field exists.

### Tests for User Story 1 (write FIRST, ensure they FAIL — RED) ⚠️

- [ ] T011 [US1] RED: `apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts` — load the YAML with an explicit `dir` (non-recursive loader, R9); assert `binViewPullRequests` + `binViewReportSnapshot` exist with stable operationIds, `connectorBearer` security, request/response schemas resolved, and `binViewReportSnapshot` declares `Idempotency-Key` required. Fails until T010 lands.

### Implementation for User Story 1

- [ ] T012 [US1] GREEN: T010's YAML makes T011 pass (the YAML IS the implementation for a contract slice). Add assertions: `BinEntry.quantity` is `type: string` (pattern, no float); the closed error-code set matches; `additionalProperties: false` on every object schema; no schema property named cost/price/valuation/amount.
- [ ] T013 [US1] Add a conformance assertion that the response/request bodies carry NO `tenant_id` and the report body has no scope field (FR-005/FR-013 strict boundary, mirroring posting-feed's body-scope rejection check).

**Checkpoint**: US1 fully verified by the conformance spec — the contract is buildable + pinnable.

---

## Phase 4: User Story 2 - Cross-tenant / out-of-scope non-disclosure (Priority: P2)

**Goal**: The contract encodes non-disclosing isolation semantics; the conformance
spec asserts the error vocabulary supports them.

**Independent Test**: The spec asserts a `404 not_found` response is declared on
both operations and that it shares the canonical non-disclosing `Error` shape (no
`details`, no cause enumeration), and that `401` is the generic refusal.

### Tests for User Story 2 (RED) ⚠️

- [ ] T020 [US2] RED: extend the conformance spec — assert both operations declare `404` (NotFound) + `401` (Unauthorized) responses bound to the canonical `Error` schema, and that the `Error` schema has no existence-disclosing fields. Fails until the YAML declares them.

### Implementation for User Story 2

- [ ] T021 [US2] GREEN: ensure T010's YAML declares `404`/`401` on both operations with the shared `Error` envelope (no `details`), matching posting-feed's `NotFound`/`Unauthorized` responses verbatim in shape.
- [ ] T022 [US2] Document in the contract description (and assert via a spec comment/check) that scope resolves from the connector principal only and body/query scope is rejected — the §XII strict boundary, mirroring posting-feed's outcome-ack note.

> NOTE: Live cross-tenant RLS sweep / RLS-bypass probe tests belong to the FUTURE
> DP2-facing runtime slice (T040), not the contract slice — there is no runtime to
> probe yet. The contract slice only proves the error *vocabulary* is present.

**Checkpoint**: US2 isolation vocabulary verified at the contract level.

---

## Phase 5: User Story 3 - Run correlation, staleness, idempotency (Priority: P3)

**Goal**: The contract encodes run correlation (`runRef`), staleness
(`snapshot_required`), the connector `readAt` vs server `recordedAt` split, and the
idempotent-replay semantics.

**Independent Test**: The spec asserts `BinViewRequest.runRef` + `RecordedBinView.runRef`
exist; `binViewPullRequests` declares `409 snapshot_required`; `binViewReportSnapshot`
declares `409 idempotency_key_conflict` + a `200` idempotent-replay with
`Idempotent-Replayed` header; `readAt` (connector) and `recordedAt` (server) are
distinct fields.

### Tests for User Story 3 (RED) ⚠️

- [ ] T030 [US3] RED: extend the conformance spec — assert `snapshot_required` (409) on the pull feed, `idempotency_key_conflict` (409) + `200` replay (with `Idempotent-Replayed` header) on the report, the `runRef` correlation fields, and the distinct `readAt`/`recordedAt` fields. Fails until the YAML declares them.

### Implementation for User Story 3

- [ ] T031 [US3] GREEN: ensure T010's YAML declares the `snapshot_required` + `idempotency_key_conflict` responses, the `Idempotent-Replayed` header, the `runRef` fields on `BinViewRequest`/`RecordedBinView`, and the §X clock split — the connector `readAt` (preserved, non-security-clock; on the report body AND echoed onto `RecordedBinView` per spec US3 §2) vs the DP2 server `recordedAt` (security clock, on `RecordedBinView`), as two distinct fields per §X / FR-016. Also assert `RecordedBinView` echoes `erpnextWarehouseRef` (spec US3 §2).

**Checkpoint**: All three stories verified by the conformance spec; the `[GATED]` CONTRACT slice is complete.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T090 [P] Cross-check the contract description self-documents: the 012 invariant (DP2 no outbound HTTP; connector calls), the 014 OQ-1 no-mirror / run-scoped-evidence stance, the DP2-side `erpnextItemRef → tenant_product_ref` translation (R4), version-independence (O-6), and the FUTURE 017-rewire pointer (R8).
- [ ] T091 [P] Update the spec's wave-status / execution-map (when authored) to mark the CONTRACT slice terminal and the runtime/rewire slices proposed-future. Update CLAUDE.md "Active feature" to note 019 contract shipped + the 017-rewire follow-up named.
- [ ] T092 Verify build is clean: `pnpm -r run build`; run the conformance spec: `wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- erpnext-connector/contract/stock-view"`.

---

## Phase 7: FUTURE / Downstream slices (NOT built in the 019 contract slice — captured for completeness)

> These are listed so the arc is legible. They are **not dispatchable in this
> contract pass**: T040 needs the contract pinned + an approved runtime design;
> T041 (the 017-rewire) is a separate spec/slice (precedent `017-RECON-WIRING`) and
> is explicitly OUT OF 019 SCOPE per FR-018 / R8.

- [ ] T040 [FUTURE] DP2-facing feed/report **runtime** (`apps/api/src/connector/...`): implement `binViewPullRequests` (project active 014 `stock` mappings + 017 run intent into `BinViewRequest` pages) + `binViewReportSnapshot` (validate, idempotency-replay, record run-scoped, translate `erpnextItemRef`→`tenant_product_ref` via confirmed 013 map). Full §VI test suite: cross-tenant sweep, RLS-bypass probe, idempotent-replay, malicious-body-scope rejection. Needs its own approval + Architecture Impact Map.
- [ ] T041 [FUTURE] **017-rewire** — make `ErpnextBinView.fetchBinView` async + report-backed (replace the synchronous `EMPTY_BIN_VIEW`); rework the run lifecycle from one-transaction-complete to request→await→report→complete. Likely a `[GATED]` outbox event-type + `worker.module.ts` wiring. SEPARATE slice (FR-018). The live ERPNext-Bin read + staging-ERPNext validation remain external prerequisites (A-2).
- [ ] T042 [FUTURE] Scheduled reconciliation (`017-SCHEDULED-RUNS`) + the cross-system live legs — gated on the connector repo's live Bin reader + staging ERPNext.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2 / T010 `[GATED]`)**: depends on Setup; **blocks** all user-story verification; **requires explicit approval**.
- **User Stories (Phase 3–5)**: all verify against the single T010 YAML. The conformance spec is incrementally extended (US1 → US2 → US3) but all assert one artifact; they can be authored in priority order or together once T010 lands.
- **Polish (Phase 6)**: after the three stories' assertions pass.
- **Future (Phase 7)**: out of this contract pass.

### Within Each User Story

- RED test (T011/T020/T030) written and FAILING before the YAML satisfies it.
- The YAML (T010) is the shared GREEN implementation; US-specific assertions
  (T012/T013, T021/T022, T031) refine the same artifact.

### Parallel Opportunities

- T090, T091 are `[P]` (different files).
- The three RED extensions touch the same conformance spec file → NOT parallel with each other.

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup → confirm conventions + deps.
2. Phase 2 `[GATED]` T010 (APPROVAL) → author the YAML.
3. Phase 3 US1 → conformance spec proves the pull/report happy path + exact-decimal + no-valuation.
4. **STOP + VALIDATE**: the contract is pinnable; the connector repo is unblocked.

### Incremental

- Add US2 (isolation vocabulary) → US3 (correlation/staleness/idempotency) → Polish.
- Each extends the one conformance spec against the one YAML; no behavioral runtime ships in the contract slice (the 012 precedent).

---

## Notes

- The ONLY forbidden surface 019 touches is `packages/contracts/openapi/**` (T010, `[GATED]`). **No migration, no schema, no `package.json`/`pnpm-lock.yaml`, no `.github/**`** (FR-009 keeps 019 off `packages/db`).
- `[Story]` labels map tasks to user stories for traceability; FUTURE tasks carry no story (cross-cutting downstream).
- Verify the contract test fails before T010 lands (RED), passes after (GREEN).
- Do NOT expand the contract slice into the runtime (T040) or the 017-rewire (T041) — those are separate, approval-gated.
