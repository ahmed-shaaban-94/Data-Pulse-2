# Wave Status — `005-pos-catalog-sync-reconciliation`

**Last updated:** 2026-05-25 (Wave 1 Phase 3 non-disclosing isolation slice merged — `005-WAVE1-NON-DISCLOSING` PR #332; SI-001/SI-004/FR-013/FR-092 cross-tenant invariants empirically enforced via service-direct `findByIdForTenant` returning `NotFoundException` on RLS-zero-rows)
**Spec:** [`specs/005-pos-catalog-sync-reconciliation/`](.)
**Base:** `origin/main` at `c151aeb` (PR #332, 2026-05-25 — `005-WAVE1-NON-DISCLOSING` merged)
**Active findings:** 0
**Resolved findings:** 2

---

## TL;DR

**12 Wave 1 slices merged** (`005-WAVE1-METRICS-ALLOWLIST` PR #299, `005-WAVE1-SETUP` PR #304, `005-WAVE1-IDEMP-VERIFY` PR #306, `005-WAVE1-HARNESS` PR #307, `005-WAVE1-CONTRACT` PR #315, `005-WAVE1-CAPTURE-HAPPY` PR #317, `005-WAVE1-CAPTURE-RESOLVE` PR #321, `005-WAVE1-IDEMP-STATUS-CAPTURE` PR #324, `005-WAVE1-CAPTURE-STORE-SCOPE` PR #326, `005-WAVE1-CAPTURE-DEDUP` PR #328, `005-WAVE1-VALIDATION` PR #331, **`005-WAVE1-NON-DISCLOSING` PR #332** — new this closeout). **8 Wave 1 candidate slices remain at `status: proposed`.** Planning artifacts (spec, plan, research, data-model, quickstart, contracts placeholder, tasks.md, execution-map, wave-status) are all merged on `main`. Both `005-METRICS-ALLOWLIST-PRECONDITION` and `005-IDEMP-STATUS-CAPTURE-DEFECT` findings are resolved (see "Resolved findings" below).

**Wave 2 tasks authored (2026-05-24)** — T600–T670 appended to `tasks.md` (§§13–21); 9 `005-WAVE2-*` slices added to `execution-map.yaml`. Dependency cleared: 003 `PHASE3_RED_WAVE` merged (PRs #300/#301/#302/#303); T336 `MISSING_WITHSTORE_HELPER` merged (PR #310).

**Phase 3 nearly complete.** Capture-prelude structurally complete (RESOLVE → STORE-SCOPE → DEDUP); boundary validation enforces 003's three CHK constraints at the API edge; cross-tenant non-disclosing posture empirically locked in (`findByIdForTenant` + cross-tenant value-probe). Only **`005-WAVE1-LIST`** (T523 + T524) remains in Phase 3 — the tenant-admin queue read endpoint that opens the `tenantAdminListUnknownItems` operationId. LIST will also flip the two `it.skip` tripwires left in `cross-tenant.spec.ts` (Group A #3 / Group B #3) to active cross-tenant-list assertions.

**Next moves:**

1. **Dispatch `005-WAVE1-LIST`** (T523 + T524, depends on CONTRACT + HARNESS — both merged) — closes Phase 3 and unblocks DISMISS in Phase 5.
2. **Dispatch Phase 4 slices**: IDEMP-WIRE (T530/T531), then IDEMP-MISMATCH (T532/T533), then IDEMP-EDGES (T534–T536). IDEMP-WIRE is dispatchable now (all predecessors merged).
3. **Dispatch Phase 5 slices** once their predecessors merge: DISMISS (T540–T543), FR005 (T544/T545), AUDIT (T546–T551), METRICS (T552/T553).
4. **Request `[GATED]` approval for `005-WAVE2-CONTRACT`** (T600 + T601, extending `packages/contracts/openapi/catalog/unknown-items.yaml` with `tenantAdminLinkUnknownItem` + `tenantAdminCreateProductFromUnknownItem`). Wave 2 implementation slices cannot dispatch until this merges.

---

## Merged on `main`

### Wave 1 slices merged

| Stage | Subject | Reference |
|---|---|---|
| `005-WAVE1-METRICS-ALLOWLIST` (slice) | Schema-only allowlist extension for 3 catalog counters (`unknown_item_captured_total`, `unknown_item_resolved_total{action}`, `idempotency_token_mismatch_total`); resolved `005-METRICS-ALLOWLIST-PRECONDITION` finding | PR #299 @ `28d1a0d` |
| `005-WAVE1-SETUP` (slice) | T500 module skeleton (`apps/api/src/catalog/unknown-items/unknown-items.module.ts`) + T501 counter registration in `api.metrics.ts`; introduced `CATALOG_METRIC_NAMES` sibling registry | PR #304 @ `622e509` |
| `005-WAVE1-IDEMP-VERIFY` (slice) | T505 — Verification spec proving the existing `IdempotencyInterceptor` covers FR-021/021a/021b/021c against a fake POS-principal context. Result: existing primitive is sufficient; Phase 4 needs no wrapper service. | PR #306 @ `4c16451` |
| `005-WAVE1-HARNESS` (slice) | T506 `seed-unknown-items.ts` fixture (6 deterministic rows, 4 barcode + 2 external_pos_id) + T507 cross-tenant RED suite (`cross-tenant.spec.ts`). Soft-skip gate (`serviceMissing()` returns early when `UnknownItemsService` is absent) keeps CI green until T511 ships GREEN — the gate flips off naturally once the service module is loadable. | PR #307 @ `e7c41b0` |
| `005-WAVE1-CONTRACT` (slice) | T503 + T504 — OpenAPI YAML at `packages/contracts/openapi/catalog/unknown-items.yaml` with Wave 1 operationIds (`posCaptureItem`, `tenantAdminListUnknownItems`, `tenantAdminDismissUnknownItem`); contract conformance spec. Unblocks all Phase 3+ slices. | PR #315 @ `6cb4a1b` |
| `005-WAVE1-CAPTURE-HAPPY` (slice) | T510 + T511 + T512 — US1 first end-to-end capture path: `UnknownItemsService.capture()` + `UnknownItemsController.capture()` + capture happy-path spec. Blocks all subsequent capture refinements (resolve, store-scope, dedup, validation, non-disclosing) and idempotency wiring. | PR #317 @ `5fc8549` |
| `005-WAVE1-CAPTURE-RESOLVE` (slice) | T513 + T514 — Alias-resolution prelude (FR-022/030/031): when POS sends a known alias `source_system`+`value` pair, resolve the alias to the matching `tenant_products` row and return `kind: "resolved"` + status 200. Updates `UnknownItemsService.captureItem()` and `UnknownItemsController.capture()` with discriminated-union response and status-branching logic. | PR #321 @ `f5e4a19` |
| `005-WAVE1-CAPTURE-STORE-SCOPE` (slice) | T515 + T516 — FR-030a store-scope respect at capture: alias-lookup WHERE clause adjusted to `store_id IS NULL OR store_id = $current_store`, ensuring tenant-wide aliases resolve everywhere but store-scoped aliases only resolve at the bound store. RED test spec + service implementation. | PR #326 @ `9cae6b5` |
| `005-WAVE1-CAPTURE-DEDUP` (slice) | T517 + T518 — FR-032 natural dedup via `idx_unknown_items_lookup_value` index: duplicate pending rows on the same unknown item within a store are deduplicated at capture. Completes the capture-prelude structural story (RESOLVE → STORE-SCOPE → DEDUP). Unblocks FR005. | PR #328 @ `d398513` |
| `005-WAVE1-IDEMP-STATUS-CAPTURE` (slice) | T539a + T539b — IdempotencyInterceptor status-preservation fix: line 274 now reads the original response's statusCode via ExecutionContext instead of hard-coding `HttpStatus.CREATED`, ensuring non-201 responses (e.g., resolved-to-alias 200) replay with the correct status. Includes regression test in `apps/api/test/idempotency/replay.spec.ts` and flips the `it.skip` tripwire in the capture-resolves-to-alias spec. Resolves `005-IDEMP-STATUS-CAPTURE-DEFECT` finding. | PR #324 @ `0c3638d` |
| `005-WAVE1-VALIDATION` (slice) | T519 + T520 — FR-070/071/072 Zod boundary validation mirroring 003's three `unknown_items` CHK constraints. Extracts schema from controller into `dto/capture-request.dto.ts` and adds the previously-silent bidirectional `source_system_required` rule via `.superRefine` (both arms). Behavior change: `{type:"barcode", source_system:"X"}` now rejects at the API boundary with 400 `validation_error` instead of 500'ing at the DB INSERT. Pure controller-pipe spec (8 cases, no Testcontainers needed — spy `UnknownItemsService` proves "no side-effects" structurally). | PR #331 @ `290cbaa` |
| `005-WAVE1-NON-DISCLOSING` (slice) | T521 + T522 — SI-001/SI-004/FR-013/FR-092 cross-tenant non-disclosing posture. Adds `UnknownItemsService.findByIdForTenant({id, tenantId, storeId})` running inside `runWithTenantContext` with explicit `app.current_store` GUC; SELECT WHERE id = $1 only (no application-level tenant predicate — RLS does the filtering, single source of truth). Zero rows → `NotFoundException` (404-class, indistinguishable from "id doesn't exist anywhere"). Rewrites `cross-tenant.spec.ts` from T507 placeholder asserts into 6 real service-direct cases + 2 `it.skip` tripwires deferred to T523/LIST. CodeRabbit follow-up: introduced `UnknownItemRow` (lifecycle-tolerant) so the GET-by-id return type isn't silently narrowed to `pending` via `as` casts; `CapturedUnknownItemRow` stays narrow for `captureItem` (correct by construction). | PR #332 @ `c151aeb` |

### Planning artifacts merged (for context)

| Stage | Subject | Reference |
|---|---|---|
| Spec | POS Catalog Sync & Unknown Item Reconciliation — 5 user stories, 40 FRs, 7 SI requirements, 8 SCs, 12 edge cases, 5 clarifications | PR #293 @ `9d835eb` |
| Plan + research + data-model + quickstart + contracts placeholder | Constitution check passes 14/14. Architecture Impact: High. 003 dependency readiness documented (data layer ✅; service layer ❌ — blocks Wave 2). | PR #294 @ `6895246` |
| Wave 1 `tasks.md` | 48 tasks across 19 candidate slices. TDD pairing (RED-then-GREEN). Two reviewer findings caught: idempotency wrapper was unnecessary (existing primitive covers FR-021/021a/021b/021c directly); audit-subjects registry doesn't exist (use `@Auditable` decorator at site). | PR #296 @ `5179682` |
| `execution-map.yaml` + `wave-status.md` (initial authoring) | Slice DAG, allowed/forbidden files, validation contracts, parallel-safety semantics, phase cohorts | PR #298 @ `dd38594` |

---

## Local only — committed/uncommitted, not on `main`

_None._

---

## Active findings

_None._

**Other known issues** (planning-time decisions, not findings):
- Header-name drift `Idempotency-Token` → `Idempotency-Key` in `spec.md` §5 and `quickstart.md` — fixup tracked in `tasks.md` T564.
- `PHASE3_RED_WAVE` dependency for Wave 2 (T350 + T383 on spec 003) — tracked in `plan.md §4` and `tasks.md §12`.

---

## Resolved findings

### `005-METRICS-ALLOWLIST-PRECONDITION` (high) — resolved

**Discovered**: 2026-05-23, during the first dispatch attempt of `005-WAVE1-SETUP`.

**Summary**: T501 (register three Wave 1 catalog counters in `apps/api/src/observability/metrics/api.metrics.ts`) cannot succeed within its declared `allowed_files`. The closed allowlist `ALLOWED_METRIC_LABELS` in `packages/shared/src/observability/metrics-labels.ts` gates every counter registration via `assertMetricLabels()` at module load. None of `unknown_item_captured_total`, `unknown_item_resolved_total{action}`, or `idempotency_token_mismatch_total` were allowlisted at `tasks.md` authoring time. Adding them requires editing 004-owned observability schema files — outside T501's `allowed_files` and forbidden to 005 by Standing Rules §3.

**Evidence**:
- `packages/shared/src/observability/metrics-labels.ts:111-143` — closed allowlist contents.
- `apps/api/src/observability/metrics/api.metrics.ts:75-86` — load-time `assertMetricLabels` calls.
- `packages/shared/src/observability/metrics-labels.ts:177-211` — unregistered-metric throw path.

**Resolution path** (chosen by owner via path (b) on 2026-05-23):

Added new `[GATED]` prerequisite slice `005-WAVE1-METRICS-ALLOWLIST` touching only the 004-owned schema files (`packages/shared/src/observability/metrics-labels.ts`, `docs/observability/signals.md` §1.1, and the `expectedSignals` drift-contract in `apps/api/test/observability/cardinality.spec.ts`). `005-WAVE1-SETUP` gained a `depends_on: [005-WAVE1-METRICS-ALLOWLIST]` edge so T501 could not dispatch until the allowlist landed on `main`.

**Why this path** (not the other two considered):
- (a) "expand SETUP's `allowed_files` to include the 004 files" — mixes 004-owned schema edits into a 005 chore slice and gates a slice that was meant to be ungated. Rejected.
- (c) "drop counter registration from Wave 1" — kicks the conversation downstream into T552/T553 and ships SETUP with only T500. Rejected because the user explicitly said "do not skip metric registration".
- (b) "new prereq slice" — matches 004's existing gating discipline (every observability schema change is its own `[GATED]` slice), keeps SETUP itself ungated. Accepted.

**Resolved by**: `005-WAVE1-METRICS-ALLOWLIST` slice.

**Audit fields**:
- `resolved_by_pr`: 299
- `resolved_at_commit`: `28d1a0d72725ffa93272dd2a2e9b912b11380cc4`
- `resolved_at`: 2026-05-23

### `005-IDEMP-STATUS-CAPTURE-DEFECT` (medium) — resolved

**Discovered**: 2026-05-25, during `005-WAVE1-CAPTURE-RESOLVE` implementation and testing (PR #321 authoring phase).

**Summary**: The existing `IdempotencyInterceptor` at `apps/api/src/idempotency/idempotency.interceptor.ts:274` hard-codes the replay response status to `HttpStatus.CREATED` (201). When a request is successfully resolved and returns a 200 to the client, a retry with the same `Idempotency-Key` will replay from the interceptor's cache and return 201 (created) instead of 200 (ok), violating the contract that the replay status matches the original response.

**Impact**: Non-critical in Wave 1 capture happy-path (calls only return 201 on fresh capture, 200 only on resolved-to-alias — so the resolved case has a status-code inconsistency on replay). Affects all future endpoints that return 200 on success. Blocks correctness for LIST and DISMISS operations if they return 200 and are idempotent.

**Evidence**:
- `apps/api/src/idempotency/idempotency.interceptor.ts:274` — hard-coded `HttpStatus.CREATED` in replay path
- `apps/api/test/catalog/unknown-items/capture/capture-resolves-to-alias.spec.ts:417` (PR #321) — `it.skip('should replay a resolved capture as 200...')` blocks the test to avoid CI failure; the skip is a tripwire flagging the defect

**Resolution**: Authored `005-WAVE1-IDEMP-STATUS-CAPTURE` slice (PR #324). The fix reads the original response's statusCode via `ExecutionContext` (`execCtx.switchToHttp().getResponse<{ statusCode: number }>().statusCode`) at line 274 instead of hard-coding `HttpStatus.CREATED`. Includes regression test in `apps/api/test/idempotency/replay.spec.ts` asserting non-201 status preservation through replay, and flips the `it.skip` tripwire in `apps/api/test/catalog/unknown-items/capture/capture-resolves-to-alias.spec.ts` to active `it()`. LIST and DISMISS are now correctness-safe for dispatch.

**Audit fields**:
- `discovered_in_slice_attempt`: `005-WAVE1-CAPTURE-RESOLVE`
- `discovered_at_commit`: `f5e4a19dd93abdc2520e21f0661f803a3c563edf` (PR #321)
- `discovered_at`: 2026-05-25
- `resolved_by_pr`: 324
- `resolved_at_commit`: `0c3638d0bcaa409cae13c2a9b7ca1e0da76c17a3`
- `resolved_at`: 2026-05-25

---

## Blocked

| Slice / wave | Blocked by | Resolution path |
|---|---|---|
| **Wave 2 entire** — US2 link reconciliation (FR-050–FR-053), US2 create-new reconciliation (FR-060–FR-063), US3 alias-conflict fail-closed (FR-040–FR-043) | **FULLY UNBLOCKED + TASKS AUTHORED 2026-05-24**: `PHASE3_RED_WAVE` merged (PRs #300–#303); T336 merged (PR #310). Wave 2 tasks T600–T670 appended to `tasks.md`; 9 `005-WAVE2-*` slices in `execution-map.yaml`. | Request `[GATED]` approval for `005-WAVE2-CONTRACT` (T600/T601). Once merged, dispatch `005-WAVE2-CONFLICT` then the link/create-new slices per the DAG in execution-map.yaml. |

---

## Ready / in-flight

_None._

8 Wave 1 slices remain at `status: proposed`. 9 Wave 2 slices at `status: proposed` (authored 2026-05-24). None have been approved for dispatch.

### Process note — recovery threshold calibration (from PR #328 retrospective)

PR #328's orchestrator authored a recovery commit at the 15-minute post-edit silence mark, believing the agent's transcript had failed. The agent completed cleanly shortly after with full session output and identical byte-for-byte implementation. Lesson: post-edit silence on background agents is **NOT** a reliable death signal at the 15-minute mark. Multi-suite Testcontainers validation + write-fix-rerun loops can legitimately consume 25+ minutes of post-edit work. Future recovery decisions should wait ≥30 minutes of silence + no in-progress notification before assuming agent failure.

---

## Proposed (awaiting approval / dispatch)

_Phase 0 (cross-spec prerequisite), Phase 1 (setup), Phase 2 (foundational), Phase 3 happy-path/resolve/store-scope/dedup/validation/non-disclosing, and Phase 4 idempotency-status-capture slices are complete; see "Merged on `main`." Only `005-WAVE1-LIST` remains in Phase 3._

### Phase 3 — US1 Capture (P1 / MVP)

- **`005-WAVE1-LIST`** (T523, T524) — tenant-admin queue read endpoint; opens the `tenantAdminListUnknownItems` operationId from the merged Wave 1 contract. Will flip the two `it.skip` tripwires in `cross-tenant.spec.ts` (deferred from PR #332 / T521) to active cross-tenant-list assertions. **READY TO DISPATCH.** All dependencies satisfied (CONTRACT + HARNESS — both merged).

### Phase 4 — US4 Idempotency (P2)

- **`005-WAVE1-IDEMP-WIRE`** (T530, T531) — `@Idempotent('required')` on capture route.
- **`005-WAVE1-IDEMP-MISMATCH`** (T532, T533) — small exception filter augmenting the existing 409 with catalog-domain audit + counter (no wrapper service).
- **`005-WAVE1-IDEMP-EDGES`** (T534, T535, T536) — FR-021a, FR-021b, FR-022.

### Phase 5 — US5 Audit + Dismiss (P2)

- **`005-WAVE1-DISMISS`** (T540, T541, T542, T543) — dismiss endpoint + monotonicity guard.
- **`005-WAVE1-FR005`** (T544, T545) — dismissed-then-resubmit produces fresh `pending`.
- **`005-WAVE1-AUDIT`** (T546–T551) — `@Auditable` decorators + audit-emission verification for all 3 Wave 1 subjects.
- **`005-WAVE1-METRICS`** (T552, T553) — counter-increment verification at all 3 emission sites.

### Phase 6 — Polish

- **`005-WAVE1-POLISH`** (T560, T561, T562, T563, T564) — perf smoke test (SC-008), regression sweeps (T341/T342/T343/T344 + 001 idempotency + audit-fanout), header-name drift fixup, wave-status closeout.

---

### Wave 2 — Reconciliation path (tasks authored 2026-05-24)

#### Phase 2 (Wave 2) — Gated contract extension

- **`005-WAVE2-CONTRACT`** (T600, T601) — extend `packages/contracts/openapi/catalog/unknown-items.yaml` with `tenantAdminLinkUnknownItem` + `tenantAdminCreateProductFromUnknownItem`. **`[GATED]`** — requires explicit approval. **Gating bottleneck for all Wave 2 implementation slices.**

#### Phase 3 (Wave 2) — US3 alias-conflict safety floor

- **`005-WAVE2-CONFLICT`** (T610, T611) — RED test harness for alias-conflict fail-closed (FR-040–FR-043). Precedes link + create-new.

#### Phase 4 (Wave 2) — US2 #1 link reconciliation

- **`005-WAVE2-LINK-HAPPY`** (T620, T621, T622) — link happy path; creates `ReconciliationService`.
- **`005-WAVE2-LINK-EDGES`** (T623, T624, T625, T626) — target-unavailable + already-reconciled edge cases.

#### Phase 5 (Wave 2) — US2 #2 create-new reconciliation

- **`005-WAVE2-CREATE-HAPPY`** (T630, T631, T632) — create-new happy path; extends `ReconciliationService`.
- **`005-WAVE2-CREATE-EDGES`** (T633, T634, T635, T636) — create alias conflict + body validation.

#### Phase 6 (Wave 2) — Audit, metrics, regression sweeps

- **`005-WAVE2-AUDIT`** (T640–T645) — all three Wave 2 audit subjects; dual-emission guard.
- **`005-WAVE2-METRICS`** (T650, T651) — counter increments at link + create-new sites.

#### Phase 7 (Wave 2) — Polish & closeout

- **`005-WAVE2-POLISH`** (T660, T661, T662, T670) — regression sweeps, SC-007 atomicity verification, Wave 2 closeout.

### Proposed phase cohorts

> **These are phase cohorts for human readability, NOT flat-dispatchable waves.** Runtime dispatch MUST honor each member slice's `depends_on` DAG in [`execution-map.yaml`](./execution-map.yaml). `parallel_safety: safe` on a group reflects the schema's file/fixture disjointness contract — it does not mean members are dependency-flat. See the `groups:` block header in `execution-map.yaml` for the full semantics.

| Cohort | Members | Notes |
|---|---|---|
| `PHASE_0_1_2_COHORT` | METRICS-ALLOWLIST + SETUP + IDEMP-VERIFY + HARNESS + CONTRACT | All five merged: METRICS-ALLOWLIST PR #299, SETUP PR #304, IDEMP-VERIFY PR #306, HARNESS PR #307 (all 2026-05-23), CONTRACT PR #315 (2026-05-24). Cohort id retained in `execution-map.yaml` for traceability. |
| `PHASE_3_COHORT` | CAPTURE-HAPPY (merged) + 6 dependent slices | CAPTURE-HAPPY merged PR #317 (2026-05-24). Remaining members: CAPTURE-RESOLVE, CAPTURE-STORE-SCOPE, CAPTURE-DEDUP, VALIDATION, NON-DISCLOSING, LIST. Intra-cohort DAG: CAPTURE-HAPPY was the root; descendants depend on it. RED test authoring is parallel-safe across disjoint spec files; GREEN impls serialize through shared `unknown-items.service.ts` and `unknown-items.controller.ts`. |
| `PHASE_4_5_COHORT` | 7 idempotency/dismiss/audit/metrics slices | Intra-cohort DAG: IDEMP-WIRE `blocks` MISMATCH + EDGES; DISMISS `blocks` FR005 + AUDIT. RED tests where disjoint may dispatch in parallel; GREENs serialize through shared service/controller/filter files. |

See [`execution-map.yaml`](./execution-map.yaml) `groups:` section for full member lists, intra-cohort DAG notes, and the schema-anchored definition of what `parallel_safety: safe` means on a group.

---

## Wave 2 — tasks authored (2026-05-24)

Wave 2 covers the reconciliation path: tenant admin links an unknown item to an existing tenant product (US2 #1, FR-050–FR-053), creates a new tenant product from an unknown item (US2 #2, FR-060–FR-063), and alias-conflict fail-closed (US3, FR-040–FR-043).

**Dependency cleared 2026-05-23/24**:
- T350 + T351 → `TenantCatalogService.create` on `main` via PR #300 @ `2bf7e27`.
- T383 + T384 → `ProductAliasesService.create` on `main` via PR #303 @ `454a7ae`.
- T336 → `MISSING_WITHSTORE_HELPER` resolved via PR #310 @ `main` (path b).

**Wave 2 planning artifacts authored 2026-05-24**:
- `tasks.md` §§13–21 — T600–T670 (71 tasks, 9 candidate slices).
- `execution-map.yaml` — 9 `005-WAVE2-*` slices + 3 Wave 2 cohort groups.

**Architecture decision recorded**: `ReconciliationService` owns raw multi-row SQL inside a single `runWithTenantContext` transaction. Does NOT compose `TenantCatalogService.create` or `ProductAliasesService.create` for atomic writes (those services open independent transactions and would violate FR-053/FR-063 atomicity). See `tasks.md` §13 architecture note.

**9 Wave 2 slices proposed**:

| Slice | Tasks | Approval |
|---|---|---|
| `005-WAVE2-CONTRACT` | T600, T601 | **`[GATED]`** |
| `005-WAVE2-CONFLICT` | T610, T611 | none |
| `005-WAVE2-LINK-HAPPY` | T620, T621, T622 | none |
| `005-WAVE2-LINK-EDGES` | T623, T624, T625, T626 | none |
| `005-WAVE2-CREATE-HAPPY` | T630, T631, T632 | none |
| `005-WAVE2-CREATE-EDGES` | T633, T634, T635, T636 | none |
| `005-WAVE2-AUDIT` | T640–T645 | none |
| `005-WAVE2-METRICS` | T650, T651 | none |
| `005-WAVE2-POLISH` | T660, T661, T662, T670 | none |

---

## Next recommended action

Phase 3 is one slice from done. **`005-WAVE1-LIST`** is the natural next dispatch — it closes Phase 3, opens the public list endpoint, and flips the two `it.skip` tripwires NON-DISCLOSING left behind. After that, Phase 4 (IDEMP-WIRE) is the next ready slice and the queue keeps moving.

Reusable Maestro prompt:

```text
# Phase 3 LIST (closes Phase 3):
Use Agent OS. Execute slice 005-WAVE1-LIST. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation
```

Alternatively, **`005-WAVE1-IDEMP-WIRE`** (T530 + T531 — applies `@Idempotent('required')` to the capture route + retry-identical RED test) is also dispatchable now: it depends on IDEMP-VERIFY + CAPTURE-HAPPY (both merged) and touches only the controller + a new test file, so it doesn't conflict with LIST's planned edits to `unknown-items.service.ts`. Running LIST and IDEMP-WIRE in serial (LIST first, since it shares the service file with future slices) keeps merges clean.

**Track 2: Wave 2 setup** — Request `[GATED]` approval for `005-WAVE2-CONTRACT` (T600 + T601, extending `packages/contracts/openapi/catalog/unknown-items.yaml` with `tenantAdminLinkUnknownItem` + `tenantAdminCreateProductFromUnknownItem`). Wave 2 implementation slices cannot dispatch until this merges. Once approved + merged, dispatch `005-WAVE2-CONFLICT` then the link/create-new slices per the DAG. Reusable Maestro prompt:

```text
# Wave 2 contract — request approval:
Use Agent OS. Execute slice 005-WAVE2-CONTRACT. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation

# Wave 2 conflict harness (after 005-WAVE2-CONTRACT merges):
Use Agent OS. Execute slice 005-WAVE2-CONFLICT. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation
```

---

## Post-merge closeout

When a PR for one of this spec's slices merges to `main`, run the closeout to refresh both this file and `execution-map.yaml`.

Full workflow: [`docs/agent-os/maestro-playbook.md`](../../docs/agent-os/maestro-playbook.md) "Workflow — post-merge closeout".

The closeout updates these audit fields on the merged slice:
`merged_in_pr`, `merged_at_commit`, `merged_at_date`, `previously_blocked`.
If the slice resolves a finding, the same closeout sets
`resolved_by_pr`, `resolved_by_commit`, `resolved_at`, and
`previously_blocked` on the finding entry.

Short prompt template:

```text
Use Agent OS.
Close out PR #<PR_NUMBER>.
Spec: specs/005-pos-catalog-sync-reconciliation
Expected slice: <SLICE_ID>
Update execution-map.yaml and wave-status.md.
Stop before commit.
```
