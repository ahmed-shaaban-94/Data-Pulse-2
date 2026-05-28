# Wave Status — `005-pos-catalog-sync-reconciliation`

**Last updated:** 2026-05-27 (Wave 2 POLISH — Wave 2 complete pending this POLISH merge)
**Spec:** [`specs/005-pos-catalog-sync-reconciliation/`](.)
**Base:** `origin/main` at `5565c32` (PR #373 metrics-coverage follow-up merged, 2026-05-27; this POLISH PR is the final Wave 2 slice)
**Active findings:** 0
**Resolved findings:** 3

---

## TL;DR

**Wave 1 is COMPLETE.** 21 implementation slices + 1 hotfix merged over 2026-05-23 to 2026-05-26 (3 days). Spec 005 Phase 6 (POLISH) has landed: perf smoke test authored (SC-008, soft-skipped locally — CI authoritative), regression sweeps confirmed GREEN (003 isolation + 001 idempotency + audit-fanout worker), header-name drift fixed in `quickstart.md` (3 occurrences of `Idempotency-Token` header corrected to `Idempotency-Key`), and this wave-status rewritten as the Wave 1 final closeout document.

Known deferred items carried into Wave 2 staging: T550/T551 (idempotency-mismatch-audit), T552-mismatch-case harness bug (`005-WAVE1-METRICS-MISMATCH-FOLLOWUP` proposed slice), and auth-guard wiring on the 6 unknown-items controller routes.

**Wave 2 tasks authored (2026-05-24)** — T600–T670 in `tasks.md`; 9 `005-WAVE2-*` slices in `execution-map.yaml`. Gated by `[GATED]` approval for `005-WAVE2-CONTRACT` (T600/T601).

**Wave 2 is COMPLETE pending this POLISH merge (2026-05-27).** Eight of nine `005-WAVE2-*` slices are merged on `main`: CONTRACT (gated), CONFLICT floor, LINK-HAPPY + LINK-EDGES, CREATE-HAPPY + CREATE-EDGES, AUDIT, and METRICS (with a gated allowlist precursor). POLISH (this slice) is the ninth and final — it lands with this PR. The reconciliation surface — `ReconciliationService` + `ReconciliationController` with link and create-product routes — is on `main`. Conflict rejections emit the `unknown_item.reconciliation_conflict_rejected` audit subject and increment `catalog_duplicate_alias_conflict_total` (FR-043); successful resolutions increment `unknown_item_resolved_total{action}`; all writes are transactional (SC-007 verified by `atomicity.spec.ts`). Two coverage-gate follow-ups (#369, #373) and one FR-040 fixture fix (#366) were required along the way.

**Forward link:** [`specs/006-unknown-items-review-queue/`](../006-unknown-items-review-queue/) — 006 is the docs-only product brief for the future Unknown Items Review Queue feature. It cites 005's reconciliation surface (link / create-product / conflict audit + metrics) as its API substrate. Informational only; no operational dependency between 005 and 006.

---

## Merged on `main`

### Wave 1 implementation slices

| Slice | Subject | Reference |
|---|---|---|
| `005-WAVE1-METRICS-ALLOWLIST` | Schema-only allowlist extension for 3 catalog counters (`unknown_item_captured_total`, `unknown_item_resolved_total{action}`, `idempotency_token_mismatch_total`); resolved `005-METRICS-ALLOWLIST-PRECONDITION` finding | PR #299 @ `28d1a0d` |
| `005-WAVE1-SETUP` | T500 module skeleton + T501 counter registration in `api.metrics.ts`; introduced `CATALOG_METRIC_NAMES` sibling registry | PR #304 @ `622e509` |
| `005-WAVE1-IDEMP-VERIFY` | T505 — verification spec proving existing `IdempotencyInterceptor` covers FR-021/021a/021b/021c against a fake POS-principal context | PR #306 @ `4c16451` |
| `005-WAVE1-HARNESS` | T506 `seed-unknown-items.ts` fixture + T507 cross-tenant RED suite (`cross-tenant.spec.ts`) | PR #307 @ `e7c41b0` |
| `005-WAVE1-CONTRACT` | T503 + T504 — OpenAPI YAML + contract conformance spec; Wave 1 operationIds (`posCaptureItem`, `tenantAdminListUnknownItems`, `tenantAdminDismissUnknownItem`) | PR #315 @ `6cb4a1b` |
| `005-WAVE1-CAPTURE-HAPPY` | T510 + T511 + T512 — US1 first end-to-end capture path: `UnknownItemsService.capture()` + controller + happy-path spec | PR #317 @ `5fc8549` |
| `005-WAVE1-CAPTURE-RESOLVE` | T513 + T514 — Alias-resolution prelude (FR-022/030/031): resolve known alias to `tenant_products` row, return `kind: "resolved"` + 200 | PR #321 @ `f5e4a19` |
| `005-WAVE1-IDEMP-STATUS-CAPTURE` | T539a + T539b — IdempotencyInterceptor status-preservation fix (line 274 hard-coded 201 → reads actual statusCode); resolves `005-IDEMP-STATUS-CAPTURE-DEFECT` finding | PR #324 @ `0c3638d` |
| `005-WAVE1-CAPTURE-STORE-SCOPE` | T515 + T516 — FR-030a store-scope respect at alias lookup: tenant-wide aliases resolve everywhere, store-scoped aliases resolve only at the bound store | PR #326 @ `9cae6b5` |
| `005-WAVE1-CAPTURE-DEDUP` | T517 + T518 — FR-032 natural dedup via `idx_unknown_items_lookup_value` index: duplicate pending rows de-duplicated at capture | PR #328 @ `d398513` |
| `005-WAVE1-VALIDATION` | T519 + T520 — FR-070/071/072 Zod boundary validation; extracts schema into `dto/capture-request.dto.ts`, adds bidirectional `source_system_required` rule | PR #331 @ `290cbaa` |
| `005-WAVE1-NON-DISCLOSING` | T521 + T522 — SI-001/SI-004/FR-013/FR-092 cross-tenant non-disclosing posture; `findByIdForTenant` inside `runWithTenantContext`; zero rows → 404 | PR #332 @ `c151aeb` |
| `005-WAVE1-LIST` | T523 + T524 — FR-014 tenant-admin queue read endpoint; `listForTenant` + `@Get("api/v1/catalog/unknown-items")`; controller-prefix refactor | PR #334 @ `bdb582e` |
| `005-WAVE1-IDEMP-WIRE` | T530 + T531 — FR-021 retry-identical at N=5 against the real `posCaptureItem` route | PR #336 @ `d57efc6` |
| `005-WAVE1-IDEMP-MISMATCH` | T532 + T533 — FR-021c `IdempotencyMismatchFilter`; catches 001 interceptor's `ConflictException`, fires mismatch counter + audit subject, re-throws | PR #339 @ `0eef243` |
| `005-WAVE1-DISMISS` | T540–T543 — FR-002/003/004 monotonic lifecycle; `dismissUnknownItem` with UPDATE-first + conditional-SELECT pattern; `@Post(".../dismiss")` with `@HttpCode(200)` | PR #341 @ `1ff755f` |
| `005-WAVE1-DISMISS-CARVEOUT-FIX` | Hotfix: 3-line `?? ""` → `?? "*"` at `listForTenant`, `dismissUnknownItem`, `findByIdForTenant` after migration 0011 changed tenant-wide carve-out sentinel; resolves `005-DISMISS-SENTINEL-REGRESSION` finding | PR #346 @ `08ab044` |
| `005-WAVE1-FR005` | T544/T545 — FR-005 dismissed-then-resubmit invariant; tightened capture query to filter `resolution_status = 'pending'` | PR #343 @ `83eb810` |
| `005-WAVE1-AUDIT` (partial) | T546–T549 shipped: `capture-audit.spec.ts` + `dismiss-audit.spec.ts` verifying FR-080/082 audit emission; **T550/T551 deferred** (idempotency-mismatch-audit) | PR #344 @ `0a7cb10` |
| `005-WAVE1-IDEMP-EDGES` | T534–T536 — FR-021a (per-device key scoping), FR-021b (24h TTL expiry), FR-022 (post-resolved idempotency); three disjoint test-only specs | PR #345 @ `043c1c2` |
| `005-WAVE1-METRICS` (partial) | T553 shipped: `metrics.spec.ts` + `idempotency-mismatch.filter.unit.spec.ts` verifying FR-081 counters; **T552-mismatch-case deferred** (harness bug, `describe.skip`) | PR #349 @ `3e915b7` |
| `005-WAVE1-POLISH` | T560 perf smoke test (SC-008, soft-skip gate) + T561–T563 regression sweeps confirmed GREEN + T564 closeout doc + header-name drift fix (3 `Idempotency-Token` → `Idempotency-Key` in `quickstart.md`) | PR #351 @ `bb98ff4` |

### Wave 2 implementation slices

| Slice | Summary | Reference |
|---|---|---|
| `005-WAVE2-CONTRACT` (gated) | T600/T601 — OpenAPI link + create-product operations (`tenantAdminLinkUnknownItem`, `tenantAdminCreateProductFromUnknownItem`) + conformance | PR #353 @ `2b8b851` |
| `005-WAVE2-CONFLICT` | T610/T611 — US3 alias-conflict safety floor RED suite (FR-040–FR-043) | PR #354 @ `0724361` |
| `005-WAVE2-LINK-HAPPY` | T620–T622 — `ReconciliationService` + `ReconciliationController` + module; link route happy path (FR-050–FR-053) | PR #355 @ `f923fda` (+ CodeRabbit follow-up #357 @ `cf55ef4`) |
| `005-WAVE2-LINK-EDGES` | T623–T626 — target-unavailable (FR-051) + already-reconciled (FR-004) link rejections | PR #359 @ `9d72ef3` |
| `005-WAVE2-CREATE-HAPPY` | T630–T632 — create-new product from unknown item (FR-060–FR-063) | PR #364 @ `22dee63` (+ follow-up #365 @ `5a05b79`) |
| `005-WAVE2-CREATE-EDGES` | T633–T636 — create-path alias-conflict + body validation + §III non-trust; `create-product-request.dto.ts` | PR #367 @ `8700d2c` |
| `005-WAVE2-AUDIT` | T640–T645 — `unknown_item.resolved.{linked,created}` + `reconciliation_conflict_rejected` audit subjects (FR-080/082); explicit post-transaction emit | PR #368 @ `2e6959e` (+ coverage follow-up #369 @ `b918c6d`) |
| `005-WAVE2-METRICS-ALLOWLIST` (gated) | Precursor: register `catalog_duplicate_alias_conflict_total` (unlabeled) in `ALLOWED_METRIC_LABELS` + signals.md §1.1 + cardinality drift contract | PR #371 @ `69bd873` |
| `005-WAVE2-METRICS` | T650/T651 — wire `catalog_duplicate_alias_conflict_total` at both conflict catch sites (FR-043) + resolved-counter verification spec | PR #372 @ `2b25656` (+ create-path coverage follow-up #373 @ `5565c32`) |
| `005-WAVE2-POLISH` | T660/T661 regression sweeps (Wave 1 + 003 isolation GREEN) + T662 SC-007 `atomicity.spec.ts` (FR-053/FR-063 fault injection) + T670 closeout | _this slice_ |

**Wave 2 fixups along the way:** #356 (conflict request-body snake_case), #362 (execution-map validation-typo), #363 (RLS-test-audit), #366 (FR-040 store-partition fixture fix), #361/#358 (link-edges/link-happy closeouts).

### Planning artifacts merged

| Stage | Subject | Reference |
|---|---|---|
| Spec | POS Catalog Sync & Unknown Item Reconciliation — 5 user stories, 40 FRs, 7 SI requirements, 8 SCs, 12 edge cases | PR #293 @ `9d835eb` |
| Plan + research + data-model + quickstart + contracts placeholder | Constitution check 14/14. Architecture Impact: High. | PR #294 @ `6895246` |
| Wave 1 `tasks.md` | 48 tasks across 19 candidate slices | PR #296 @ `5179682` |
| `execution-map.yaml` + `wave-status.md` (initial) | Slice DAG, allowed/forbidden files, validation contracts | PR #298 @ `dd38594` |

---

## Wave 1 architecture decisions

### Capture path

- **Route**: `POST /api/pos/v1/catalog/unknown-items` — POS-facing. Controller prefix refactored to method-level paths (PR #334) so dashboard-facing routes (`/api/v1/...`) can coexist.
- **Service**: `UnknownItemsService.captureItem()` runs inside `runWithTenantContext(tenantId, storeId, ...)` which sets `app.current_tenant` and `app.current_store` GUCs before any DB query. RLS enforces isolation; the service adds no application-level tenant predicate.
- **Alias resolution**: alias lookup via `idx_product_aliases_lookup` on `(tenant_id, identifier_type, value) WHERE retired_at IS NULL`. On hit → `kind: "resolved"` + 200. On miss → `unknown_items` INSERT → `kind: "captured"` + 201.
- **Natural dedup**: `idx_unknown_items_lookup_value` partial unique index on pending rows; duplicate capture returns the existing row (FR-032).
- **Dismiss lifecycle**: `dismissUnknownItem()` uses UPDATE-first (`WHERE id=$1 AND resolution_status='pending'` — monotonicity guard) + conditional SELECT on `rowCount=0` to distinguish 404 from 409. Race-safe per US3 #3.
- **FR-005**: Capture query filters `resolution_status = 'pending'` so a dismissed-then-resubmitted item creates a fresh pending row (PR #343).
- **Store-scope carve-out**: `app.current_store = '*'` is the tenant-wide sentinel introduced in 003 migration 0011 (PR #295). Tenant-wide actors pass `'*'`; store-scoped actors pass their `store_id`. Empty string `''` is now fail-closed.

### Idempotency contract

- **Header**: `Idempotency-Key` (lowercased per RFC on the wire; spec/quickstart now aligned post-POLISH drift fix).
- **TTL**: 24h (72h actual default in `IdempotencyKeyStore` constructor — the 24h window is the user-facing contract; the store uses 72h for drift tolerance).
- **Dedup tuple**: `(tenant_id, store_id, client_id, idempotency_key)` — enforced by `IdempotencyInterceptor` in `packages/shared/src/idempotency/`.
- **Mismatch**: Same key + different payload → 409 `idempotency_key_conflict` from `IdempotencyInterceptor`'s collision branch. The interceptor fires `recordIdempotencyTokenMismatch()` counter + enqueues the `unknown_item.idempotency_mismatch_rejected` audit subject INLINE on that branch (route-scoped to the `posCaptureItem` capture path; fire-and-forget so audit failure can't replace the deterministic 409), then throws. (Re-homed from the deleted `IdempotencyMismatchFilter` by `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` PR 2.)
- **Status preservation fix**: interceptor line 274 now reads `response.statusCode` via `ExecutionContext` instead of hard-coding 201 — ensures non-201 responses replay correctly (PR #324).

### Audit subjects

Three Wave 1 audit subjects emitted via `@Auditable` decorator + `AuditEmitterInterceptor`:
- `unknown_item.captured` — on successful INSERT into `unknown_items`
- `unknown_item.dismissed` — on successful dismiss transition
- `unknown_item.idempotency_mismatch_rejected` — on mismatch 409 (best-effort, wrapped in try/catch so transient audit failure cannot replace deterministic 409 with 500)

T550/T551 (CLOSED — `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` PR 3, 2026-05-29): `unknown_item.idempotency_mismatch_rejected` integration audit spec landed at `apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts`. T550 asserts the audit subject + payload (tenant/store/user) on the live mismatch path; T551 covers the FR-021c determinism guarantee — a **rejecting** audit enqueuer still yields a deterministic 409 (the interceptor's fire-and-forget `.catch()` swallows the failure). PR 2 re-homed the emission from the (now-deleted) `IdempotencyMismatchFilter` into `IdempotencyInterceptor`'s collision branch (inline, route-scoped to the capture path); the harness that previously blocked this is resolved. Branch coverage for the collision side-effects also exists in `apps/api/test/idempotency/catalog-collision.spec.ts` (PR 2).

### Metrics signals

Three counters registered in `api.metrics.ts`, allowlisted in `packages/shared/src/observability/metrics-labels.ts` (PR #299):
- `unknown_item_captured_total{tenant_bucket}` — incremented on each successful capture INSERT
- `unknown_item_resolved_total{action="dismissed"}` — incremented on successful dismiss (PR #349 T553)
- `idempotency_token_mismatch_total` — incremented in `IdempotencyMismatchFilter.catch`

### RLS carve-out (sentinel `*`)

003 migration 0011 (PR #295) changed the tenant-wide read carve-out sentinel from `''` to `'*'`. All three `app.current_store` call sites in `unknown-items.service.ts` were updated in the DISMISS-CARVEOUT-FIX hotfix (PR #346). The empty string `''` is now explicitly fail-closed in three RLS policies on `unknown_items` and `store_product_overrides`.

---

## Outstanding known gaps (deferred)

| Item | Deferred from | Status |
|---|---|---|
| **T550/T551 + T552 + T532** — integration coverage for the mismatch path | AUDIT PR #344, METRICS PR #349, IDEMP-MISMATCH PR #339 | **CLOSED** via `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` (PR #386 diagnostics → PR #389 architectural pivot + T532 GREEN → PR 3 unskip T552-mismatch + author T550/T551 audit spec). Emission re-homed from the deleted `IdempotencyMismatchFilter` into `IdempotencyInterceptor`'s collision branch (inline, route-scoped). See **Slice brief** below for the full investigation trail. |
| **Auth-guard wiring** — 6 unguarded routes on `UnknownItemsController` | CAPTURE-HAPPY PR #317 (and 5 subsequent PRs) | Deferred-with-rationale: `apps/api/src/auth/**` is forbidden surface for 005. A follow-up "auth-wiring" slice must address all 6 routes consistently (POS routes use bearer tokens; admin routes use session cookies). Requires `[GATED]` approval per Standing Rules §3. CodeRabbit flagged this on PR #334 (twice); deferral documented here as the canonical record. |
| **Header-name concept alignment** — `idempotency-token-mismatch` in `spec.md` FR-091 and Assumptions | n/a | Intentionally left as-is: `idempotency-token-mismatch` is a failure *category* name, not an HTTP header. Changing it to `idempotency-key-mismatch` would create new drift with the existing metric name `idempotency_token_mismatch_total` (PR #299 allowlist) and the audit subject `unknown_item.idempotency_mismatch_rejected`. These concept names reflect the metric name as the stable anchor. |
| **T560 perf-budget threshold brittleness** — SC-008 `p95 <= 500ms` assertion in `capture-latency.spec.ts` | POLISH PR #351 | **Observed flake on 2026-05-28**: same-SHA back-to-back CI runs on `main` produced p95 = **760ms (FAIL)** then p95 = **446ms (PASS)** — a 1.7× spread on identical code, from GitHub-hosted runner variance against the 50k-product / 100k-alias full-scale fixture. Headroom on the passing run was **10.8%** (446 vs 500). The spec's `dockerSkipped` gate (line 440-448) only handles the Windows-host-no-Docker case; there is **no runner-variance escape hatch** in CI. Expected recurrence: ~5–15% of runs. Recommended fix: widen `p95` threshold to ~750ms OR add a 5-call warmup-discard before percentile computation. Tracking as a low-priority follow-up; **not** in scope for `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` (different test category — perf-budget assertion vs. mismatch-path harness wiring). |

---

## Slice brief — `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`

**Investigation date:** 2026-05-28 (this session). Brief authored to give the next session a clean entry point — primary-source findings, corrected framing, narrowed hypothesis, suggested first PR shape.

### Correction to the existing `retry-mismatch.spec.ts:334-357` skip-block framing

The skip-block comment says PR #349's fix attempts (`30ca9e0`, `951ee84`) "failed with byte-identical CI output." Git history says something more specific:

- **`30ca9e0`** changed the interceptor's collision branch from sync `throw new ConflictException(...)` to `return throwError(() => new ConflictException(...))` ("Shape A"). This was reverted by `b8a9dd4`.
- **`951ee84`** registered `IdempotencyMismatchFilter` globally before `GlobalExceptionFilter` in both `retry-mismatch.spec.ts` and `metrics.spec.ts`. This was reverted by `b8a9dd4`.
- **`b8a9dd4`** is the revert commit. Its body says *"the binding was not the issue"* — phrased as "we don't know what is." The skip-block was authored after the reverts and overstated the conclusion as *"the harness pattern is wrong."* That framing misled a subsequent investigation; the actual b8a9dd4 evidence is *"incomplete diagnosis; deferred to follow-up."*

Current state on `main`: the interceptor uses sync `throw new ConflictException(...)` inside `from(asyncFn()).pipe(switchMap(...))` (the original PR #339 shape). Production has shipped real 409s under this pattern without operator reports. The mismatch *condition* (same `Idempotency-Key` + different body) is rare; the absence of operator reports is weak evidence either way — treat as "not yet observed to fail in prod," not "verified working in prod."

### Working comparator — `apps/api/test/idempotency/conflict.spec.ts` (001)

001's idempotency test suite contains a successfully-running integration spec of the *same throw pattern*:

- `Test.createTestingModule({ controllers: [InvitationsController], providers: [...] })` — the same hand-built shape `retry-mismatch.spec.ts` uses (NOT `imports: [AppModule]`)
- `{ provide: APP_INTERCEPTOR, useValue: interceptor }` — same DI binding
- `app.useGlobalFilters(new GlobalExceptionFilter())` — same filter setup at `app.init()`
- Asserts `409 idempotency_key_conflict` via Supertest end-to-end (T511, lines 147-190)

001's spec passes CI today. So the `TestingModule + APP_INTERCEPTOR + sync throw` shape itself is **not** broken — contrary to the skip-block's framing.

### Narrowed hypothesis (single, falsifiable)

The two structural differences between 001's working spec and 005's failing spec, in order of suspicion:

1. **`@UseFilters(IdempotencyMismatchFilter)` method-level binding on `UnknownItemsController.posCaptureItem`** — 001 has *no* `@UseFilters` decorator; only `GlobalExceptionFilter` runs. NestJS resolves filters in a specific order, and method-level filters wrapping an `APP_INTERCEPTOR`-thrown exception may diverge from production wiring in ways `951ee84` *tried* to compensate for. The revert was not based on diagnosing this — `b8a9dd4` admits "the binding was not the issue" without evidence.

2. **`useGlobalGuards(contextGuard)` after `useGlobalFilters(...)`** — 001 uses `Pass*Guard` instances via `.overrideGuard(...).useValue(...)`; 005's spec adds a separate `useGlobalGuards(contextGuard)` call. The order/precedence of guard execution vs. interceptor exception propagation may differ from production.

**Test minimally per systematic-debugging Phase 3:** start by porting *only* 001's guard pattern (drop the global `ConfigurableContextGuard`; use `.overrideGuard().useValue(...)` per 001) and keep `@UseFilters` as-is. If the spec turns GREEN, hypothesis 2 is correct in isolation. If still RED, try removing `@UseFilters` next — if that turns it GREEN, hypothesis 1.

### Suggested first PR shape

**PR 1 — harness diagnostic:** add structured console logging at five boundary points in `retry-mismatch.spec.ts` (interceptor pre-throw, interceptor post-throw, filter `catch()` entry, `GlobalExceptionFilter.catch()` entry, supertest response receipt). Unskip the test, push, let CI run. Read the failure signature *with evidence* this time, not guesses. Local Docker is unavailable on the Windows host — CI is the only feedback loop, so structured logging is non-optional.

**PR 2 — fix per hypothesis:** based on PR 1's evidence, apply the minimal-change fix to the harness. Most-likely candidates ranked by 001-comparator structure:
- (a) port 001's guard pattern (single-variable change vs. current 005 spec)
- (b) remove `@UseFilters` method binding and register filter globally per `951ee84`'s original intent
- (c) only if (a) and (b) both fail: refactor to `Test.createTestingModule({ imports: [AppModule] })` — biggest change, but matches production exactly

**PR 3 — unskip + T550 author (DONE 2026-05-29):** T532's case went GREEN in PR #389, so PR 3 unskipped the T552-mismatch-case in `metrics.spec.ts` (the harness there already carries the PR-2 inline-interceptor wiring) and authored `idempotency-mismatch-audit.spec.ts` (T550 audit subject + T551 FR-021c determinism under a rejecting enqueuer). All three close together.

**Scope estimate:** 2 PRs likely (PR 1 + PR 2-or-PR 3); 3 PRs if (c) is needed.

### Files the FOLLOWUP slice will touch

Per `execution-map.yaml` `allowed_files`:
- `apps/api/test/catalog/unknown-items/audit/metrics.spec.ts` (T552 unskip)
- `apps/api/test/catalog/unknown-items/audit/idempotency-mismatch-audit.spec.ts` (T550 new)
- `apps/api/test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts` (T532 unskip)
- `apps/api/src/idempotency/idempotency.interceptor.ts` (only if hypothesis requires interceptor change — likely NOT)
- `apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts` (only if hypothesis requires filter change — likely NOT)

### What NOT to do

- Do **not** restart the harness investigation from scratch — primary-source evidence above stands.
- Do **not** trust the skip-block comment's "the harness pattern is wrong" framing as diagnostic; treat 001's `conflict.spec.ts` as the working-pattern comparator.
- Do **not** attempt PR 2 before PR 1 produces logged evidence — PR #349's two reverted attempts already demonstrate that "try another fix shape" without diagnostic data is rework.

### Investigation update — 2026-05-28 (PR #386 CI evidence)

**PR #386** (commit `1e759b9`) instrumented 4 of 5 boundary points and unskipped T532. CI run `26593824760` failed as expected, but the boundary logs **refute both hypotheses 1 and 2 of this brief**. Primary-source evidence from the CI logs:

| Boundary | Fired? | Timestamp | Source |
|---|---|---|---|
| B5 — supertest pre-call | ✅ | `1779992669942` | `retry-mismatch.spec.ts:426` |
| B1 — interceptor pre-throw | ✅ | `1779992669959` (+17ms) | `idempotency.interceptor.ts:259` |
| B2 — interceptor outer catch | ✅ | `1779992669970` (+11ms) | `idempotency.interceptor.ts:313` |
| B3 — filter `catch()` entry | ✅ | `1779992669972` (+2ms) | `idempotency-mismatch.filter.ts:127` |
| B5 — supertest post-call | ❌ never fired | — | timeout at 30s |

All four instrumented boundaries fire **in order, within 30 milliseconds** of the second supertest call. The test then sits idle for 30 seconds and times out at the `await http().post(...)` call. The `ConflictException` reaches the `IdempotencyMismatchFilter.catch()` method without issue — but the response never reaches supertest.

**What this refutes:**

- ❌ PR #349's skip-block framing ("ConflictException escapes Jest before any filter side-effect can run") — falsified. The filter side-effects (B3 log, counter increment, audit enqueue) all execute.
- ❌ Hypothesis 1 ("`@UseFilters(IdempotencyMismatchFilter)` method-level binding is the issue") — falsified. The filter is *receiving* the exception; the binding works.
- ❌ Hypothesis 2 ("`useGlobalGuards(contextGuard)` ordering") — falsified. Guards run before interceptors; if guards were the issue, B1 would never have fired.

**Narrowed hypothesis (PR 2):**

The failure is **post-B3, pre-B5-post-call** — i.e., between the filter's `catch()` entry and supertest's response receipt. Three sub-hypotheses to discriminate:

3a. **Filter re-throw doesn't propagate to `GlobalExceptionFilter`** — NestJS may not chain an async filter's re-throw to the next filter in the pipeline reliably when the catch is `Promise<void>`. (Most likely structural explanation; see `idempotency-mismatch.filter.ts:191`.)
3b. **`GlobalExceptionFilter` receives the exception but `response.json()` hangs** — exotic; would point to Express/Supertest interaction.
3c. **`response.headersSent` is somehow true** — `GlobalExceptionFilter.catch():101` early-returns when headers are already sent. If something committed the response before the exception path, this short-circuits without writing the envelope. The mismatch branch doesn't write to the response, so this shouldn't trigger — but worth logging.

**PR 2 scope (revised):**

Add two new boundary points and run one CI cycle to discriminate 3a/3b/3c:

- **B3.5** — `idempotency-mismatch.filter.ts:191` — log immediately before `throw exception;`. Confirms enqueue completed and the re-throw is being attempted. In scope (filter is in `allowed_files`).
- **B4** — `common/exception.filter.ts:93` — log at `GlobalExceptionFilter.catch()` entry, including `response.headersSent` value. Confirms whether the global filter ever receives the exception. **`common/exception.filter.ts` is NOT in this slice's `allowed_files` — PR 2 requires a `[GATED]` allowed_files expansion to add it.**

**Discriminator matrix for PR 2's CI output:**

| B3.5 fires? | B4 fires? | `response.headersSent` at B4 | Diagnosis |
|---|---|---|---|
| ❌ | — | — | Filter `catch` hangs internally between B3 and the throw (unexpected; investigate enqueue or audit path) |
| ✅ | ❌ | — | **3a confirmed** — NestJS filter chain doesn't propagate the async re-throw. Fix: change filter to non-async, OR call `super.catch(exception, host)` pattern, OR refactor to side-effects-via-interceptor-tap pattern. |
| ✅ | ✅ | `true` | **3c confirmed** — investigate what wrote to the response prior to the exception. Fix: identify and remove the premature write. |
| ✅ | ✅ | `false` | **3b confirmed** — `response.json()` hangs. Fix: investigate Express/Supertest interaction (potential Express-version mismatch or middleware that buffers). |

**Refuted, do NOT attempt in PR 2:**

- Porting 001's `.overrideGuard(...).useValue(...)` pattern (hypothesis 2's fix) — the guards are not the issue.
- Removing the `@UseFilters` method-level binding (hypothesis 1's fix) — the filter IS firing.
- Refactoring to `Test.createTestingModule({ imports: [AppModule] })` — premature; we don't yet have evidence that the harness shape matters.

PR 2's job is to add 2 logs and read CI output. PR 3 applies the fix based on which sub-hypothesis the discriminator matrix selects.

---

## Resolved findings (audit trail)

### `005-METRICS-ALLOWLIST-PRECONDITION` (high) — resolved

**Summary**: T501 could not register 3 catalog counters without editing the closed `ALLOWED_METRIC_LABELS` allowlist in `packages/shared` — outside 005's `allowed_files`. Resolution: new `[GATED]` prerequisite slice `005-WAVE1-METRICS-ALLOWLIST` touching only the 004-owned schema files.

**Audit fields**:
- `resolved_by_pr`: 299
- `resolved_at_commit`: `28d1a0d72725ffa93272dd2a2e9b912b11380cc4`
- `resolved_at`: 2026-05-23

### `005-IDEMP-STATUS-CAPTURE-DEFECT` (medium) — resolved

**Summary**: `IdempotencyInterceptor` line 274 hard-coded `HttpStatus.CREATED` (201) in the replay path. Resolved-to-alias captures (which return 200) would replay with wrong status. Fix: read `response.statusCode` via `ExecutionContext`. Includes regression test in `replay.spec.ts`.

**Audit fields**:
- `discovered_at`: 2026-05-25
- `resolved_by_pr`: 324
- `resolved_at_commit`: `0c3638d0bcaa409cae13c2a9b7ca1e0da72c17a3`
- `resolved_at`: 2026-05-25

### `005-DISMISS-SENTINEL-REGRESSION` (high) — resolved

**Summary**: Cross-spec coordination bug. 003 migration 0011 (PR #295, 2026-05-24) changed `app.current_store` tenant-wide carve-out sentinel from `''` to `'*'` and made `''` fail-closed. Three call sites in `unknown-items.service.ts` still passed `?? ""`. All PRs #343/#344/#345 failed db-integration CI. Fix: 3-line literal replacement in `005-WAVE1-DISMISS-CARVEOUT-FIX` (PR #346).

**Meta-lesson**: Migrations that change GUC sentinel values need an active-consumer sweep before merge. Docker-soft-skip (`MIGRATION_TEST_ALLOW_SKIP=1`) can let cross-spec sentinel changes land silently; CI on the next affected slice is the catch point.

**Audit fields**:
- `discovered_at`: 2026-05-26
- `resolved_by_pr`: 346
- `resolved_at_commit`: `08ab0445ff02fcae1430f99e21c7b1d8828f7af4`
- `resolved_at`: 2026-05-26

---

## What's pending for Wave 2

Wave 2 covers the reconciliation path: tenant admin links an unknown item to an existing tenant product (US2 #1, FR-050–FR-053), creates a new tenant product from an unknown item (US2 #2, FR-060–FR-063), and alias-conflict fail-closed (US3, FR-040–FR-043).

**Dependency cleared 2026-05-23/24**:
- T350 + T351 → `TenantCatalogService.create` on `main` via PR #300 @ `2bf7e27`.
- T383 + T384 → `ProductAliasesService.create` on `main` via PR #303 @ `454a7ae`.
- T336 → `MISSING_WITHSTORE_HELPER` resolved via PR #310 @ `main` (path b).

**Wave 2 tasks authored 2026-05-24**: T600–T670 appended to `tasks.md` (9 candidate slices in `execution-map.yaml`).

**Gating bottleneck**: `005-WAVE2-CONTRACT` (T600/T601) requires `[GATED]` approval before any Wave 2 implementation slice can dispatch. Once approved + merged, the DAG unblocks: `005-WAVE2-CONFLICT` → `005-WAVE2-LINK-HAPPY` + `005-WAVE2-CREATE-HAPPY` (parallel-safe) → edge-case + audit + metrics slices → `005-WAVE2-POLISH`.

| Wave 2 slice | Tasks | Approval |
|---|---|---|
| `005-WAVE2-CONTRACT` | T600, T601 | **`[GATED]`** — extends `packages/contracts/openapi/catalog/unknown-items.yaml` |
| `005-WAVE2-CONFLICT` | T610, T611 | none |
| `005-WAVE2-LINK-HAPPY` | T620, T621, T622 | none |
| `005-WAVE2-LINK-EDGES` | T623, T624, T625, T626 | none |
| `005-WAVE2-CREATE-HAPPY` | T630, T631, T632 | none |
| `005-WAVE2-CREATE-EDGES` | T633, T634, T635, T636 | none |
| `005-WAVE2-AUDIT` | T640–T645 | none |
| `005-WAVE2-METRICS` | T650, T651 | none |
| `005-WAVE2-POLISH` | T660, T661, T662, T670 | none |

---

## Post-merge closeout

When this PR's POLISH slice merges, run the closeout to mark `005-WAVE2-POLISH` as `merged` in `execution-map.yaml`.

Full workflow: [`docs/agent-os/maestro-playbook.md`](../../docs/agent-os/maestro-playbook.md) "Workflow — post-merge closeout".

Short prompt template:

```text
Use Agent OS.
Close out PR #<PR_NUMBER>.
Spec: specs/005-pos-catalog-sync-reconciliation
Expected slice: 005-WAVE2-POLISH
Update execution-map.yaml and wave-status.md.
Stop before commit.
```

---

## Next recommended action

**Wave 1 and Wave 2 are both COMPLETE** (Wave 2 closed out by this POLISH slice, 2026-05-27). The reconciliation surface — link + create-product routes, conflict audit + metrics, transactional integrity — is on `main`.

Carried-forward / deferred items (not blocking; tracked for a future wave):
1. `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` — **COMPLETE 2026-05-29**. Closed T550/T551 (audit integration spec), T552-mismatch-case (metrics integration unskip), and T532 (`retry-mismatch.spec.ts` unskip). Shipped over: PR #386 (boundary-point diagnostics) → PR #389 (architectural pivot — deleted `IdempotencyMismatchFilter`, inlined route-scoped catalog telemetry in `IdempotencyInterceptor`'s collision branch; T532 GREEN; +`catalog-collision.spec.ts` branch coverage) → PR 3 (unskip T552-mismatch in `metrics.spec.ts` + author `idempotency-mismatch-audit.spec.ts` for T550/T551). All four tasks closed.
2. Auth-guard wiring — **DONE 2026-05-28** via PRs #377 (tenant-admin routes) and #378 (POS capture route). All five reconciliation surface routes are now mounted in `app.module.ts` behind their appropriate guard chains. Listed here only as completed audit trail.

**Next primary action**: none required for 005. FOLLOWUP is the only remaining 005 work; it can be picked up when the harness investigation is prioritized. The reconciliation surface is production-ready.

---

## Wave 2 progress

### 2026-05-26 — LINK-HAPPY landed with cross-slice + RLS-quality fix-ups

**Slice state:** `005-WAVE2-LINK-HAPPY` complete. CONFLICT tests remain RED until LINK-EDGES ships — this is the documented expected-red per the slice contract, not the PR #339 antipattern (red is intended, named, slice-contract-anticipated).

**PRs merged (this closeout covers all three):**

- **#355** `feat/005-wave2-link-happy` — implemented `ReconciliationService.linkUnknownItem` (atomic alias INSERT + unknown_items UPDATE under `FOR UPDATE` lock, discriminated-union return), `ReconciliationController` (`POST /api/v1/catalog/unknown-items/:id/link`, `@HttpCode(200)`, `@Auditable("unknown_item.resolved.linked")`, Zod `product_id` UUID validation), `ReconciliationModule` (skeleton, NOT yet wired into `app.module.ts` — same gap as `UnknownItemsModule`), and `link-happy-path.spec.ts` (4 sub-cases + 1 it.todo for atomicity).
- **#356** `fix/005-wave2-conflict-request-body-snake-case` — addressed cross-slice latent between PR #354 (CONFLICT tests authored with camelCase `productId`) and PR #353 (OpenAPI YAML committed snake_case). 3-line literal substitution across `alias-conflict.spec.ts` and `store-scoped-conflict.spec.ts`. No logic change.
- **#357** `fix/005-wave2-link-happy-coderabbit-followup` — addressed CodeRabbit critical + major findings on PR #355:
  - Critical: `reconciliation.service.ts:230-233` impossible-state silent `return { kind: "already_reconciled" }` after a successful alias INSERT could commit inconsistent state. Converted to thrown invariant; aligns code with the L196-199 comment already documenting this branch as a logic error.
  - Major: `link-happy-path.spec.ts:182` was binding `PG_POOL` to `localEnv.admin` (superuser, bypasses RLS). Swapped to `localEnv.app` (non-superuser `app_test` role) so the controller/service path exercises RLS for real — per Standing Rules §6.

**Deferred / declined CodeRabbit findings on #355 (not addressed in #357, tracked here):**

- `@UseGuards(AuthGuard, TenantContextGuard, RolesGuard)` on the controller — deferred to a future module-wire slice. `ReconciliationModule` isn't yet imported by `app.module.ts`, so the route isn't actually serving traffic; guard wiring belongs in the slice that mounts the module.
- Zod schema at the service-layer boundary — declined. Controller already enforces Zod `product_id` UUID validation at the API boundary; per `validate-at-boundaries` convention, internal services trust their callers.

**Cross-cutting RLS-superuser audit (finding):**

A grep of the 005 catalog test suite found that **10 specs** bind `PG_POOL` to `localEnv.admin` (superuser, RLS-bypassed):

- Documented intentional admin use (1): `dismiss-audit.spec.ts:162-164` (explicit comment isolating audit assertion from orthogonal RLS plumbing concern).
- Undocumented admin use (9):
  - Plausibly orthogonal-concern (7): `capture-latency`, `metrics`, `capture-audit`, `cross-device-keys`, `ttl-expiry`, `retry-mismatch`, `retry-identical`, `post-resolved` — these assert audit/idempotency/perf mechanics where RLS is a side concern.
  - Warrant pool swap (2): `capture-happy-path.spec.ts:251`, `capture-resolves-to-alias.spec.ts:220` — exercise the data path where RLS should be exercised. Same false-green risk CodeRabbit flagged on LINK-HAPPY.

**Action:** A new slice `005-WAVE2-RLS-TEST-AUDIT` is added to `execution-map.yaml` to track (a) adding justification comments to the 7 orthogonal-concern admin-bound specs, and (b) swapping `localEnv.admin` -> `localEnv.app` on the 2 data-path specs with CI verification. Out of scope for LINK-HAPPY; not urgent (the specs have been on main without surfacing regressions); records the pattern so future slices apply it correctly.

**Next slice:** `005-WAVE2-LINK-EDGES` (T623–T626) — implements link-path edge cases that will flip CONFLICT tests fully green.

**Wave 1 deferred items still outstanding (separate tracking):**
- `005-WAVE1-METRICS-MISMATCH-FOLLOWUP`
- T550 / T551 audit-coverage gaps
- auth-guard wiring across Wave 1 controllers

### 2026-05-26 — LINK-EDGES landed + Wave 1 filter contract restoration

**Slice state:** `005-WAVE2-LINK-EDGES` complete. CONFLICT specs (T610/T611) now exercise the real `POST /api/v1/catalog/unknown-items/:id/link` route through the wired `ReconciliationController`, flipping them from RED to GREEN.

**PRs merged (this closeout covers all four):**

- **#359** `feat/005-wave2-link-edges` — implemented T623 (link-target-unavailable.spec.ts), T624 (service `retired_at` discriminator + new `target_unavailable` LinkResult variant), T625 (link-already-reconciled.spec.ts covering resolved + dismissed race paths), T626 (one-line race-safety verification comment at the `FOR UPDATE` site — no code change). Option A scope expansion authorized for one controller-mapping line.
- **#360** `fix/exception-filter-code-passthrough` — Wave 1 cross-cutting filter contract restoration. `GlobalExceptionFilter` was silently overwriting every `HttpException`'s `error.code` with the status-derived canonical code (`"conflict"` for all 409s), violating Constitution §IV (OpenAPI fine-grained codes are contract-of-record). 6-file PR: 1 filter fix + 1 new unit spec + 3 bug-codifying assertion corrections (idempotency-key-conflict path) + 1 stale-comment fix in `idempotency-mismatch.filter.ts`. One docblock at `existing-primitive-coverage.spec.ts:27-32` had explicitly documented the discard as "production behavior" — rewriting it to describe the corrected wire shape reverses that institutional drift.
- **#361** (this PR) — docs closeout + CodeRabbit nits + CONFLICT spec module wiring.

**Cross-cutting bug surface unblocked by #360:**

The filter fix unblocked latent contract violations across the API surface, not just LINK-EDGES:
- `idempotency.interceptor.ts:172/184/256` — now correctly surfaces `idempotency_key_required` / `idempotency_key_malformed` / `idempotency_key_conflict` on the wire.
- `unknown-items.service.ts:936` — Wave 1 LINK-HAPPY's `already_reconciled` code now reaches the envelope.
- `reconciliation.controller.ts:159/168/176` — all three Wave 2 fine-grained codes surface as contract specifies.

**LINK-EDGES landing latents (this PR resolves):**

- **CodeRabbit nit #1** (`reconciliation.service.ts:79-88`): method docblock said "active tenant product" but post-T624 the method handles retired products via the `target_unavailable` branch. Rewrote the summary + Step 3 prose.
- **CodeRabbit nit #2** (`reconciliation.controller.ts:185`): catch-all `NotFoundException` comment said the 404 "does not reveal whether the unknown item was absent vs. the product was absent/retired" — but retired now goes to 409. Removed the "or retired" phrasing.
- **CONFLICT spec module-wiring latent**: `alias-conflict.spec.ts` and `store-scoped-conflict.spec.ts` were authored when no `ReconciliationController` existed and hardcoded `controllers: [], providers: []` in their TestingModule. After LINK-HAPPY, LINK-EDGES, and the filter fix all landed, the CONFLICT specs were STILL RED — not because of any code in `src/`, but because their own TestingModule didn't mount the controller. Wired both specs to register `ReconciliationController` + `ReconciliationService` + `PG_POOL` (bound to `localEnv.app`, RLS-active per PR #357 audit) + `AuditEmitterInterceptor` + `SpyAuditEnqueuer`. After this PR merges, both CONFLICT specs should be GREEN against the actual reconciliation surface.

**Outstanding follow-ups (deferred, tracked):**

- `005-WAVE2-RLS-TEST-AUDIT` — still pending; 7 docs + 2 pool swaps across the 005 catalog test suite.
- `retry-mismatch.spec.ts:392-394` second-assertion latent — `error.details.code` checks against a field the IdempotencyInterceptor doesn't supply on the wire. Flagged by PR #360's agent; left for `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` harness refactor.

**Next slice:** `005-WAVE2-CREATE-HAPPY` (T630–T632) per the Wave 2 dependency graph. CREATE-EDGES, AUDIT, METRICS, POLISH follow.
