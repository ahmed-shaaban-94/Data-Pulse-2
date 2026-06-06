<!--
  /speckit-tasks output for 017 ERPNext Reconciliation & Repair.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
  [SIGN-OFF] tasks are owner decisions recorded before dependents run.
  Authoring this file (and execution-map.yaml) does NOT authorize the first dispatch — the first slice
  touching packages/db / packages/contracts / apps/api is a new threshold the owner crosses explicitly.
-->

# Tasks: ERPNext Reconciliation & Repair

**Feature**: 017-erpnext-reconciliation-and-repair | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Research**: [research.md](./research.md) | **Contract intent**: [contracts/README.md](./contracts/README.md)

---

## 0. TL;DR — the arc's operational reconciliation surface (run → report → repair)

017 makes the 015 posting dead-letter backlog **visible** (US1 🎯 MVP), exposes an **idempotent repair / re-post** that re-uses the 015 O-3 state machine — exactly one ERPNext document, never a second or a silent rewrite (US2), and runs **stock reconciliation** comparing DP2 on-hand (009) against the connector's ERPNext-Bin view per the 014 mapping, persisting mismatch reports in 014's vocabulary (US3). Human Tenant Admin (`cookieAuth`) only; DP2 makes **no outbound ERPNext HTTP**; 008 sale fact + 009 ledger are **never** mutated. 017 **reads** the 015/014/009 facts and **owns** one new `[GATED]` reconciliation-state table family + one new `[GATED]` operator OpenAPI.

