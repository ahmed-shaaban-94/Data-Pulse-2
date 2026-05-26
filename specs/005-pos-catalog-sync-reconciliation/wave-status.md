# Wave Status — `005-pos-catalog-sync-reconciliation`

**Last updated:** 2026-05-26 (Phase 5+ cleared: FR-005, AUDIT (partial), IDEMP-EDGES, and DISMISS-CARVEOUT-FIX all landed within an 18-minute window. METRICS is the last blocker before POLISH.)
**Spec:** [`specs/005-pos-catalog-sync-reconciliation/`](.)
**Base:** `origin/main` at `043c1c2` (PR #345, 2026-05-26 — `005-WAVE1-IDEMP-EDGES` merged)
**Active findings:** 0
**Resolved findings:** 3

---

## TL;DR

**19 Wave 1 slices merged + 1 hotfix (DISMISS-CARVEOUT-FIX). Phase 3 COMPLETE, Phase 4 COMPLETE, Phase 5 nearly complete — METRICS is the sole remaining blocker before POLISH.** (`005-WAVE1-METRICS-ALLOWLIST` PR #299, `005-WAVE1-SETUP` PR #304, `005-WAVE1-IDEMP-VERIFY` PR #306, `005-WAVE1-HARNESS` PR #307, `005-WAVE1-CONTRACT` PR #315, `005-WAVE1-CAPTURE-HAPPY` PR #317, `005-WAVE1-CAPTURE-RESOLVE` PR #321, `005-WAVE1-IDEMP-STATUS-CAPTURE` PR #324, `005-WAVE1-CAPTURE-STORE-SCOPE` PR #326, `005-WAVE1-CAPTURE-DEDUP` PR #328, `005-WAVE1-VALIDATION` PR #331, `005-WAVE1-NON-DISCLOSING` PR #332, `005-WAVE1-LIST` PR #334, `005-WAVE1-IDEMP-WIRE` PR #336, `005-WAVE1-IDEMP-MISMATCH` PR #339, `005-WAVE1-DISMISS` PR #341, **`005-WAVE1-FR005` PR #343, `005-WAVE1-AUDIT` PR #344 (partial), `005-WAVE1-IDEMP-EDGES` PR #345, `005-WAVE1-DISMISS-CARVEOUT-FIX` PR #346** — new this closeout). **1 Wave 1 candidate slice remains at `status: proposed` (METRICS). T550/T551 deferred from AUDIT (#344) are a known follow-up item.** Planning artifacts (spec, plan, research, data-model, quickstart, contracts placeholder, tasks.md, execution-map, wave-status) are all merged on `main`. All three findings (`005-METRICS-ALLOWLIST-PRECONDITION`, `005-IDEMP-STATUS-CAPTURE-DEFECT`, `005-DISMISS-SENTINEL-REGRESSION`) are resolved.

**Wave 2 tasks authored (2026-05-24)** — T600–T670 appended to `tasks.md` (§§13–21); 9 `005-WAVE2-*` slices added to `execution-map.yaml`. Dependency cleared: 003 `PHASE3_RED_WAVE` merged (PRs #300/#301/#302/#303); T336 `MISSING_WITHSTORE_HELPER` merged (PR #310).

**Four PRs landed in an 18-minute window on 2026-05-26**, collectively completing FR005, the first half of AUDIT, all of IDEMP-EDGES, and a surgical hotfix that unblocked all three. FR005 (T544/T545) tightened the capture query to filter on `resolution_status='pending'` so a dismissed-then-resubmitted item creates a fresh pending row. AUDIT (T546–T549) shipped capture-audit and dismiss-audit specs; T550/T551 (idempotency-mismatch-audit) deferred. IDEMP-EDGES (T534–T536) completed the FR-021a/021b/022 test coverage. DISMISS-CARVEOUT-FIX (PR #346) was the hotfix prerequisite — see cross-spec regression section below.

**METRICS (T552/T553) is now the last blocker before POLISH.**

**Next moves:**

1. **Dispatch Phase 5 — METRICS** (T552/T553): assert counter increments at all 3 emission sites (`unknown_item_captured_total`, `unknown_item_resolved_total{action="dismissed"}`, `idempotency_token_mismatch_total`). The service likely needs a small counter call addition for the `dismissed` action. This is the final Wave 1 required slice.
2. **Follow-up T550/T551** (idempotency-mismatch-audit, deferred from AUDIT PR #344): now that DISMISS-CARVEOUT-FIX is merged, these can dispatch as a standalone micro-slice or be absorbed into METRICS or POLISH.
3. **Request `[GATED]` approval for `005-WAVE2-CONTRACT`** (T600 + T601). Wave 2 implementation slices cannot dispatch until this merges.

**Outstanding known gap (deferred):** Auth-guard wiring on the unknown-items controller. CAPTURE-HAPPY (PR #317), NON-DISCLOSING (PR #332), LIST (PR #334), IDEMP-WIRE (PR #336), IDEMP-MISMATCH (PR #339), and DISMISS (PR #341 — adds the 6th unguarded route) all ship without `@UseGuards(AuthGuard, TenantContextGuard, RolesGuard)`. Of the new PRs: FR005 (PR #343) touches only the service file, not the controller; AUDIT (PR #344) adds `@Auditable` decorators to the controller but no new routes; IDEMP-EDGES (PR #345) is test-only. The unguarded route count remains 6. CodeRabbit flagged this on PR #334 (twice); not re-raised on subsequent PRs since the JSDoc disclaimer + this section serve as the durable deferral mechanism. Deferred-with-rationale because `apps/api/src/auth/**` is forbidden surface for 005 and adding guards to one route alone creates inconsistency. A follow-up "auth-wiring" slice should address all 6 routes consistently — POS routes use bearer tokens while admin routes use session cookies, so the guard parameterization will differ. Will need `[GATED]` approval per Standing Rules §3.

**Outstanding known gap (deferred):** T550/T551 (idempotency-mismatch-audit.spec.ts) were deferred from AUDIT PR #344 because the DISMISS-CARVEOUT-FIX (#346) had not yet landed at authoring time. Both are now unblocked. Can be picked up as a standalone micro-slice or absorbed into POLISH.

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
| `005-WAVE1-LIST` (slice) | T523 + T524 — FR-014 tenant-admin queue read endpoint. Adds `UnknownItemsService.listForTenant({tenantId, storeId, status, limit, storeIdFilter?})` with `app.current_store` GUC driving RLS visibility (empty-string for tenant-wide actors per 0009 carve-out; UUID for store-scoped operators); SELECT WHERE resolution_status = $1 [AND store_id = $2] only — no application-level tenant predicate, RLS filters cross-tenant. Adds `@Get("api/v1/catalog/unknown-items")` controller route with Zod `.strict()` query validation (status / store_id / cursor / limit). **Controller-prefix refactor**: class moved from `@Controller("api/pos/v1/catalog/unknown-items")` to `@Controller()` with paths on each method, so POS-facing (`/api/pos/v1/...`) and dashboard-facing (`/api/v1/...`) route families coexist; CAPTURE-HAPPY's served URL unchanged (23/23 capture tests pass unmodified). Service-direct + supertest hybrid spec (6 service cases + 1 supertest case for HTTP boundary coverage per CodeRabbit feedback). Wave 1 single-pages within `limit` (≤200), `next_cursor` always null — cursor parameter accepted at boundary for forward-compat but ignored internally. **DISMISS now unblocked** (was sole `blocks:` entry). | PR #334 @ `bdb582e` |
| `005-WAVE1-IDEMP-WIRE` (slice) | T530 + T531 — FR-021 retry-identical at N=5 against the real `posCaptureItem` route. Slice ships as a single new test file (`retry-identical.spec.ts`) because T531 (`@Idempotent('required')` on capture route) was already applied in PR #317 / CAPTURE-HAPPY. The spec closes the coverage gap between capture-happy-path's N=2 real-route assertion and existing-primitive-coverage.spec.ts's N=5 stub-controller assertion — neither alone matched T530's brief verbatim (N=5 × real route × full DB+metric+replay-header assertion set). **IDEMP-MISMATCH and IDEMP-EDGES both newly unblocked** by this merge. | PR #336 @ `d57efc6` |
| `005-WAVE1-IDEMP-MISMATCH` (slice) | T532 + T533 — FR-021c catalog-domain audit + counter on the existing 409 path. Adds `IdempotencyMismatchFilter` (NestJS `@Catch(ConflictException)` filter with narrow `code === "idempotency_key_conflict"` check) that catches the 001 `IdempotencyInterceptor`'s payload-mismatch exception, fires `recordIdempotencyTokenMismatch()` + enqueues `unknown_item.idempotency_mismatch_rejected` audit subject, then re-throws so `GlobalExceptionFilter` formats the canonical 409 envelope. Method-scoped via `@UseFilters(IdempotencyMismatchFilter)` on `posCaptureItem` only (slice-entry fix in PR #338 added controller to allowed_files + new stop rule against class-scope). Two load-bearing design decisions documented inline: (a) `@Optional()` on the `AUDIT_JOB_ENQUEUER` injection so legacy test fixtures without the audit module don't fail DI compile; (b) try/catch around `enqueue()` so transient audit-pipeline failures can't replace the deterministic 409 with a 500 (CodeRabbit Major catch on fixup commit). Together they encode "audit is best-effort; response contract is load-bearing" at two failure modes. **AUDIT + METRICS slice dependencies reduced from 3 to 1**: only DISMISS remains. | PR #339 @ `0eef243` |
| `005-WAVE1-DISMISS` (slice) | T540–T543 — FR-002/FR-003/FR-004 monotonic lifecycle. Adds `UnknownItemsService.dismissUnknownItem({id, tenantId, storeId, actorUserId})` with the **UPDATE-first + conditional-SELECT** pattern: atomic UPDATE with `WHERE id=$1 AND resolution_status='pending'` (the monotonicity guard — slice's stop rule), RETURNING for success, conditional SELECT on rowCount=0 to distinguish 404 non-disclosing (RLS filtered) from 409 `already_reconciled` (visible but not pending). Race-safe per US3 #3 invariant. Adds `@Post("api/v1/catalog/unknown-items/:id/dismiss")` with `@HttpCode(HttpStatus.OK)` (CodeRabbit Critical catch — NestJS POST defaults to 201; Docker-soft-skip locally couldn't validate the 200 contract), `@Param("id", ZodValidationPipe(z.string().uuid()))`, `@Auditable("unknown_item.dismissed")`. No `@Idempotent` (lifecycle invariant provides natural idempotency). Discriminated-union callback return shape (`{kind: "ok"\|"already_reconciled"\|"not_found"}`) keeps exception-throwing OUTSIDE `runWithTenantContext`'s transaction. Reuses LIST's `rowToUnknownItemWireShape` adapter. 7 test cases across 2 specs (happy-path service-direct + supertest, monotonic 409 + non-disclosing 404). **Three downstream slices unblock**: FR005 / AUDIT / METRICS. | PR #341 @ `1ff755f` |
| `005-WAVE1-DISMISS-CARVEOUT-FIX` (hotfix) | Surgical 3-line fix to three call sites in `UnknownItemsService` (`listForTenant`, `dismissUnknownItem`, `findByIdForTenant`) that still passed `input.storeId ?? ""` for the tenant-wide read carve-out sentinel after 003-catalog-foundation migration 0011 (PR #295) changed it from `''` to `'*'`. The `''` sentinel became fail-closed under the new migration, so all three db-integration tests failed when run against real Postgres in CI. Fix: replace `?? ""` with `?? "*"` at the three affected sites. **Prerequisite unblock for PR #343 / #344 / #345.** See "Cross-spec regression" section below. | PR #346 @ `08ab044` |
| `005-WAVE1-FR005` (slice) | T544/T545 — FR-005 dismissed-then-resubmit invariant. Tightened `captureUnknownItem`'s natural-dedup query to filter on `resolution_status = 'pending'` so a POS resubmission after a dismiss creates a fresh pending row rather than silently returning the dismissed record. The partial index `idx_unknown_items_lookup_value` already enforces uniqueness only over pending rows at the DB layer; this slice adds the service-layer assertion and the RED spec (`dismissed-then-resubmit.spec.ts`, 484 lines). | PR #343 @ `83eb810` |
| `005-WAVE1-AUDIT` (slice — partial) | T546–T549 shipped: `capture-audit.spec.ts` (325 lines) + `dismiss-audit.spec.ts` (255 lines) verifying FR-080/082 audit emission for the capture and dismiss paths. **T550/T551 deferred** (idempotency-mismatch-audit.spec.ts) — DISMISS-CARVEOUT-FIX had not yet landed when this PR was authored; now that PR #346 is merged, T550/T551 can be picked up as the next follow-up slice or absorbed into POLISH. | PR #344 @ `0a7cb10` |
| `005-WAVE1-IDEMP-EDGES` (slice) | T534–T536 — FR-021a (per-device key scoping), FR-021b (24h TTL expiry), FR-022 (post-resolved idempotency behaviour). Three disjoint test-only specs (`cross-device-keys.spec.ts` 459 lines, `ttl-expiry.spec.ts` 433 lines, `post-resolved.spec.ts` 504 lines). Completes the FR-021 family coverage. No service or controller edits. | PR #345 @ `043c1c2` |

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
- **T550/T551 follow-up** (idempotency-mismatch-audit.spec.ts): deferred from AUDIT PR `#344`; DISMISS-CARVEOUT-FIX is now merged so these are unblocked. **These tasks** can be picked up as a standalone micro-slice or absorbed into POLISH (T564).

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

### `005-DISMISS-SENTINEL-REGRESSION` (high) — resolved

**Discovered**: 2026-05-26, when CI ran db-integration tests for PRs #343, #344, and #345 against real Postgres.

**Summary**: All three PRs initially failed db-integration CI because `UnknownItemsService` still passed `input.storeId ?? ""` for the tenant-wide read carve-out sentinel at three call sites (`listForTenant`, `dismissUnknownItem`, `findByIdForTenant`). Migration `0011_catalog_store_carveout_sentinel.sql` (003-catalog-foundation PR #295, 2026-05-24) had changed the sentinel value from `''` (empty string) to `'*'` and made `''` explicitly fail-closed (RLS rejects `''` as a store_id now). This is a **cross-spec coordination bug**: a migration in a different feature's spec changed GUC semantics under live consumer code in this spec, and neither DISMISS (PR #341) nor LIST (PR #334) detected it because both merged locally with `MIGRATION_TEST_ALLOW_SKIP=1` (Docker-soft-skip). CI on the next slice's tests against real Postgres is what surfaced it.

**Why it was missed locally**: Docker-soft-skip (`MIGRATION_TEST_ALLOW_SKIP=1`) bypasses Testcontainers and does not run the migration stack. The service's `?? ""` fallback looked correct against any fixture that already had the tenant-wide carve-out pre-seeded; only a real Postgres run with migration 0011 applied triggered the fail-closed path.

**Pattern classification**: This is the 5th occurrence of a "slice-entry-bug" in this spec (prior 4: PRs #314, #319, #320, #338 — all `allowed_files` gaps). However, it is qualitatively different from the prior four: those were single-spec authoring oversights; this was a **cross-spec migration coordination failure** where 003's migration 0011 changed a contract (the GUC sentinel value) that 005 was silently consuming without a declared dependency edge.

**Evidence**:
- `apps/api/src/catalog/unknown-items/unknown-items.service.ts` — three `?? ""` sites (pre-fix)
- `003-catalog-foundation` PR #295 migration `0011_catalog_store_carveout_sentinel.sql` — changed sentinel from `''` to `'*'`, made `''` fail-closed
- PRs #343, #344, #345 CI logs — db-integration failures before #346 merged

**Resolution**: PR #346 (`005-WAVE1-DISMISS-CARVEOUT-FIX`) — 3-line literal replacement at all three call sites: `?? ""` replaced with `?? "*"`. Single file changed (`unknown-items.service.ts`). No schema, no migration, no contract change.

**Meta-lesson**: Cross-spec migration coordination needs a survey gate. When a migration changes a GUC sentinel, constants value, or protocol detail that other specs consume, the spec owning the migration should sweep all active consumer specs before merge (or add a "breaking change" annotation to the migration file). The Docker-soft-skip workflow empirically validates Standing Rule §6: local soft-skip can let regressions land on `main` that CI will catch on the next affected slice.

**Audit fields**:
- `discovered_in_slice_attempt`: `005-WAVE1-FR005` (PR #343 CI)
- `discovered_at`: 2026-05-26
- `resolved_by_pr`: 346
- `resolved_at_commit`: `08ab0445ff02fcae1430f99e21c7b1d8828f7af4`
- `resolved_at`: 2026-05-26

---

## Cross-spec regression — 005's first hotfix

See `005-DISMISS-SENTINEL-REGRESSION` in Resolved findings above for the full narrative. The key facts for ops context:

- **Root cause**: 003-catalog-foundation migration `0011` (PR #295, 2026-05-24) changed `app.current_store` GUC's tenant-wide carve-out sentinel from `''` to `'*'` and made `''` fail-closed.
- **Why it survived until 2026-05-26**: DISMISS (PR #341) and LIST (PR #334) both merged locally with `MIGRATION_TEST_ALLOW_SKIP=1`. The soft-skip path does not run migrations against real Postgres, so the `?? ""` sites appeared correct.
- **How it was caught**: CI ran the next slices (#343/#344/#345) against real Postgres with migration 0011 applied; the fail-closed `''` path triggered on the three affected service methods.
- **The fix**: PR #346 — 3-line literal replacement, single file. Prerequisite merge for all three feature PRs to go green.
- **Meta-lesson**: Migrations that change GUC semantics need an active-consumer sweep before merge. Docker-soft-skip empirically validates Standing Rule §6.

---

## Blocked

| Slice / wave | Blocked by | Resolution path |
|---|---|---|
| **Wave 2 entire** — US2 link reconciliation (FR-050–FR-053), US2 create-new reconciliation (FR-060–FR-063), US3 alias-conflict fail-closed (FR-040–FR-043) | **FULLY UNBLOCKED + TASKS AUTHORED 2026-05-24**: `PHASE3_RED_WAVE` merged (PRs #300–#303); T336 merged (PR #310). Wave 2 tasks T600–T670 appended to `tasks.md`; 9 `005-WAVE2-*` slices in `execution-map.yaml`. | Request `[GATED]` approval for `005-WAVE2-CONTRACT` (T600/T601). Once merged, dispatch `005-WAVE2-CONFLICT` then the link/create-new slices per the DAG in execution-map.yaml. |

---

## Ready / in-flight

_None._

1 Wave 1 slice remains at `status: proposed` (METRICS). T550/T551 are a deferred follow-up not yet represented as a separate slice. 9 Wave 2 slices at `status: proposed` (authored 2026-05-24). None have been approved for dispatch.

### Process note — recovery threshold calibration (from PR #328 retrospective)

PR #328's orchestrator authored a recovery commit at the 15-minute post-edit silence mark, believing the agent's transcript had failed. The agent completed cleanly shortly after with full session output and identical byte-for-byte implementation. Lesson: post-edit silence on background agents is **NOT** a reliable death signal at the 15-minute mark. Multi-suite Testcontainers validation + write-fix-rerun loops can legitimately consume 25+ minutes of post-edit work. Future recovery decisions should wait ≥30 minutes of silence + no in-progress notification before assuming agent failure.

---

## Proposed (awaiting approval / dispatch)

_**Phase 3 is COMPLETE** as of PR #334. Phase 0/1/2 prerequisites and all 7 Phase 3 slices merged; see "Merged on `main`." Phase 4 (idempotency wiring on capture route) and Phase 5 (dismiss + audit + metrics) are now both open for dispatch. The two `it.skip` tripwires in `cross-tenant.spec.ts` were NOT flipped by LIST (that file was out of LIST's `allowed_files`) — they remain as obsolete scaffold for a future micro-slice or can be tidied as part of POLISH (T564)._

### Phase 4 — US4 Idempotency (P2)

- **`005-WAVE1-IDEMP-EDGES`** (T534, T535, T536) — **MERGED** PR #345 @ `043c1c2` (2026-05-26).

### Phase 5 — US5 Audit + Dismiss (P2)

- **`005-WAVE1-FR005`** (T544, T545) — **MERGED** PR #343 @ `83eb810` (2026-05-26).
- **`005-WAVE1-AUDIT`** (T546–T549 shipped, T550/T551 deferred) — **MERGED (partial)** PR #344 @ `0a7cb10` (2026-05-26). T550/T551 are a follow-up item (see "Other known issues" above).
- **`005-WAVE1-METRICS`** (T552, T553) — counter-increment verification at all 3 emission sites. **READY TO DISPATCH** (METRICS is now the last Wave 1 slice; dispatching it unlocks POLISH).

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

**METRICS (T552/T553) is the last Wave 1 slice before POLISH.** Dispatching it unlocks `005-WAVE1-POLISH` (the only slice still blocked). The service will need at least a small counter call addition for the `dismissed` action — the DISMISS slice explicitly deferred that for METRICS to author.

```text
# Dispatch Phase 5 — METRICS (last Wave 1 blocker):
Use Agent OS. Execute slice 005-WAVE1-METRICS. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation
```

**Parallel-safe alternative**: T550/T551 (idempotency-mismatch-audit.spec.ts, deferred from AUDIT PR #344). Now that DISMISS-CARVEOUT-FIX is merged, these are unblocked and file-disjoint from METRICS. They can be dispatched in parallel or absorbed into POLISH at the owner's discretion.

```text
# Optional follow-up T550/T551 (parallel-safe with METRICS):
Use Agent OS. Execute slice 005-WAVE1-AUDIT (T550/T551 follow-up only). Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation
```

**Wave 2 setup (`[GATED]`)**: Request approval for `005-WAVE2-CONTRACT` (T600 + T601, extending `packages/contracts/openapi/catalog/unknown-items.yaml` with `tenantAdminLinkUnknownItem` + `tenantAdminCreateProductFromUnknownItem`). Wave 2 implementation slices cannot dispatch until this merges. Once approved + merged, dispatch `005-WAVE2-CONFLICT` then the link/create-new slices per the DAG.

```text
# Wave 2 contract — request [GATED] approval:
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
