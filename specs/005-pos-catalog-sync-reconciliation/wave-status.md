# Wave Status — `005-pos-catalog-sync-reconciliation`

**Last updated:** 2026-05-23 (refreshed after PR #299 + #304 closeout — `005-WAVE1-METRICS-ALLOWLIST` and `005-WAVE1-SETUP` both merged)
**Spec:** [`specs/005-pos-catalog-sync-reconciliation/`](.)
**Base:** `origin/main` at `622e509` (PR #304, 2026-05-23 — `005-WAVE1-SETUP` merged)
**Active findings:** 0 (1 resolved — see "Resolved findings" below)
**Resolved findings:** 1

---

## TL;DR

**2 Wave 1 slices merged** (`005-WAVE1-METRICS-ALLOWLIST` via PR #299, `005-WAVE1-SETUP` via PR #304). **18 candidate slices remain at `status: proposed`.** Planning artifacts (spec, plan, research, data-model, quickstart, contracts placeholder, tasks.md, execution-map, wave-status) are all merged on `main`. The `005-METRICS-ALLOWLIST-PRECONDITION` finding is resolved (see "Resolved findings" below).

**Next moves:**

1. **Request `[GATED]` approval for `005-WAVE1-CONTRACT`** (T503 + T504, OpenAPI YAML). Once approved, this unblocks every Phase 3+ slice that needs an operationId. Bottleneck for Phase 3+.
2. **In parallel** (non-gated, file-disjoint pair, both `depends_on: 005-WAVE1-SETUP` which is now merged): dispatch `005-WAVE1-IDEMP-VERIFY` (T505) and `005-WAVE1-HARNESS` (T506 + T507).

**Wave 2** (reconciliation: link + create-new + alias-conflict) is **blocked on 003's `PHASE3_RED_WAVE`** — specifically T350 (`TenantCatalogService.create`) + T383 (`ProductAliasesService`). Wave 2's `tasks.md` will be generated *after* `PHASE3_RED_WAVE` merges to `main`; it is intentionally not enumerated here.

---

## Merged on `main`

### Wave 1 slices merged

| Stage | Subject | Reference |
|---|---|---|
| `005-WAVE1-METRICS-ALLOWLIST` (slice) | Schema-only allowlist extension for 3 catalog counters (`unknown_item_captured_total`, `unknown_item_resolved_total{action}`, `idempotency_token_mismatch_total`); resolved `005-METRICS-ALLOWLIST-PRECONDITION` finding | PR #299 @ `28d1a0d` |
| `005-WAVE1-SETUP` (slice) | T500 module skeleton (`apps/api/src/catalog/unknown-items/unknown-items.module.ts`) + T501 counter registration in `api.metrics.ts`; introduced `CATALOG_METRIC_NAMES` sibling registry | PR #304 @ `622e509` |

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

---

## Blocked

| Slice / wave | Blocked by | Resolution path |
|---|---|---|
| **Wave 2 entire** — US2 link reconciliation (FR-050–FR-053), US2 create-new reconciliation (FR-060–FR-063), US3 alias-conflict fail-closed (FR-040–FR-043) | 003's `PHASE3_RED_WAVE` — specifically T350 (`TenantCatalogService.create`) + T383 (`ProductAliasesService`). These are at `status: proposed` in [`specs/003-catalog-foundation/execution-map.yaml`](../003-catalog-foundation/execution-map.yaml) awaiting user endorsement. | (a) User endorses `PHASE3_RED_WAVE` on 003. (b) After T350 + T383 merge, run `/speckit-tasks` to author Wave 2's task set + extend this execution-map with Wave 2 slices. |

---

## Ready / in-flight

_None._

18 Wave 1 slices remain at `status: proposed`. None of the 18 remaining have been approved for dispatch.

---

## Proposed (awaiting approval / dispatch)

_Phase 0 (cross-spec prerequisite) and Phase 1 (setup) complete; see "Merged on `main`."_

### Phase 2 — Foundational

- **`005-WAVE1-CONTRACT`** (T503, T504) — OpenAPI YAML at `packages/contracts/openapi/catalog/unknown-items.yaml`. **`[GATED]`** — requires explicit per-slice approval per Standing Rules §3.
- **`005-WAVE1-IDEMP-VERIFY`** (T505) — verification spec proving the existing `IdempotencyInterceptor` covers FR-021/021a/021b/021c against a fake POS-principal context. Non-gated. `parallel_safety: safe`.
- **`005-WAVE1-HARNESS`** (T506, T507) — extends 003's isolation harness with `unknown_items` fixtures + cross-tenant RED test. Non-gated. `parallel_safety: safe`.

### Phase 3 — US1 Capture (P1 / MVP)

- **`005-WAVE1-CAPTURE-HAPPY`** (T510, T511, T512) — first end-to-end capture.
- **`005-WAVE1-CAPTURE-RESOLVE`** (T513, T514) — alias-resolution prelude (FR-022/030/031).
- **`005-WAVE1-CAPTURE-STORE-SCOPE`** (T515, T516) — FR-030a store-scope respect.
- **`005-WAVE1-CAPTURE-DEDUP`** (T517, T518) — FR-032 natural dedup.
- **`005-WAVE1-VALIDATION`** (T519, T520) — Zod boundary + redaction guard.
- **`005-WAVE1-NON-DISCLOSING`** (T521, T522) — SI-001/004/FR-013/092.
- **`005-WAVE1-LIST`** (T523, T524) — tenant-admin queue read endpoint.

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

### Proposed phase cohorts

> **These are phase cohorts for human readability, NOT flat-dispatchable waves.** Runtime dispatch MUST honor each member slice's `depends_on` DAG in [`execution-map.yaml`](./execution-map.yaml). `parallel_safety: safe` on a group reflects the schema's file/fixture disjointness contract — it does not mean members are dependency-flat. See the `groups:` block header in `execution-map.yaml` for the full semantics.

| Cohort | Members | Notes |
|---|---|---|
| `PHASE_0_1_2_COHORT` | METRICS-ALLOWLIST + SETUP + IDEMP-VERIFY + HARNESS | METRICS-ALLOWLIST merged in PR #299; SETUP merged in PR #304. Remaining members IDEMP-VERIFY + HARNESS are dispatchable in parallel (both `depends_on: 005-WAVE1-SETUP`, which is merged; disjoint test paths). Cohort id retained in `execution-map.yaml` for traceability. |
| `PHASE_3_COHORT` | 7 capture/list slices | Intra-cohort DAG: CAPTURE-HAPPY is the root; descendants depend on it. RED test authoring is parallel-safe across disjoint spec files; GREEN impls serialize through shared `unknown-items.service.ts` and `unknown-items.controller.ts`. |
| `PHASE_4_5_COHORT` | 7 idempotency/dismiss/audit/metrics slices | Intra-cohort DAG: IDEMP-WIRE `blocks` MISMATCH + EDGES; DISMISS `blocks` FR005 + AUDIT. RED tests where disjoint may dispatch in parallel; GREENs serialize through shared service/controller/filter files. |

See [`execution-map.yaml`](./execution-map.yaml) `groups:` section for full member lists, intra-cohort DAG notes, and the schema-anchored definition of what `parallel_safety: safe` means on a group.

---

## Wave 2 — not yet enumerated

Wave 2 covers the reconciliation path: tenant admin links an unknown item to an existing tenant product (US2 #1, FR-050–FR-053), creates a new tenant product from an unknown item (US2 #2, FR-060–FR-063), and alias-conflict fail-closed (US3, FR-040–FR-043).

**Blocked on 003's `PHASE3_RED_WAVE`** — specifically:
- T350 (`TenantCatalogService.create`) — needed by FR-060/FR-061 (create new tenant product from unknown item).
- T383 (`ProductAliasesService`) — needed by FR-040/FR-041/FR-050/FR-061 (every Wave 2 reconciliation action mutates `product_aliases` through this service).

Once `PHASE3_RED_WAVE` merges on 003 main, a separate `/speckit-tasks` invocation will author Wave 2's `tasks.md` and a follow-up commit will extend `execution-map.yaml` with the Wave 2 slices (expected ID range `T600–T6XX`, slice ids `005-WAVE2-*`).

**Do not propose Wave 2 slices ahead of this work.** The 003 service-layer contracts may evolve during `PHASE3_RED_WAVE` authoring, and any premature Wave 2 brief would risk dereferencing surfaces that haven't been frozen.

---

## Next recommended action

With `005-WAVE1-METRICS-ALLOWLIST` (PR #299) and `005-WAVE1-SETUP` (PR #304) both merged, two parallel tracks are now dispatchable:

1. **Request `[GATED]` approval for `005-WAVE1-CONTRACT`** (T503 + T504, OpenAPI YAML at `packages/contracts/openapi/catalog/unknown-items.yaml`). Once approved, this unblocks every Phase 3+ slice that needs an operationId. Bottleneck for Phase 3+.
2. **In parallel with the contract slice (if you want throughput)**: dispatch the non-gated, file-disjoint pair:
   - `005-WAVE1-IDEMP-VERIFY` (T505) — single new verification spec under `apps/api/test/catalog/unknown-items/idempotency/`.
   - `005-WAVE1-HARNESS` (T506 + T507) — two new files under `apps/api/test/catalog/__support__/` and `.../isolation/`.

Reusable Maestro prompts (short form):

```text
# Gated — request approval first:
Use Agent OS. Execute slice 005-WAVE1-CONTRACT. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation

# Non-gated parallel pair (both depends_on 005-WAVE1-SETUP, which is merged):
Use Agent OS. Execute slice 005-WAVE1-IDEMP-VERIFY. Stop before commit.
Spec: specs/005-pos-catalog-sync-reconciliation

Use Agent OS. Execute slice 005-WAVE1-HARNESS. Stop before commit.
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
