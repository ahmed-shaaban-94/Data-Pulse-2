---
description: "Task list for Console Sync-Ops Read-Model v1"
---

# Tasks: Console Sync-Ops Read-Model v1

**Input**: Design documents from `/specs/025-console-sync-ops-read-model-v1/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/console-sync-ops.contract.md

**Tests**: REQUIRED. Per §VI test-first — RED before GREEN. Testcontainers for tenant
isolation; cross-tenant + cross-store sweeps; auth + machine-credential-rejection; OpenAPI
conformance.

**Organization**: grouped by user story (US1/US2/US3) for independent implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[GATED]**: touches an approval-gated surface (`packages/contracts/openapi/**`) — do
  NOT author without explicit approval recorded in the slice.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create the api sub-module skeleton `apps/api/src/catalog/erpnext-sync-ops/`
  (`erpnext-sync-ops.module.ts`) and register it in the catalog module wiring. No routes
  yet.
- [ ] T002 [P] Add the test directory `apps/api/test/catalog/erpnext-sync-ops/` and a
  shared Testcontainers bootstrap reused from the 017 reconciliation isolation harness.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: blocks all user stories.

- [ ] T003 [GATED] Author the console read-model OpenAPI 3.1 contract
  `packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml` per
  `contracts/console-sync-ops.contract.md` — 3 `operationId`s
  (`consoleGetSyncOpsSummary`, `consoleListPostingBacklog`,
  `consoleListReconciliationRuns`), `cookieAuth`, canonical error envelope, explicit
  wire-shape schemas. **Do NOT author without approval.** (FR-016)
- [ ] T004 [P] Implement the read-only wire-shape DTOs + Zod schemas in
  `apps/api/src/catalog/erpnext-sync-ops/dto/` (`SyncOpsSummary`, `DomainSummary`,
  `PostingBacklogItem`, `ReconciliationRunView`, `PageEnvelope`, list-query DTO with
  `.strict()`). (FR-010, FR-012, FR-014)
- [ ] T005 [P] Build the isolation harness
  `apps/api/test/catalog/erpnext-sync-ops/erpnext-sync-ops.isolation.harness.ts`: seed
  two tenants with mixed `posted`/`pending`/`permanently_rejected` posting rows (015) and
  reconciliation runs + results (017), across stores. (supports US1/US2/US3 tests)
- [ ] T006 Wire `DashboardAuthGuard` + `RolesGuard` (cookieAuth, human-only) onto the
  sub-module controller scaffold; reject `connectorBearer` / `dashboard_api` bearer.
  (FR-007)
- [ ] T007 Confirm read path runs under `runWithTenantContext` (RLS fail-closed) — add a
  raw-SQL RLS bypass probe asserting wrong-tenant GUC returns zero rows. (FR-008, §VI)

**Checkpoint**: contract + DTOs + auth + tenant-context foundation ready.

---

## Phase 3: User Story 1 — Consolidated sync-ops summary (P1) 🎯 MVP

**Goal**: one tenant-scoped summary aggregating 015 posting health + 017 reconciliation
health, with 020/021 as `not_available`.

**Independent Test**: seed mixed posting rows + a completed run; assert summary counts,
latest-run outcome, and `not_available` deferred domains, tenant-scoped.

### Tests (RED first)

- [ ] T008 [P] [US1] Contract conformance test for `consoleGetSyncOpsSummary` in
  `apps/api/test/catalog/erpnext-sync-ops/erpnext-sync-ops.contract-spec.ts`. (FR-016, SC-008)
- [ ] T009 [P] [US1] Integration test `sync-ops-summary.int-spec.ts`: posting-health +
  reconciliation-health counts, deferred-domain `not_available`, empty-tenant zeroed
  case, store filter. (SC-001, SC-003, SC-004)
- [ ] T010 [P] [US1] Cross-tenant + cross-store sweep for the summary route (non-disclosing
  404). (SC-002)
- [ ] T011 [P] [US1] Auth sweep: unauthenticated + machine-credential rejected; only human
  cookie session with role passes. (SC-006)

### Implementation (GREEN)

- [ ] T012 [US1] Implement `erpnext-sync-ops.read-model.service.ts` posting-health read
  (group-by-status over 015 `erpnext_posting_status`, compute-on-read, no mirror).
  (FR-002, FR-012)
- [ ] T013 [US1] Add reconciliation-health read (latest 017 run + open-mismatch count from
  `erpnext_reconciliation_result`). (FR-003)
- [ ] T014 [US1] Add the deferred-domain `not_available` `DomainSummary` for
  connector_health (020) + product_master (021). (FR-004)
- [ ] T015 [US1] Implement `consoleGetSyncOpsSummary` controller route + `toBody()`
  projection (no raw DB entity); money pass-through exact-decimal if present. (FR-001,
  FR-010, FR-013)

**Checkpoint**: US1 fully functional + independently testable (MVP).

---

## Phase 4: User Story 2 — Posting dead-letter backlog drill (P2)

**Goal**: paginated/sortable/groupable read-through list of 015 `permanently_rejected`
postings.

**Independent Test**: seed mixed-class dead-letters + healthy rows; assert only
dead-letters returned, classified, with provenance/reason, paged/sorted/grouped,
tenant-scoped.

### Tests (RED first)

- [ ] T016 [P] [US2] Contract conformance for `consoleListPostingBacklog`. (FR-016, SC-008)
- [ ] T017 [P] [US2] Integration test `posting-backlog.int-spec.ts`: only
  `permanently_rejected` rows, class/provenance/reason/timestamp present, healthy rows
  absent, no repair affordance. (FR-005, FR-011)
- [ ] T018 [P] [US2] Pagination test: cursor stability, deterministic order, bounded page,
  gap-detectable across pages. (FR-014, SC-005)
- [ ] T019 [P] [US2] Cross-tenant sweep for the backlog route. (SC-002)

### Implementation (GREEN)

- [ ] T020 [US2] Read-model service: backlog query (filter `status='permanently_rejected'`,
  sort/group-by class, cursor pagination, bounded page size). (FR-005, FR-014)
- [ ] T021 [US2] Implement `consoleListPostingBacklog` controller route +
  `PostingBacklogItem` projection (provenance, structured reason redacted, money
  pass-through; read-only, no write field). (FR-010, FR-011, FR-013)

**Checkpoint**: US1 + US2 both independently functional.

---

## Phase 5: User Story 3 — Reconciliation run-history (P3)

**Goal**: paginated newest-first read-through list of 017 runs with status, timestamps,
trigger source, per-class mismatch summary.

**Independent Test**: seed runs in mixed states; assert newest-first, paginated, correct
fields, tenant-scoped; deferred domains `not_available`.

### Tests (RED first)

- [ ] T022 [P] [US3] Contract conformance for `consoleListReconciliationRuns`. (FR-016, SC-008)
- [ ] T023 [P] [US3] Integration test `reconciliation-run-history.int-spec.ts`:
  newest-first, status/timestamps/trigger/mismatch-summary, deferred-domain handling.
  (FR-006)
- [ ] T024 [P] [US3] Cross-tenant sweep for the run-history route. (SC-002)

### Implementation (GREEN)

- [ ] T025 [US3] Read-model service: run-history query (newest-first, cursor pagination,
  bounded, per-class mismatch summary join). (FR-006, FR-014)
- [ ] T026 [US3] Implement `consoleListReconciliationRuns` controller route +
  `ReconciliationRunView` projection. (FR-010)

**Checkpoint**: all three read operations independently functional.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T027 [P] Reuse the shared sync-ops signals in
  `apps/api/src/observability/metrics/api.metrics.ts` for read-model usage/source-availability;
  structured logs carry `request_id`/`tenant_id`. **No per-feature metrics file.** (FR-015)
- [ ] T028 [P] Verify no `packages/db` schema/migration change and no `package.json` /
  `pnpm-lock` change introduced (no-mirror posture). (SC-007)
- [ ] T029 [P] Coverage ≥80% for the new sub-module; report-only perf note (no perf env).
- [ ] T030 Quickstart/closeout: confirm all three `operationId`s conform, isolation +
  auth sweeps green, deferred-domain `not_available` asserted in summary.

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2, incl. [GATED] T003)** blocks all stories.
- US1 (P3) is the MVP; US2 (P4) and US3 (P5) build on the same foundation and can proceed
  in parallel after Phase 2, but each is independently testable.
- **Polish (P6)** after the desired stories.

### Within each story
- Tests (RED) before implementation (GREEN). Service read before controller route.
- Cross-tenant/cross-store sweep + auth sweep required per protected route (§VI).

### Parallel opportunities
- T004/T005 (DTOs / harness) parallel in Phase 2.
- All `[P]` tests within a story parallel.
- US2 and US3 implementation parallel after Phase 2.

---

## Notes

- `[GATED]` = `packages/contracts/openapi/**` — author only under recorded approval.
- This feature adds **no migration, no schema, no worker, no write** — read-only
  projection only.
- Every FR maps to ≥1 task (see analysis.md coverage matrix); deferred 020/021 domains are
  covered by the `not_available` tasks (T014), not by separate buildable source tasks.
