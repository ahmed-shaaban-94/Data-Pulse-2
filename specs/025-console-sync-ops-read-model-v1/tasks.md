---
description: "Task list for Console Sync-Ops Read-Model v1"
---

# Tasks: Console Sync-Ops Read-Model v1

> **STATUS: ALL 30 TASKS COMPLETE — spec CLOSED.** Phase 1–5 (setup, `[GATED]`
> contract, DTOs, isolation harness, US1/US2/US3 read verticals) shipped via
> **PR #527 (`a3ccb4a`)**. Phase 6 polish/closeout (T027–T030) reconciled
> 2026-06-08 — see `wave-status.md` for the full closeout record. Suite: **42/42
> GREEN** on the shared impl branch (WSL Testcontainers); functional coverage
> 94–100% (service 100% lines, DTO 100%, controller 93.75%). **T027/FR-015 = reuse
> the shared HTTP signals (no new metric)** — rationale in T027 below.

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

- [x] T001 Create the api sub-module skeleton `apps/api/src/catalog/erpnext-sync-ops/`
  (`erpnext-sync-ops.module.ts`) and register it in the catalog module wiring. No routes
  yet.
- [x] T002 [P] Add the test directory `apps/api/test/catalog/erpnext-sync-ops/` and a
  shared Testcontainers bootstrap reused from the 017 reconciliation isolation harness.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: blocks all user stories.

- [x] T003 [GATED] Author the console read-model OpenAPI 3.1 contract
  `packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml` per
  `contracts/console-sync-ops.contract.md` — 3 `operationId`s
  (`consoleGetSyncOpsSummary`, `consoleListPostingBacklog`,
  `consoleListReconciliationRuns`), `cookieAuth`, canonical error envelope, explicit
  wire-shape schemas. **Do NOT author without approval.** (FR-016)
- [x] T004 [P] Implement the read-only wire-shape DTOs + Zod schemas in
  `apps/api/src/catalog/erpnext-sync-ops/dto/` (`SyncOpsSummary`, `DomainSummary`,
  `PostingBacklogItem`, `ReconciliationRunView`, `PageEnvelope`, list-query DTO with
  `.strict()`). (FR-010, FR-012, FR-014)
- [x] T005 [P] Build the isolation harness
  `apps/api/test/catalog/erpnext-sync-ops/erpnext-sync-ops.isolation.harness.ts`: seed
  two tenants with mixed `posted`/`pending`/`permanently_rejected` posting rows (015) and
  reconciliation runs + results (017), across stores. (supports US1/US2/US3 tests)
- [x] T006 Wire `DashboardAuthGuard` + `RolesGuard` (cookieAuth, human-only) onto the
  sub-module controller scaffold; reject `connectorBearer` / `dashboard_api` bearer.
  (FR-007)
- [x] T007 Confirm read path runs under `runWithTenantContext` (RLS fail-closed) — add a
  raw-SQL RLS bypass probe asserting wrong-tenant GUC returns zero rows. (FR-008, §VI)

**Checkpoint**: contract + DTOs + auth + tenant-context foundation ready.

---

## Phase 3: User Story 1 — Consolidated sync-ops summary (P1) 🎯 MVP

**Goal**: one tenant-scoped summary aggregating 015 posting health + 017 reconciliation
health, with 020/021 as `not_available`.

**Independent Test**: seed mixed posting rows + a completed run; assert summary counts,
latest-run outcome, and `not_available` deferred domains, tenant-scoped.

### Tests (RED first)

- [x] T008 [P] [US1] Contract conformance test for `consoleGetSyncOpsSummary` in
  `apps/api/test/catalog/erpnext-sync-ops/erpnext-sync-ops.contract.spec.ts`. (FR-016, SC-008)
- [x] T009 [P] [US1] Integration test `sync-ops-summary.int-spec.ts`: posting-health +
  reconciliation-health counts, deferred-domain `not_available`, empty-tenant zeroed
  case, store filter. (SC-001, SC-003, SC-004)
- [x] T010 [P] [US1] Cross-tenant + cross-store sweep for the summary route (non-disclosing
  404). (SC-002)
- [x] T011 [P] [US1] Auth sweep: unauthenticated + machine-credential rejected; only human
  cookie session with role passes. (SC-006)

### Implementation (GREEN)

- [x] T012 [US1] Implement `erpnext-sync-ops.read-model.service.ts` posting-health read
  (group-by-status over 015 `erpnext_posting_status`, compute-on-read, no mirror).
  (FR-002, FR-012)
- [x] T013 [US1] Add reconciliation-health read (latest 017 run + open-mismatch count from
  `erpnext_reconciliation_result`). (FR-003)
- [x] T014 [US1] Add the deferred-domain `not_available` `DomainSummary` for
  connector_health (020) + product_master (021). (FR-004)
- [x] T015 [US1] Implement `consoleGetSyncOpsSummary` controller route + `toBody()`
  projection (no raw DB entity). NOTE: the 015/017 source tables carry NO money /
  valuation column (both are BUSINESS-class — refs/counts/qty/classes only), so
  there is NO monetary field on this surface (the contract banned-field scan
  enforces it). (FR-001, FR-010, FR-013)

**Checkpoint**: US1 fully functional + independently testable (MVP).

---

## Phase 4: User Story 2 — Posting dead-letter backlog drill (P2)

**Goal**: paginated/sortable/groupable read-through list of 015 `permanently_rejected`
postings.

**Independent Test**: seed mixed-class dead-letters + healthy rows; assert only
dead-letters returned, classified, with provenance/reason, paged/sorted/grouped,
tenant-scoped.

### Tests (RED first)

