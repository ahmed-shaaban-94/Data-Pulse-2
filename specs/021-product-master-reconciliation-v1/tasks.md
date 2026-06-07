---
description: "Task list — 021 Product-Master Reconciliation v1"
---

# Tasks: Product-Master Reconciliation v1

**Input**: Design documents from `/specs/021-product-master-reconciliation-v1/`

**Prerequisites**: plan.md, spec.md (user stories), research.md, data-model.md

**Tests**: Tests ARE included and are MANDATORY (Constitution §VI — RED→GREEN,
Testcontainers isolation, cross-tenant sweep, RLS-bypass probe, malicious-override).

**Organization**: Grouped by user story so each ships independently. US1 (P1) is the
connector-free MVP; US2 (P2) repair; US3 (P3) the connector-gated run.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (or SETUP / FOUND / POLISH)
- **[GATED]**: touches a forbidden surface (`packages/db/**`, `packages/contracts/openapi/**`,
  migrations) — requires explicit `[GATED]` approval before authoring; not buildable in a normal slice
- Exact file paths included

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [SETUP] Confirm branch + spec dir; verify 013 (`erpnext_item_map`) and 003 (`tenant_products`) are on `main` and readable; record the indicative next migration number (`0022`) and the `EXPECTED_MIGRATIONS`/`EXPECTED_CATALOG_MODULES` current tails (research R10).
- [ ] T002 [SETUP] Author `execution-map.yaml` + `wave-status.md` for 021 (slice state, allowed/forbidden files, validation contract) per the Maestro playbook.
- [ ] T003 [P] [SETUP] Architecture Impact Map for 021 (per `.specify/memory/architecture-impact.md`) — the new module, the read-only deps (013/003/008), the `[GATED]` surfaces.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: blocks ALL user stories.

