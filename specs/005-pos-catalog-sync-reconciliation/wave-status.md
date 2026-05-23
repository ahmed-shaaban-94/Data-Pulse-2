# Wave Status — `005-pos-catalog-sync-reconciliation`

**Last updated:** 2026-05-23 (initial authoring after Wave 1 `tasks.md` merged — PR #296 @ `5179682`)
**Spec:** [`specs/005-pos-catalog-sync-reconciliation/`](.)
**Base:** `origin/main` at `5179682` (PR #296, 2026-05-23)
**Active findings:** 0 — no implementation work has been dispatched yet
**Resolved findings:** 0

---

## TL;DR

All 48 Wave 1 tasks across 19 candidate slices are at `status: proposed`. **No implementation slice has been dispatched, approved, or merged.** Planning artifacts (spec, plan, research, data-model, quickstart, contracts placeholder, tasks.md) are all merged on `main`.

**Wave 1** (capture + idempotency + audit + dismiss) is **ready for dispatch starting with `005-WAVE1-SETUP`** (T500 + T501). The next gate after that is **`[GATED]` approval for `005-WAVE1-CONTRACT`** (T503 + T504, OpenAPI YAML).

**Wave 2** (reconciliation: link + create-new + alias-conflict) is **blocked on 003's `PHASE3_RED_WAVE`** — specifically T350 (`TenantCatalogService.create`) + T383 (`ProductAliasesService`). Wave 2's `tasks.md` will be generated *after* `PHASE3_RED_WAVE` merges to `main`; it is intentionally not enumerated here.

---

## Merged on `main`

_No implementation slices merged yet._

### Planning artifacts merged (for context)

| Stage | Subject | Reference |
|---|---|---|
| Spec | POS Catalog Sync & Unknown Item Reconciliation — 5 user stories, 40 FRs, 7 SI requirements, 8 SCs, 12 edge cases, 5 clarifications | PR #293 @ `9d835eb` |
| Plan + research + data-model + quickstart + contracts placeholder | Constitution check passes 14/14. Architecture Impact: High. 003 dependency readiness documented (data layer ✅; service layer ❌ — blocks Wave 2). | PR #294 @ `6895246` |
| Wave 1 `tasks.md` | 48 tasks across 19 candidate slices. TDD pairing (RED-then-GREEN). Two reviewer findings caught: idempotency wrapper was unnecessary (existing primitive covers FR-021/021a/021b/021c directly); audit-subjects registry doesn't exist (use `@Auditable` decorator at site). | PR #296 @ `5179682` |

---

## Local only — committed/uncommitted, not on `main`

_None._

---

## Active findings

_None._ No implementation work has been dispatched; no defects discovered. The two known issues (header-name drift `Idempotency-Token` → `Idempotency-Key` in spec.md and quickstart.md; PHASE3_RED_WAVE dependency for Wave 2) are documented in `plan.md §4` and `tasks.md §11.2` / `tasks.md §12` respectively — they are planning-time decisions, not findings.

---

## Blocked

| Slice / wave | Blocked by | Resolution path |
|---|---|---|
| **Wave 2 entire** — US2 link reconciliation (FR-050–FR-053), US2 create-new reconciliation (FR-060–FR-063), US3 alias-conflict fail-closed (FR-040–FR-043) | 003's `PHASE3_RED_WAVE` — specifically T350 (`TenantCatalogService.create`) + T383 (`ProductAliasesService`). These are at `status: proposed` in [`specs/003-catalog-foundation/execution-map.yaml`](../003-catalog-foundation/execution-map.yaml) awaiting user endorsement. | (a) User endorses `PHASE3_RED_WAVE` on 003. (b) After T350 + T383 merge, run `/speckit-tasks` to author Wave 2's task set + extend this execution-map with Wave 2 slices. |

---

## Ready / in-flight

_None._

All 19 Wave 1 slices are at `status: proposed`. None have been approved for dispatch.

---

## Proposed (awaiting approval / dispatch)

### Phase 1 — Setup

- **`005-WAVE1-SETUP`** (T500, T501) — module skeleton + 3 Prometheus counters. Non-gated. `parallel_safety: safe`. **Recommended first dispatch.**

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
| `PHASE_1_2_COHORT` | SETUP + IDEMP-VERIFY + HARNESS | Intra-cohort DAG: SETUP `blocks` the other two. After SETUP merges, IDEMP-VERIFY and HARNESS may dispatch in parallel worktrees (disjoint test paths). |
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

**Dispatch `005-WAVE1-SETUP`** (T500 + T501). Non-gated, low-risk, no test infrastructure required. Establishes the module skeleton at `apps/api/src/catalog/unknown-items/` and registers the three new Prometheus counters. After it merges, the natural next moves are:

1. **Request `[GATED]` approval for `005-WAVE1-CONTRACT`** (T503 + T504). Once approved, this unblocks every Phase 3+ slice that needs an operationId.
2. **In parallel with the contract slice (if you want throughput)**: dispatch `005-WAVE1-IDEMP-VERIFY` (T505) and `005-WAVE1-HARNESS` (T506 + T507). These are test-only, non-gated, file-disjoint from the contract slice.

Reusable Maestro prompt (short form):

```text
Use Agent OS. Execute slice 005-WAVE1-SETUP. Stop before commit.
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