- [x] T016 [P] [US2] Contract conformance for `consoleListPostingBacklog`. (FR-016, SC-008)
- [x] T017 [P] [US2] Integration test `posting-backlog.int-spec.ts`: only
  `permanently_rejected` rows, class/provenance/reason/timestamp present, healthy rows
  absent, no repair affordance. (FR-005, FR-011)
- [x] T018 [P] [US2] Pagination test: cursor stability, deterministic order, bounded page,
  gap-detectable across pages. (FR-014, SC-005)
- [x] T019 [P] [US2] Cross-tenant sweep for the backlog route. (SC-002)

### Implementation (GREEN)

- [x] T020 [US2] Read-model service: backlog query (filter `status='permanently_rejected'`,
  cursor pagination on `sequence`, bounded page size). NOTE (SC-007): the existing
  015 index is `WHERE status='pending'`; the `permanently_rejected` scan is NOT
  backed by an index. Do NOT add one — that is a gated `packages/db` change SC-007
  forbids; logged as a report-only perf note (T029). (FR-005, FR-014)
- [x] T021 [US2] Implement `consoleListPostingBacklog` controller route +
  `PostingBacklogItem` projection (provenance, rejection class, dead-letter time;
  read-only, no write/repair field). NOTE: no money field — the 015 table carries
  none. (FR-010, FR-011, FR-013)

**Checkpoint**: US1 + US2 both independently functional.

---

## Phase 5: User Story 3 — Reconciliation run-history (P3)

**Goal**: paginated newest-first read-through list of 017 runs with status, timestamps,
trigger source, per-class mismatch summary.

**Independent Test**: seed runs in mixed states; assert newest-first, paginated, correct
fields, tenant-scoped; deferred domains `not_available`.

### Tests (RED first)

- [x] T022 [P] [US3] Contract conformance for `consoleListReconciliationRuns`. (FR-016, SC-008)
- [x] T023 [P] [US3] Integration test `reconciliation-run-history.int-spec.ts`:
  newest-first, status/timestamps/trigger/mismatch-summary, deferred-domain handling.
  (FR-006)
- [x] T024 [P] [US3] Cross-tenant sweep for the run-history route. (SC-002)

### Implementation (GREEN)

- [x] T025 [US3] Read-model service: run-history query (newest-first, cursor pagination,
  bounded, per-class mismatch summary join). (FR-006, FR-014)
- [x] T026 [US3] Implement `consoleListReconciliationRuns` controller route +
  `ReconciliationRunView` projection. (FR-010)

**Checkpoint**: all three read operations independently functional.

---

## Phase 6: Polish & Cross-Cutting

- [x] T027 [P] Reuse the shared sync-ops signals in
  `apps/api/src/observability/metrics/api.metrics.ts` for read-model usage/source-availability;
  structured logs carry `request_id`/`tenant_id`. **No per-feature metrics file.** (FR-015)
  **DONE BY REUSE — `api.metrics.ts` NOT touched.** FR-015's hard constraint is "no
  per-feature metrics *file*". Read-model **usage** is already surfaced by the shared
  global signals `http_request_count{route}` + `http_request_duration_seconds{route}`
  (and `http_error_4xx_total`/`validation_failure_total`/`cross_tenant_rejection_total`),
  all of which fire on the three `/api/v1/catalog/erpnext-sync-ops/*` routes via the
  global interceptors — a new `*_request_total` would be a pure duplicate. **Source-
  availability** is *static* in v1 (020/021 always `not_available`; 015/017 always
  available, same DB) so a counter would be vacuous — availability is surfaced *by the
  feature itself* via `DomainSummary.status`. The 015/017/018 specs each *named* their
  counter in §VII; 025 names **none** (a read path emits no domain event). Structured
  `request_id`/`tenant_id` logs cover the routes via the existing logging interceptor.
  Decision recorded so this reads as deliberate, not skipped.
- [x] T028 [P] Verify no `packages/db` schema/migration change and no `package.json` /
  `pnpm-lock` change introduced (no-mirror posture). (SC-007)
  **VERIFIED** — `git diff origin/main...HEAD` shows 025 adds NO migration, NO schema,
  NO `package.json`/`pnpm-lock` change (compute-on-read over the merged 015/017 tables).
- [x] T029 [P] Coverage ≥80% for the new sub-module; report-only perf note (no perf env).
  **VERIFIED** — 42/42 GREEN (WSL Testcontainers); functional coverage service 100% lines
  / DTO 100% / controller 93.75% (the only sub-80 file is `erpnext-sync-ops.module.ts`,
  pure DI-decorator wiring not exercised by `Test.createTestingModule`). **Perf note
  (report-only, no perf env):** the US2 backlog scan filters
  `status='permanently_rejected'` but the only 015 index is `WHERE status='pending'`
  (SC-007) — the dead-letter scan is **deliberately un-indexed**; adding an index is a
  gated `packages/db` change SC-007 forbids. Acceptable at v1 backlog volumes; if a
  large tenant's dead-letter backlog grows, raise a future `[GATED]` index slice.
- [x] T030 Quickstart/closeout: confirm all three `operationId`s conform, isolation +
  auth sweeps green, deferred-domain `not_available` asserted in summary.
  **CONFIRMED** — contract conformance (23 tests: 3 operationIds, READ-ONLY GETs,
  cookieAuth-only/no-machine, strict schemas, NO-money scan), tenant isolation +
  non-disclosing-404 cross-store sweeps, and `not_available` for connector_health (020)
  + product_master (021) all GREEN. F1 (issue #522 — pin real 015/017 column/enum names)
  is **resolved**: the integration tests pass against the real migrated schema, so
  `rejection_category`, `result_state`, `run.summary`, `trigger`, `permanently_rejected`
  are validated, not indicative. F3 (money) vacuously satisfied — no monetary field
  (the 015/017 tables carry none; the contract banned-field scan enforces it).

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