- [ ] T004 [GATED] [FOUND] Author the `[GATED]` SCHEMA: Drizzle schema `packages/db/src/schema/catalog/erpnext-product-reconciliation.ts` (run + result + repair_attempt per data-model §2) — requires `[GATED]` approval.
- [ ] T005 [GATED] [FOUND] Author the `[GATED]` migration `packages/db/drizzle/0022_erpnext_product_reconciliation.sql` + paired `0022_..._down.sql` (RLS ENABLE+FORCE, empty-GUC CASE guard, SELECT/INSERT/UPDATE on run+result, INSERT+SELECT on repair_attempt, NO DELETE policy, all CHECK constraints) — requires `[GATED]` approval; lock-duration review; CHANGELOG entry.
- [ ] T006 [GATED] [FOUND] Update drift allowlists in lockstep: `EXPECTED_MIGRATIONS` (+`0022`), `EXPECTED_CATALOG_MODULES` (+ new module), and re-call `ensureAppRole` AFTER the migration in the new migration spec (research R10 / the #447/#487 gotcha).
- [ ] T007 [GATED] [FOUND] Author the `[GATED]` operator contract `packages/contracts/openapi/catalog/product-reconciliation.yaml` (5 operationIds, `cookieAuth`, namespace `/api/v1/catalog/erpnext-product-reconciliation`, uniform error envelope) per data-model §5.1 — requires `[GATED]` approval.
- [ ] T008 [FOUND] Build `packages/db` + `packages/contracts` dist so api/worker tests resolve the new schema + contract (the documented build-order gotcha).
- [ ] T009 [FOUND] Scaffold the api module `apps/api/src/modules/catalog/erpnext-product-reconciliation/` (module + empty service/controller + DTO files) wired with `DashboardAuthGuard` (default-deny, §XII).

**Checkpoint**: schema + contract + module skeleton ready.

---

## Phase 3: ISOLATION-HARNESS (Blocking for all stories)

- [ ] T010 [FOUND] Extend the catalog Testcontainers isolation harness with 021 seed fixtures (a tenant with: confirmed-active mapping, suggested-only mapping, no-mapping product, retired-confirmed mapping; a second tenant for cross-tenant sweeps). Model on the 013/017 seed pattern; do NOT edit the shared `isolation-harness.ts` setup.
- [ ] T011 [FOUND] RLS-bypass probe + cross-tenant sweep skeleton over the 3 owned tables (raw SQL with the wrong tenant → zero rows; §VI). RED until the schema migration is applied; GREEN after T005.

---

## Phase 4: User Story 1 - Unmapped-product backlog (Priority: P1) 🎯 MVP

**Goal**: a tenant-scoped live read-projection of active products lacking a confirmed-and-active 013 mapping, classified + paginated.

**Independent Test**: seed mixed mappings → list as tenant admin → only unmapped/unconfirmed appear, correctly classified, cross-tenant non-disclosing.

### Tests (RED first) ⚠️

- [ ] T012 [P] [US1] Contract conformance test for `listProductReconciliationBacklog` against `product-reconciliation.yaml` (RED).
- [ ] T013 [P] [US1] Integration test: the backlog read-projection classifies `unmapped_dp2_product` vs `suggestion_unconfirmed`, excludes confirmed-active, re-includes a retired-confirmed product (acceptance 1+2), Testcontainers (RED).
- [ ] T014 [P] [US1] Cross-tenant sweep + RLS-bypass on the backlog read (acceptance 3); pagination/sort/group gap-detection (acceptance 4) (RED).

### Implementation (GREEN)

- [ ] T015 [US1] Implement the backlog read-projection query (003 ⟕ 013 confirmed-only-and-active, `app.current_tenant` scoped) in the service — NO 021 table write (READ-NOT-MIRROR-013, FR-002).
- [ ] T016 [US1] Implement the `toBody()` backlog projection (class, product ref, 013 suggestion provenance, observed-at) — explicit wire shape, no raw entity (§IV).
- [ ] T017 [US1] Wire `listProductReconciliationBacklog` controller route (pagination/sort/group-by-class, gap-detectable) behind `DashboardAuthGuard`.
- [ ] T018 [US1] Make T012–T014 GREEN; verify the confirmed-only invariant + cross-tenant non-disclosure.

**Checkpoint**: US1 fully functional, connector-free, independently shippable (MVP).

---

## Phase 5: User Story 2 - Repair via the 013 lifecycle (Priority: P2)

**Goal**: an idempotent repair that drives 013's existing suggest/confirm/re-point flow under 013's `version` guard, with an in-transaction audit + operational trail.

**Independent Test**: confirm a `suggestion_unconfirmed` product → it leaves the backlog, repair_attempt recorded; second repair = no_op_echo; stale-version = conflict.

### Tests (RED first) ⚠️

- [ ] T019 [P] [US2] Contract conformance test for `repairProductMapping` (idempotent; `409` on stale version) (RED).
- [ ] T020 [P] [US2] Integration test: confirm repair transitions the 013 row `suggested→confirmed`, product leaves backlog, `repair_attempt.outcome=mapped` (acceptance 1) (RED).
- [ ] T021 [P] [US2] Idempotency test: repair of an already-confirmed-active mapping = `no_op_echo`, no 2nd active mapping (013 1:1), no version clobber (acceptance 2, FR-011) (RED).
- [ ] T022 [P] [US2] Conflict test: stale-`version` confirm → `409`, `repair_attempt.outcome=conflict`, product stays in backlog (acceptance 3, FR-012/13) (RED).
- [ ] T023 [P] [US2] Atomicity test: a repair that fails to write `audit_events` rolls back the `repair_attempt` + the 013 transition (FR-015) — use a DB-trigger-induced failure (named-export jest spies aren't redefinable; the documented 018 gotcha) (RED).
- [ ] T024 [P] [US2] Malicious-override test: `tenant_id`/`actor_user_id` in the repair body are ignored (resolved from principal); unknown keys rejected (§XII) (RED).

### Implementation (GREEN)

- [ ] T025 [US2] Implement the repair service driving 013's EXISTING lifecycle (confirm / suggest_confirm / re_point) under 013's `version` guard — 021 issues NO direct write to `erpnext_item_map` (FR-010).
- [ ] T026 [US2] Implement the in-transaction trail: direct `INSERT INTO audit_events` on the same tx client + the `repair_attempt` insert (+ a `result_state` transition when repairing a persisted US3 result) — atomic; NOT `@Auditable`, NOT `insertAuditEvent` (FR-015 / research R6).
- [ ] T027 [US2] Wire `repairProductMapping` controller route (expected `version` in DTO; idempotent; `409` envelope) behind `DashboardAuthGuard`.
- [ ] T028 [US2] Make T019–T024 GREEN; verify 013/003/008 never mutated by the repair (only 013's lifecycle advances).

**Checkpoint**: US1 + US2 work independently; the unmapped backlog can be cleared in-system.

---

## Phase 6: User Story 3 - Two-sided reconciliation run (Priority: P3, connector-gated/stub-tolerant)

**Goal**: a persisted, classified mismatch report comparing the 013 mapping set against the connector ERPNext-item view; stub-tolerant (absent view → reported, run completes).

**Independent Test**: stub ERPNext-item view → run produces a classified report; absent view → run still completes (DP2-side classes only, ERPNext side unavailable); 013 unchanged.

### Tests (RED first) ⚠️

- [ ] T029 [P] [US3] Contract conformance for `triggerProductReconciliationRun` / `listProductReconciliationRuns` / `getProductReconciliationRunResults` (RED).
- [ ] T030 [P] [US3] Integration test: run against a stub item view (one extra item, one drifted) → `match`/`unmapped_erpnext_item`/`attribute_drift` persisted, tenant-scoped, 013 unchanged (acceptance 1+4) (RED).
- [ ] T031 [P] [US3] `sellable_state_divergence` test (DP2 sellable, ERPNext disabled) → reported, NOT silently flipped (acceptance 2, 013 OQ-5) (RED).
- [ ] T032 [P] [US3] Stub-tolerance test: absent/empty connector view → run `completed`, `erpnext_view_status='unavailable'`, DP2-side classes only, NO fabricated `unmapped_erpnext_item` (acceptance 3, FR-007) (RED).

### Implementation (GREEN)

- [ ] T033 [US3] Define the connector ERPNext-item-view **seam** interface (Protocol/port) + a recorded/stub adapter; DP2 makes no outbound ERPNext HTTP (FR-016). The live adapter is gated on `021-ITEM-VIEW-CONTRACT` (future).
- [ ] T034 [US3] Implement the run processor (BullMQ worker): establish tenant context, read the 013 confirmed mapping set + the seam view, classify per 021's vocabulary, persist run + results in-transaction (with the in-tx audit), idempotent re-run (§V/§XI).
- [ ] T035 [US3] Wire `triggerProductReconciliationRun` (Idempotency-Key) + the run/results list routes behind `DashboardAuthGuard`; emit the run trigger via the worker seam.
- [ ] T036 [US3] Make T029–T032 GREEN; verify run completes on absent view + 013/003/008 never mutated.

**Checkpoint**: all three stories independently functional; live ERPNext read still gated.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T037 [P] [POLISH] Register the unmapped-backlog-depth / reconciliation-outcome signal in the shared `apps/api/src/observability/metrics/api.metrics.ts` (§VII family; no PII/money/raw-payload labels); update the cardinality/signal-name drift lists (research R9).
- [ ] T038 [P] [POLISH] Run worker-signals/observability suite too (shared `ALLOWED_METRIC_LABELS` — the 018 gotcha: a new metric must pass worker-obs as well).
- [ ] T039 [POLISH] §XIV data-class guard test: owned tables carry no PII/money/raw-payload columns; no DELETE policy (retention = state).
- [ ] T040 [P] [POLISH] Report-only perf note (no perf env — the 005/008/009/010/017 precedent); backlog-projection paging ceiling.
- [ ] T041 [POLISH] Coverage ≥80% (§VI); CLOSEOUT — reconcile `execution-map.yaml` to terminal status; update `wave-status.md` with deferrals (`021-ITEM-VIEW-CONTRACT`, `021-SCHEDULED-RUNS`).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no deps.
- **Foundational (P2)**: needs Setup; `[GATED]` SCHEMA (T004/T005) + CONTRACT (T007) BLOCK all stories; drift allowlists (T006) ship with the migration.
- **Isolation-harness (P3)**: needs the schema (T005).
- **User stories (P4–P6)**: need Foundational + harness. US1 is connector-free and ships first; US2 builds on the surfaced backlog; US3 is connector-gated/stub-tolerant.
- **Polish (P7)**: after the desired stories.

### Story dependencies

- **US1 (P1)**: only needs Foundational + harness; no other-story dependency; the MVP.
- **US2 (P2)**: needs US1's surfaced backlog as the repair entry point but is independently testable (repair a seeded product directly).
- **US3 (P3)**: needs Foundational; independently testable against a stub view; can repair a persisted result via the US2 path.

### Within each story

- Tests written + FAILING before implementation (RED→GREEN).
- Read-projection/seam before service before controller before route wiring.
- Story complete + independently validated before the next priority.

### Parallel opportunities

- All `[P]` test tasks within a story run in parallel (different files).
- US1, US2, US3 can be staffed in parallel once Foundational + harness are done (US1 first for the MVP).

---

## Notes

- `[GATED]` tasks (T004/T005/T006/T007) touch forbidden surfaces — STOP for explicit approval before authoring; this planning chain authors none of them.
- 021 owns NO write to `erpnext_item_map`/`tenant_products`/`sales`/`sale_lines` — a repair drives 013's existing lifecycle (FR-010/14).
- The live ERPNext-item read is deferred to `021-ITEM-VIEW-CONTRACT`; v1 is stub-tolerant (FR-007/16).
- The audit-of-record is a NEW in-transaction `INSERT INTO audit_events` (the 017 path), never `@Auditable`/`insertAuditEvent` (FR-015).
- Verify `db-integration` manually per PR (`main` has no branch protection — CI advisory).