**Decisions ratified at spec/plan time (research.md R1–R7):**
- **R1** repair re-uses the 015 `erpnext_posting_status` state machine (re-head `permanently_rejected`→`pending`); no new idempotency primitive, bounded by `POSTING_RETRY_BUDGET`.
- **R2** own runs/results/repair-attempts; READ (never mirror) the 015 dead-letters.
- **R3** stock ERPNext-Bin read is a connector seam (012 boundary); v1 stub-tolerant so the DP2 side ships independently.
- **R4** consume 014's stock vocab + 015's posting categories; 017 owns only the orthogonal `result_state` enum.
- **R5** on-demand runs in v1; scheduled is later wiring over the same processor.
- **R6** human-operator-only (`cookieAuth` / DashboardAuthGuard); no machine path (FR-018, decided).
- **R7** signals extend the SHARED `erpnext_posting_reconciliation_total` family; no per-feature metrics file.

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [Story?] Description (file path).`
- **Labels**: `[P]` parallelizable; `[GATED]` requires explicit approval (forbidden path); `[TC]` Testcontainers/real-Postgres (run via WSL per `reference_007_test_env`); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test and made GREEN (Constitution §VI). Coverage ≥80%.
- **Auth**: the reconciliation/repair surface is the **human** dashboard session → **`cookieAuth` / DashboardAuthGuard** (the 007/013/014 convention). NOT `connectorBearer`, NOT `clerkJwt` (FR-018, R6).
- **No outbound HTTP from DP2**; the connector (separate repo, ADR 0008) owns any ERPNext-Bin fetch behind the fixed 012 boundary.
- **Money** (if any value appears): exact-decimal string, never float (§III). **008/009 never mutated** (§IX, FR-013).
- **The 012 `posting-feed.yaml` is READ-ONLY input** — 017 adds NO machine contract (FR-017/018).

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T001 | `[SIGN-OFF]` | **`017-SIGNOFF-STATE`** — confirm the [data-model §2](./data-model.md#2-the-new-gated-state--erpnext_reconciliation_) decision: a **new `[GATED]` `erpnext_reconciliation_*` table family** (runs + results + repair-attempts), while the 015 dead-letters are **READ, never mirrored** (R2). Must be recorded before T012 dispatches. Mirrors `015-SIGNOFF-STATE`. |
| T002 | `[SIGN-OFF]` | Confirm **repair re-uses the 015 O-3 state machine** (re-head `permanently_rejected`→`pending`; never a 2nd `document_ref`, never a rewrite), bounded by `POSTING_RETRY_BUDGET` (R1) — NOT a new posting/idempotency primitive and NOT DP2 calling ERPNext. |
| T003 | `[SIGN-OFF]` | Confirm **v1 scope carve**: on-demand runs only (scheduled deferred, R5); the stock ERPNext-Bin read is a **connector seam, stub-tolerant** (R3) so the DP2 side ships without the connector repo; human-operator-only auth (R6). |
| T010 | `[GATED]` | New **operator OpenAPI** `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml` (`cookieAuth`; the 6 operationIds in [contracts/README.md](./contracts/README.md)) + its structural conformance spec. Explicit approval, its own slice. |
| T012 | `[GATED]` | New **`erpnext_reconciliation_*`** Drizzle schema + migration (`packages/db/**`, next number after `0019` — **`0020`** indicative) incl. fail-closed RLS + the append-only repair audit + §XIV data-class. Paired `*.down.sql`, lock review. |

> **No 012 contract task, no new event-type.** 017 reads the 015 `erpnext_posting_status` state + transitions it via the existing 015 mechanism; the connector re-posts via the **existing** 012 feed/ack. Any connector→DP2 ERPNext-view contract (for the stock-run ERPNext-Bin read) is a separate future `[GATED]` 012-style slice — out of 017 v1 (R3).

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) 🎯 MVP | **Review the posting dead-letter backlog**: paginated/sortable/groupable list of 015 `permanently_rejected` rows for the tenant — class + originating ref + provenance + reason + dead-letter time; tenant isolation + non-disclosure | T030–T034 |
| (cross-cutting P1) | **Isolation & non-disclosure harness**: RLS on the new `0020` tables, RLS-bypass probe, cross-tenant read → 0 rows / non-disclosing 404 | T020 |
| US2 (P2) | **Repair a failed posting** (`repairPosting`): re-evaluate 015-RESOLVE → re-head to `pending`; idempotent (O-3 echo / no 2nd doc); still-broken → back to backlog; bounded by retry budget; 008 never mutated | T040–T044 |
| US3 (P3) | **Stock reconciliation run + report + repair**: on-demand run (worker) comparing 009 on-hand vs the connector ERPNext-Bin seam per the 014 mapping; persist results in 014's vocab; re-map/re-sync repair; 009/008 never mutated | T050–T056 |
| (polish) | observability (§VII shared signals), report-only perf, coverage, closeout | T090–T092 |

---

## Phase 1: Setup

- [ ] T001 [SIGN-OFF] Record `017-SIGNOFF-STATE` (the new `[GATED]` `erpnext_reconciliation_*` table family vs. mirroring the 015 dead-letters; data-model §2 / R2) in `specs/017-erpnext-reconciliation-and-repair/wave-status.md`. Acceptance: decision recorded; precondition for T012.
- [ ] T002 [SIGN-OFF] Record the **repair = 015 O-3 state-machine re-use** decision (R1 — re-head `permanently_rejected`→`pending`, no new primitive, bounded by `POSTING_RETRY_BUDGET`, never a 2nd `document_ref`) in `wave-status.md`. Acceptance: recorded.
- [ ] T003 [SIGN-OFF] Record the **v1 scope carve** (on-demand only R5; connector-seam stub-tolerant stock read R3; human-only auth R6) in `wave-status.md`. Acceptance: recorded.
- [ ] T004 Create the empty `apps/api/src/catalog/erpnext-reconciliation/erpnext-reconciliation.module.ts` and register it in `apps/api/src/app.module.ts` (mirror the `erpnext-posting`/`erpnext-item-map` wiring; no routes yet). Acceptance: `pnpm --filter @data-pulse-2/api build` GREEN; existing catalog modules still compile.

## Phase 2: Foundational (GATED; block all capability slices)

### 2.1 `[GATED]` operator contract

- [ ] T010 [GATED] Author `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml` (OpenAPI 3.1, `cookieAuth`; the 6 operationIds + invariants in contracts/README.md — explicit wire projections, strict bodies, canonical error envelope, `Idempotency-Key` on repair/run-trigger, non-disclosing 404, 014+015 vocab) and a structural conformance spec `apps/api/test/erpnext-reconciliation/contract/reconciliation.contract.spec.ts` (explicit-`dir` loader, the non-recursive `loadOpenApiContracts` precedent). Acceptance: conformance spec GREEN; contract present. Predecessors: T003.

### 2.2 `[GATED]` `erpnext_reconciliation_*` schema + migration

- [ ] T012a [GATED] [TC] RED — migration round-trip spec `packages/db/__tests__/migration/0020-erpnext-reconciliation.spec.ts` asserting the data-model §2 shape (runs + results + repair-attempts; RLS ENABLE+FORCE fail-closed empty-GUC CASE; append-only repair audit, no DELETE policy; no money/PII column; CHECK enums; composite `(run_id, tenant_id)` FK) + UP→DOWN→UP. Acceptance: RED (table absent). Predecessors: T001.
- [ ] T012 [GATED] [TC] GREEN — `packages/db/src/schema/catalog/erpnext-reconciliation.ts` (+ barrel re-export in `src/schema/index.ts`), `packages/db/drizzle/0020_erpnext_reconciliation.sql` + `0020_erpnext_reconciliation.down.sql`; APPEND `0020…` to `packages/db/__tests__/cli/migrate.spec.ts` EXPECTED_MIGRATIONS AND the module name(s) to `packages/db/__tests__/schema/catalog/barrel.spec.ts` EXPECTED_CATALOG_MODULES (the #447/#487-class drift break). Docker-free companion schema-shape spec `apps/api/test/catalog/erpnext-reconciliation/schema/erpnext-reconciliation-schema-shape.spec.ts`. Acceptance: T012a GREEN; migrate allowlist + barrel GREEN; UP/DOWN clean. Predecessors: T012a.

### 2.3 Isolation harness (blocking — serves the capability slices)

- [ ] T020 [TC] Seed helper `apps/api/test/catalog/erpnext-reconciliation/__support__/seed-reconciliation.ts` (mirrors `seed-posting-status.ts`; builds on the 015/014/009 fixtures via the admin pool; seeds posting dead-letters + a mapped store + an on-hand divergence) + RLS sweep `apps/api/test/catalog/erpnext-reconciliation/isolation/reconciliation-sweep.spec.ts` (wrong `app.current_tenant` → 0 rows; unset GUC → fail-closed + INSERT denied; cross-tenant read → 0 rows). MUST NOT touch the 003-owned `isolation-harness.ts`. Acceptance: GREEN (characterises the shipped `0020` RLS). Predecessors: T012.

## Phase 3: US1 (P1) 🎯 MVP — review the posting dead-letter backlog

**Goal**: an operator sees their tenant's posting dead-letters, classified, with provenance + reason. **Independent test**: seed mixed `erpnext_posting_status` rows; list as the tenant admin → exactly the `permanently_rejected` rows, healthy rows absent, tenant-isolated.

- [ ] T030 [P] [TC] [US1] RED — `listPostingBacklog` projects ONLY `permanently_rejected` 015 rows for the tenant into the wire shape (class, originating ref, provenance, structured reason, dead-letter time); `posted`/`pending`/`failed_transient` rows ABSENT. `apps/api/test/catalog/erpnext-reconciliation/backlog/posting-backlog.spec.ts`. Predecessors: T020. Acceptance: RED.
- [ ] T031 [US1] GREEN — `reconciliation-report.projection.ts` `toBacklogItem` + `ErpnextReconciliationService.listPostingBacklog` (read under `runWithTenantContext`; cursor-ordered/paginated; filter by store + class; backed by the 015 `idx_erpnext_posting_status_pending`-style scan over `status='permanently_rejected'`). Predecessors: T030. Acceptance: T030 GREEN.
- [ ] T032 [US1] GREEN — `erpnext-reconciliation.controller.ts` `GET /api/v1/catalog/erpnext-reconciliation/postings/backlog` behind `@UseGuards(DashboardAuthGuard)` (the real human-admin namespace — `@Controller()` empty + full per-method `api/v1/catalog/...` paths, the 014 `erpnext-warehouse-map` convention; NOT `/api/admin/...`); tenant from the session principal (never the query, §XII); strict query DTO `dto/list-backlog-query.dto.ts` (`.strict()` — pagination/sort/group/filter only). Predecessors: T031. Acceptance: route returns the projection.
- [ ] T033 [P] [TC] [US1] RED→GREEN — pagination/sort/group-by-class are stable + gap-detectable across pages (the 007/010 list convention). `…/backlog/backlog-pagination.spec.ts`. Predecessors: T031. Acceptance: GREEN.
- [ ] T034 [P] [TC] [US1] RED→GREEN — §XII HTTP-edge: unauthenticated → 401; cross-tenant rows absent; a body/query-supplied tenant rejected (strict). `apps/api/test/catalog/erpnext-reconciliation/http/backlog-http-edge.spec.ts` (real DashboardAuthGuard). Predecessors: T032. Acceptance: GREEN.

## Phase 4: US2 (P2) — repair a failed posting (idempotent re-post)

**Goal**: clear a dead-letter inside the system. **Independent test**: confirm a mapping out of band, repair an `unmapped_item` dead-letter → re-offered + one `document_ref`; a 2nd repair of the `posted` row is a no-op echo.

- [ ] T040 [P] [TC] [US2] RED — `repairPosting` re-evaluates 015-RESOLVE then, if resolved, flips the 015 row `permanently_rejected`→`pending` + re-heads `sequence`; writes a `repair_attempt` (`eligible_again`); a still-unresolved cause leaves the row `permanently_rejected` + `repair_attempt.outcome=still_failing` (FR-011); the 008 sale fact is byte-for-byte unchanged. `apps/api/test/catalog/erpnext-reconciliation/repair/posting-repair.spec.ts`. Predecessors: T031, T012. Acceptance: RED.
- [ ] T041 [US2] GREEN — `ErpnextReconciliationService.repairPosting` (the R1 state transition; re-uses the 015 resolve logic — extract/share a single copy, do NOT fork it; `SELECT … FOR UPDATE` on the 015 row to serialize concurrent repairs). Writes BOTH a platform `audit_events` row (FR-014, audit-in-transaction — the 013/014/015 pattern: actor + tenant + store + target ref + outcome, no PII/raw payload) AND the append-only `repair_attempt` record, atomic with the 015-row transition (all-or-nothing). Predecessors: T040. Acceptance: T040 GREEN; an `audit_events` row + a `repair_attempt` row are emitted in the same transaction.
- [ ] T042 [US2] GREEN — `POST /api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair` on the controller behind `DashboardAuthGuard` + `@Idempotent('required')` (reuse the existing interceptor; no new primitive); strict body DTO; cross-tenant `workItemRef` → non-disclosing 404. Predecessors: T041. Acceptance: route records + echoes the `RecordedRepair` outcome.
- [ ] T043 [P] [TC] [US2] RED→GREEN — O-3 across repair: a repair of an already-`posted` row is a `no_op_echo` returning the stored `document_ref` (never a 2nd document, never a rewrite); concurrent repairs serialize to exactly one effect. `…/repair/posting-repair-idempotency.spec.ts`. Predecessors: T041, T012. Acceptance: GREEN.
- [ ] T044 [P] [TC] [US2] RED→GREEN — bounded re-offer: a repaired posting that keeps failing honors `POSTING_RETRY_BUDGET` (no unbounded loop, FR-019); the repair audit is append-only. `…/repair/posting-repair-bounded.spec.ts`. Predecessors: T041. Acceptance: GREEN.

## Phase 5: US3 (P3) — stock reconciliation run + report + repair

**Goal**: run a stock compare, persist a classified mismatch report, repair actionable classes. **Independent test**: mapped store + seeded divergence + stub ERPNext-Bin view → a `completed` run with results in 014's vocab; 009/008 unchanged.

- [ ] T050 [P] [TC] [US3] RED — the run processor compares 009 compute-on-read on-hand vs a (injected/stub) connector ERPNext-Bin view per the 014 mapping and persists one `erpnext_reconciliation_result` per line, classified in **014's** vocabulary; an unmapped store → `unmapped_store` (never a guessed warehouse, FR-006); 009 ledger + 008 sale fact unchanged. `apps/worker/test/erpnext-reconciliation/reconciliation-run.spec.ts`. Predecessors: T012, T020. Acceptance: RED.
- [ ] T051 [US3] GREEN — `apps/worker/src/erpnext-reconciliation/reconciliation-run.processor.ts` (idempotent §V worker; `runWithTenantContext`; carries `tenantId`/`storeId`/`correlationId`; ERPNext-Bin view injected as a seam interface — stub-tolerant per R3; redacted failure logs). Writes the `erpnext_reconciliation_run` record + a platform `audit_events` row for the run (FR-014, in-transaction; actor NULL for scheduled, the operator for on-demand). Predecessors: T050. Acceptance: T050 GREEN; the run + its `audit_events` row are written in the same transaction.
- [ ] T052 [US3] GREEN — `triggerReconciliationRun` (`POST /api/v1/catalog/erpnext-reconciliation/runs`) + `getReconciliationRun` (`GET /…/runs/{runId}`) + `listReconciliationResults` (`GET /…/runs/{runId}/results`) on the controller (DashboardAuthGuard; `@Idempotent('required')` on the trigger; paginated results; non-disclosing 404 on a foreign `runId`). Run trigger enqueues the worker job + audits the trigger. Predecessors: T051, T032. Acceptance: routes return run + results projections.
- [ ] T053 [P] [TC] [US3] RED→GREEN — `repairStockMismatch` (`POST /api/v1/catalog/erpnext-reconciliation/runs/{runId}/results/{resultId}/repair`): an actionable class (`unmapped_store`→re-map, `quantity_divergence`→re-sync) writes — in ONE transaction (U1) — the append-only `repair_attempt`, the `erpnext_reconciliation_result.result_state` `open→repaired` transition, AND a platform `audit_events` row (FR-014); idempotent; never mutates the 009 ledger (a re-map drives the 014 admin flow, FR-013/016). `apps/api/test/catalog/erpnext-reconciliation/repair/stock-repair.spec.ts`. Predecessors: T052. Acceptance: GREEN; result_state + repair_attempt + audit_events all written atomically.
- [ ] T054 [P] [TC] [US3] RED→GREEN — a run while a posting for the same sale is still `pending` reports the in-flight state and does NOT double-classify it as a mismatch / race the posting loop (edge case). `…/run/run-inflight-posting.spec.ts`. Predecessors: T051. Acceptance: GREEN.
- [ ] T055 [P] [TC] [US3] RED→GREEN — the run is idempotent + retry-safe: a re-run / re-delivered job converges (no duplicate results for the same run scope); the run reads but never writes 008/009. `…/run/run-idempotency.spec.ts`. Predecessors: T051. Acceptance: GREEN.
- [ ] T056 [P] [TC] [US3] RED→GREEN — §XII on the run/results/stock-repair routes: unauthenticated → 401; cross-tenant `runId`/`resultId` → non-disclosing 404; strict bodies reject server-owned fields. `apps/api/test/catalog/erpnext-reconciliation/http/run-http-edge.spec.ts`. Predecessors: T052. Acceptance: GREEN.

## Phase 6: Polish & cross-cutting

- [ ] T090 [P] Observability (§VII / R7): extend the SHARED `erpnext_posting_reconciliation_total` family in `apps/api/src/observability/metrics/api.metrics.ts` + `apps/worker/src/observability/metrics/worker.metrics.ts` with a run-outcome + repair-outcome counter (unlabeled — no tenant/store/sale/class in labels) + APPEND to `ALLOWED_METRIC_LABELS` (`packages/shared`) + the cardinality drift list (`apps/api/test/observability/cardinality.spec.ts`) in lockstep; emission specs (mock the helper, the read-down/015 idiom). Raw payloads never logged. **SC-006 carve:** 017 *emits* the backlog-depth signal; the threshold→alert itself is operability/dashboard config (the observability stack), NOT DP2 code — same posture as the 015 DLQ-depth deferral. Predecessors: T041, T051. Acceptance: signals registered in the SHARED files (not a per-feature file); cardinality drift GREEN; SC-006 alerting documented as ops-config (not a DP2 task).
- [ ] T091 [P] Perf (report-only, no perf env — 005/008/009/010 precedent): `loadtests/k6/erpnext-reconciliation.js` (the backlog list under load; thresholds carried, not gating; skips cleanly without a session). Predecessors: T032. Acceptance: scenario authored; report-only.
- [ ] T092 Coverage ≥80% for the new module + worker; closeout (execution-map + wave-status terminal). Predecessors: T090, T091. Acceptance: coverage gate; map/wave-status reconciled.

---

## Dependencies & story completion order

```
Setup (T001-T004)
  └─ T001 SIGN-OFF ─┐
  └─ T002 SIGN-OFF  │
  └─ T003 SIGN-OFF ─┤
        ▼           │
Foundational (GATED):  T010 (contract) ∥ T012a→T012 (schema)   ← parallel-safe (disjoint files)
        ▼
  T020 (isolation harness)  ← needs T012
        ▼
US1 (T030-T034) 🎯 MVP  ← the first shippable increment
        ▼
US2 (T040-T044)  ← needs US1 service/projection + T012
US3 (T050-T056)  ← needs T012 + T020 (worker run) + US1 controller (routes)
        ▼   (US2 and US3 both build on US1; they serialize through the shared module)
Polish (T090-T092)  ← needs US2 + US3
```

- **US1 is the MVP** — independently shippable on the already-merged 015 data; delivers triage value alone.
- **US2** depends on US1 (the surfaced backlog + the shared service) + the `0020` table.
- **US3** depends on the `0020` table + the harness + the US1 controller (adds routes); the worker run is independent of US2.
- **US2 and US3 share `erpnext-reconciliation.controller.ts`/`.service.ts`** → serialize through the module (US1 first as MVP), like the 015 US1–US4 chain.

## Parallel execution opportunities

- **Foundational**: `T010` (contract, `packages/contracts`) ∥ `T012a→T012` (schema, `packages/db`) — disjoint files; both `[GATED]`, so running them as a pair needs explicit approval of BOTH.
- **Within US1**: `T033` (pagination) ∥ `T034` (HTTP-edge) after `T031`/`T032`.
- **Within US2**: `T043` (idempotency) ∥ `T044` (bounded) after `T041`.
- **Within US3**: `T054` (in-flight) ∥ `T055` (idempotency) ∥ `T056` (HTTP-edge) after `T051`/`T052`.
- **Polish**: `T090` (signals) ∥ `T091` (perf).

## Implementation strategy (MVP first, incremental delivery)

1. **Seters + GATED foundation** (T001–T012): record the three sign-offs, then the two `[GATED]` slices (contract + schema) with explicit owner approval, then the isolation harness.
2. **Ship US1 (MVP)** (T020 → T030–T034): the visible backlog — standalone value on the shipped 015 data.
3. **Ship US2** (T040–T044): in-system idempotent repair — closes the loop.
4. **Ship US3** (T050–T056): stock run + report + repair — completes the unified surface (connector-seam stub-tolerant).
5. **Polish** (T090–T092): shared signals, report-only perf, coverage, closeout.

> **The DLQ drain + reconciliation run + repair is exactly this spec** — 017 is the home the 015 `015-DLQ-DRAIN` stub and the 014 §8 carve pointed to. **Payment Entry** stays a later separately-gated arc (015 rider R1); **scheduled** runs are later wiring over the same processor (R5); a **connector→DP2 ERPNext-view contract** for the live stock-run read is a future `[GATED]` 012-style slice (R3).
