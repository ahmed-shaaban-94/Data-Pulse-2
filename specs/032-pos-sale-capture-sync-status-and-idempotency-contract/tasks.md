---
description: "Task list for Spec 032 — POS Sale Capture / Sync-Status / Idempotency Contract"
---

# Tasks: POS Sale Capture / Sync-Status / Idempotency Contract

**Input**: Design documents from `/specs/032-pos-sale-capture-sync-status-and-idempotency-contract/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/README.md, quickstart.md

> **ENUMERATED, NOT DISPATCHED (spec §11). SPECIFY-ONLY.** This task list is a plan of record for a later, owner-gated DP-2 implementation slice. Generating it authors **no** code, OpenAPI, or migration. Tasks MUST serialize on the single-writer sale files (spec §11). The four §13 owner decisions remain OPEN; tasks that depend on them are explicitly gated and live in the lowest-priority phases. Tests are included because spec §12 requires contract + idempotency + isolation tests (test-first, Constitution Principle VI).

**Tests**: INCLUDED (spec §12 requires them).

**Organization**: Grouped by user story (priority order). MVP = User Story 1 + 2 (spec §11 first slice = items 3 + 7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1..US5 mapped to spec §11 backlog items
- Exact file paths are the implementation slice's responsibility (paths below are the planned targets from plan.md "Source Code")

## Story → backlog map (spec §11)

- **US1 (P1)** Server-authoritative sale-status (§7) = §11 item 3 — MVP, owner-decision-independent
- **US2 (P1)** Read/repair surface for the Console (§9) = §11 items 7 (+ 6 classification read) — MVP, unblocks Console lane
- **US3 (P2)** Capture contract hardening: engage L1 + verify `sale.captured` producer/consumer (§6) = §11 items 1, 2
- **US4 (P2)** Refusal taxonomy + dead-letter classification (§8) = §11 items 4, 6
- **US5 (P3)** AlreadyApplied-422 path (§8/F-3) = §11 item 5 — GATED on OPEN owner decision §13 item 1
- Cross-cutting: `sales.yaml` §12 ops (§11 item 9) + migration `0025` (§11 item 8) — GATED (owner decision §13 item 4 + Principle VIII approval)

---

## Phase 1: Setup (Shared, pre-flight)

**Purpose**: Re-verify the world before any sale-file edit (spec §2 says re-verify at dispatch).

- [ ] T001 Re-fetch DP-2 `origin/main` + open PRs; re-verify F-1..F-5 still hold (capture exists; status/repair absent; L2 dedup LIVE; `sale.captured` registered; 409 live) and confirm migration next-free slot is still `0025`
- [ ] T002 Produce/refresh the Architecture Impact Map for spec 032 per `.specify/memory/architecture-impact.md` (Working Agreement pre-flight)
- [ ] T003 Confirm owner decisions §13 status before starting any GATED phase (items 1–4); record which are still OPEN

---

## Phase 2: Foundational (Blocking prerequisites)

**Purpose**: The server-authoritative status concept underpins US1+US2; it must land first. **GATED on Principle VIII approval for the migration.**

**⚠️ CRITICAL**: No user-story work begins until this phase completes.

- [ ] T004 [GATED: Principle VIII approval] Author migration `0025` for the server-authoritative sale-status (+ dead-letter/quarantine state) in the migrations directory, with paired rollback and lock-duration review (data-model.md "Server-Authoritative Sale-Status")
- [ ] T005 Define the persisted status vocabulary + allowed transitions (`captured → synced | failed-retryable | failed-needs-repair`) and the Spec-029 §6 mapping, in `apps/api/src/catalog/sales/` (no POS override; server-clock stamped)
- [ ] T006 [P] Confirm RLS policies (fail-closed) cover the new status/quarantine state; add cross-tenant index for tenant+store newest-first reads

**Checkpoint**: Status foundation ready — US1 and US2 can proceed.

---

## Phase 3: User Story 1 — Server-authoritative sale-status (Priority: P1) 🎯 MVP

**Goal**: DP-2 owns and persists an authoritative sale-status distinct from POS-local outbox UX (§7).

**Independent Test**: capture a sale → status `captured`; advance via drain → `synced`; force non-retryable failure → `failed-needs-repair`; POS cannot override (quickstart Scenarios A, E).

### Tests for User Story 1 (test-first) ⚠️

- [ ] T007 [P] [US1] Integration test: status lifecycle `captured → synced` on successful drain (Testcontainers, real Postgres)
- [ ] T008 [P] [US1] Integration test: POS cannot override server status (malicious-override probe per Principle VI)

### Implementation for User Story 1

- [ ] T009 [US1] Bind the persisted status onto the captured-sale write path in `apps/api/src/catalog/sales/` (set `captured` in the capture transaction)
- [ ] T010 [US1] Implement the status-advance on `sale.captured` drain in the worker (advance to `synced`); establish tenant context before DB access (Principle V)
- [ ] T011 [US1] Add structured logging/metrics for status transitions (correlationId, POS sync lag — Principle VII)

**Checkpoint**: US1 independently functional and testable.

---

## Phase 4: User Story 2 — Read/repair surface for the Console (Priority: P1) 🎯 MVP

**Goal**: Expose the generated-client read/repair surface (§9) the later Console consumes: status read, NEEDS_REPAIR list, sale/receipt lookup, audit timeline, server-mediated repair. **Unblocks the Console lane, independent of the §13 owner decisions.**

**Independent Test**: read a sale's status; list NEEDS_REPAIR (tenant+store scoped, newest-first, paginated); issue a server-mediated repair on a NEEDS_REPAIR item and confirm it is audited and rewrites no sale fact (quickstart Scenarios E, F, G).

### Tests for User Story 2 (test-first) ⚠️

- [ ] T012 [P] [US2] Contract test: sale-status read op conforms to the §12 `sales.yaml` surface (once authored) — happy path + cross-tenant safe-404
- [ ] T013 [P] [US2] Contract test: NEEDS_REPAIR list op — tenant+store scoping, newest-first, keyset pagination
- [ ] T014 [P] [US2] Integration test: server-mediated repair acts only on DP-2-classified NEEDS_REPAIR, is audited, performs no sale-fact rewrite, has no POS-local override path
- [ ] T015 [P] [US2] Cross-tenant + cross-store sweep + RLS bypass probe on every new read op (Principle VI)

### Implementation for User Story 2

- [ ] T016 [US2] Implement the sale-status read endpoint in `apps/api/src/catalog/sales/` (tenant+store scoped; safe-404; no raw DB entity — `toBody()` projection)
- [ ] T017 [US2] Implement the NEEDS_REPAIR list endpoint (tenant+store scoped, newest-first, keyset/cursor pagination)
- [ ] T018 [P] [US2] Implement sale search / receipt lookup endpoint
- [ ] T019 [P] [US2] Implement read-only audit/correlation timeline endpoint (028 provenance; redacted at emitter — Principle XIII/XIV)
- [ ] T020 [US2] Implement the server-mediated repair/retry op (audited; acts only on NEEDS_REPAIR; no sale-fact rewrite; no POS-local override) — repair authority posture per §13 item 3 (Console-mediated planned; confirm OPEN before final)

**Checkpoint**: US1 + US2 = MVP. Console lane unblocked.

---

## Phase 5: User Story 3 — Capture contract hardening (Priority: P2)

**Goal**: Engage L1 Idempotency-Key on capture and verify the `sale.captured` producer is bound in-transaction with a consumer drain (§6; F-4 L2 LIVE, F-5 already registered).

**Independent Test**: replay same key+body → `200` prior response, no duplicate; replay same key+different body → `409`; `sale.captured` emitted exactly once per fresh capture (quickstart Scenarios B, C).

### Tests for User Story 3 (test-first) ⚠️

- [ ] T021 [P] [US3] Integration test: L1 replay (same key+body) → prior response, no re-apply (Principle XI)
- [ ] T022 [P] [US3] Integration test: L1 key conflict (same key, different body) → `409` request-level
- [ ] T023 [P] [US3] Integration test: L1+L2 together → replay = same sale, no duplicate (G5); L2 path proven independently (do NOT rebuild L2 — F-4)

### Implementation for User Story 3

- [ ] T024 [US3] Engage the platform `idempotency_keys` seam (L1) on capture only, keyed `(tenant_id, store_id, client_id, key)` + server-clock TTL — capture-only scope per §13 item 2 (broadening is OPEN, do NOT broaden)
- [ ] T025 [US3] Verify (do NOT re-register — F-5) the `sale.captured` producer is bound and emits in-transaction; ensure the consumer drains it (links to T010)

**Checkpoint**: Capture idempotency contract complete; live L2 untouched.

---

## Phase 6: User Story 4 — Refusal taxonomy + dead-letter classification (Priority: P2)

**Goal**: Wire the §8 refusal taxonomy and dead-letter classification (RETRYABLE vs NEEDS_REPAIR), binding 401/403 to 028, preserving the live `409` (F-3), never silent drop (Principle V/XIII).

**Independent Test**: non-retryable failure → NEEDS_REPAIR with provenance intact; transient → RETRYABLE with backoff; live provenance `409` unchanged (quickstart Scenarios D, E).

### Tests for User Story 4 (test-first) ⚠️

- [ ] T026 [P] [US4] Regression test: provenance-reuse still returns `409` (`TerminalEventProvenanceConflictError`) — MUST NOT change shape (F-3)
- [ ] T027 [P] [US4] Integration test: non-retryable failure → NEEDS_REPAIR quarantine, provenance intact, never silent drop
- [ ] T028 [P] [US4] Integration test: transient/5xx → RETRYABLE with backoff; reconnect-auth-failure routes to 028 OQ-5 classification

### Implementation for User Story 4

- [ ] T029 [US4] Implement the dead-letter classifier mapping §8 conditions → Spec-029 §6 RETRYABLE / NEEDS_REPAIR in the worker; bind 401/403 to 028 by reference (G10), do NOT re-decide auth
- [ ] T030 [US4] Implement the NEEDS_REPAIR quarantine surface (feeds US2 T017); preserve 028 provenance; add metrics (failed-job rate, reconciliation mismatch rate — Principle VII)

**Checkpoint**: Taxonomy + dead-letter wired; live 409 preserved.

---

## Phase 7: User Story 5 — AlreadyApplied-422 path (Priority: P3) — GATED

**Goal**: Add a distinct `422` for genuine already-applied replay (F-3) **without** regressing the live provenance-conflict `409`.

**⚠️ GATED on OPEN owner decision §13 item 1.** Do NOT start until the owner confirms 422-vs-keep-409. If kept-409, this phase is dropped entirely.

### Tests for User Story 5 (test-first) ⚠️

- [ ] T031 [P] [US5] [GATED] Test: genuine already-applied replay → `422` (only if owner approves the distinct path)
- [ ] T032 [P] [US5] [GATED] Regression test: provenance-conflict `409` still returns `409` (422 is additive, never a replacement — F-3)

### Implementation for User Story 5

- [ ] T033 [US5] [GATED] Implement the additive `422` AlreadyApplied path, leaving the live `409` intact (only after owner decision §13 item 1)

**Checkpoint**: 422 path only exists if owner-approved; 409 never regressed.

---

## Phase 8: Polish & Cross-Cutting (GATED contract/migration + finalization)

- [ ] T034 [GATED: owner decision §13 item 4 + Principle IV] Author `packages/contracts/openapi/sales.yaml` §12 ops (stable operationId, 028 security, canonical error envelope, no raw DB entities) — timing (contract-first vs alongside) per owner decision
- [ ] T035 [P] Run quickstart.md scenarios A–G end-to-end as acceptance verification
- [ ] T036 [P] Confirm ≥80% coverage on new application code (Principle VI); contract conformance tests green in CI (Testcontainers enabled)
- [ ] T037 Update CHANGELOG.md + PR "Constitution Check" line listing principles touched (II, III, IV, V, VI, VIII, IX, X, XI, XII, XIII)

---

## Dependencies & Execution Order

### Phase dependencies

- Setup (Phase 1) → no deps; run first (re-verify the world).
- Foundational (Phase 2) → depends on Setup; **BLOCKS** all user stories. T004 GATED on Principle VIII approval.
- US1 (Phase 3) + US2 (Phase 4) → depend on Foundational; together = MVP. US2 read ops depend on US1 status (T016 needs T005/T009).
- US3 (Phase 5), US4 (Phase 6) → depend on Foundational; independently testable; US4 dead-letter feeds US2 NEEDS_REPAIR list.
- US5 (Phase 7) → GATED on owner decision §13 item 1; lowest priority.
- Polish (Phase 8) → after desired stories; T034 GATED on owner decision §13 item 4.

### Within each story

- Tests written and FAILING before implementation (Principle VI).
- Status/model before services; services before endpoints; core before integration.
- All edits to `apps/api/src/catalog/sales/` serialize on the single-writer sale files (spec §11) — do NOT parallelize same-file tasks.

### Parallel opportunities

- Setup T006 is [P]; US-test tasks marked [P] (different test files) run together; read endpoints on distinct files (T018, T019) are [P].
- **Not parallel**: any two tasks editing the same `sales/` file; GATED tasks before their owner decision lands.

---

## Implementation Strategy

### MVP first (US1 + US2)

1. Phase 1 Setup → re-verify F-1..F-5 + slot 0025.
2. Phase 2 Foundational → status foundation (T004 needs Principle VIII approval).
3. Phase 3 US1 + Phase 4 US2 → status + read/repair surface.
4. **STOP and VALIDATE**: Console lane unblocked, independent of all four §13 owner decisions.

### Incremental delivery

US3 (capture hardening) → US4 (taxonomy/dead-letter) → US5 (422, only if owner-approved) → Polish (sales.yaml + finalize).

---

## Notes

- [P] = different files, no deps. [GATED] = blocked on an OPEN §13 owner decision or Principle VIII approval — do NOT start until cleared.
- This list is the plan of record; nothing here is dispatched by this chain (spec §11). Implementation begins only on explicit owner approval per the Working Agreement.
- Hard invariants throughout: do NOT rebuild L2 (F-4), do NOT re-register `sale.captured` (F-5), do NOT regress live `409` (F-3), do NOT invent server settlement (F-2), do NOT re-decide 028 auth (G10), preserve POS → DP-2 → Connector → ERPNext.
