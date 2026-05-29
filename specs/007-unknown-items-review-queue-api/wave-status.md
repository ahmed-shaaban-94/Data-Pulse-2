# Wave Status — `007-unknown-items-review-queue-api`

**Last updated:** 2026-05-29 (SIGN-OFF decisions recorded; planning chain complete)
**Spec:** [`specs/007-unknown-items-review-queue-api/`](./)
**Base:** `origin/main` at `da032d2` (PR #398, 005 fully-closed marker, 2026-05-29)
**Branch:** `spec/007-unknown-items-review-queue-api`
**Active findings:** 0
**Resolved findings:** 0

---

## TL;DR

**007 is the dashboard-facing API feature that 006 deferred** (006 plan §9.1), now implementable since 005 Waves 1+2 shipped (contract + runtime on `main`). It **extends** the already-shipped 005 unknown-items surface rather than greenfielding: the genuine delta is **inspect (GET /{id})**, **reopen**, **bulk-dismiss**, **list-param extensions**, the **`forbidden`** 8th error category, and the **`ReviewQueueItem`** projection (omits `sale_context`).

**Planning chain complete on branch (not yet on `main`):**

- `aab701d` — spec + clarify + plan + Phase 0/1 artefacts
- `45ae621` — tasks.md (Phase 2 — 39 dependency-ordered slice tasks)
- `8a97e97` — analyze remediation (3 polish tasks T074–T076 + FR traceability refs → 42 tasks)

`/speckit-analyze` (2026-05-29) found **0 CRITICAL**, spec/plan/tasks consistent. Two `[SIGN-OFF]` decision gates were the only items blocking GREEN — **both are now recorded below.**

**Next operational moves before `/speckit-implement`:**

1. ✅ Both SIGN-OFF decisions recorded (this document, § SIGN-OFF Decisions).
2. ⏳ Request `[GATED]` approval for the T010 OpenAPI extension (`packages/contracts/openapi/catalog/unknown-items.yaml` — forbidden surface).
3. ⏳ Then dispatch the RED→GREEN pairs (GATED contract slice first).

---

## Dependency & parallel-safety graph

Derived from [`execution-map.yaml`](./execution-map.yaml) `depends_on` edges + `parallel_safety` fields (19 slices, all 43 tasks T001–T076). Edges flow **depends_on → dependent** (arrow points to the slice that waits). `[GATED]` = `007-CONTRACT` only; it is the serialization keystone that fans out to every Level-2 user-story slice.

```mermaid
flowchart TD
    %% ---- Level 0: no dependencies ----
    SETUP["007-SETUP<br/>T001 · chore · safe"]
    SOS["007-SIGNOFF-SALE-CONTEXT<br/>T002 · docs · safe"]
    SOI["007-SIGNOFF-IDEMPOTENCY<br/>T003 · docs · safe"]

    %% ---- Level 1: Phase 2 Foundational ----
    CONTRACT["007-CONTRACT 🔒GATED<br/>T010/T011 · feat · unsafe"]
    FORBID["007-FORBIDDEN-CATEGORY<br/>T020/T021 · feat · safe"]
    PROJ["007-REVIEW-QUEUE-PROJECTION<br/>T022/T023 · feat · safe"]
    ISO["007-ISOLATION-HARNESS<br/>T024/T025 · test · unsafe (shared fixture)"]

    %% ---- Level 2: user stories ----
    US1L["007-US1-LIST-PROJECTION<br/>T030-33 · feat · unsafe"]
    US1R["007-US1-RECONCILIATION-PROJECTION<br/>T038 · feat · unsafe"]
    US3["007-US3-INSPECT<br/>T040-43 · feat · unsafe"]
    US7["007-US7-REOPEN<br/>T050-54 · feat · unsafe"]
    US8["007-US8-BULK-DISMISS<br/>T055-58 · feat · unsafe"]

    %% ---- Level 2b: US2 (after US1 list path) ----
    US2["007-US2-LIST-EXTENSIONS<br/>T034-37 · feat · unsafe"]

    %% ---- Level 3: regression guards (Phase 8) ----
    US4["007-US4-LINK-REGRESSION<br/>T060 · test · safe"]
    US5["007-US5-CREATE-REGRESSION<br/>T061 · test · safe"]
    US6["007-US6-DISMISS-REGRESSION<br/>T062 · test · safe"]

    %% ---- Level 4-5: polish + closeout ----
    PAUDIT["007-POLISH-AUDIT-SWEEP<br/>T070/74/75/76 · test · safe"]
    PSMOKE["007-POLISH-SMOKE-COVERAGE<br/>T071/72 · test · safe"]
    CLOSE["007-CLOSEOUT<br/>T073 · docs · safe"]

    %% ---- edges: Level 0 -> Level 1 ----
    SETUP --> CONTRACT
    SOS --> CONTRACT
    SOI --> CONTRACT
    SETUP --> FORBID
    SETUP --> PROJ
    SETUP --> ISO

    %% ---- edges: Level 1 -> Level 2 ----
    PROJ --> US1L
    ISO --> US1L
    CONTRACT --> US1L
    SOS --> US1L

    PROJ --> US1R
    CONTRACT --> US1R
    SOS --> US1R

    PROJ --> US3
    ISO --> US3
    CONTRACT --> US3
    SOS --> US3

    ISO --> US7
    CONTRACT --> US7
    FORBID --> US7

    ISO --> US8
    CONTRACT --> US8

    %% ---- edges: US1 -> US2 ----
    US1L --> US2

    %% ---- edges: -> Level 3 regression guards ----
    FORBID --> US4
    US2 --> US4
    US1R --> US4
    SOI --> US4

    FORBID --> US5
    US2 --> US5
    US1R --> US5
    SOI --> US5

    FORBID --> US6
    US2 --> US6
    SOI --> US6

    %% ---- edges: -> Level 4-5 polish/closeout ----
    US7 --> PAUDIT
    US8 --> PAUDIT
    FORBID --> PAUDIT
    CONTRACT --> PAUDIT
    PAUDIT --> PSMOKE
    PSMOKE --> CLOSE

    %% ---- styling: gated + unsafe ----
    classDef gated fill:#ffe0b2,stroke:#e65100,stroke-width:3px,color:#000;
    classDef unsafe fill:#ffcdd2,stroke:#c62828,color:#000;
    classDef safe fill:#c8e6c9,stroke:#2e7d32,color:#000;

    class CONTRACT gated;
    class ISO,US1L,US1R,US3,US7,US8,US2 unsafe;
    class SETUP,SOS,SOI,FORBID,PROJ,US4,US5,US6,PAUDIT,PSMOKE,CLOSE safe;
```

**Parallel-safety legend** — `safe` (green) = no file/fixture overlap with any other ready slice; `unsafe` (red) = shared mutable file, must serialize against its peers; `🔒GATED` (orange) = `approval_required: true`, dispatch only after explicit in-session approval.

**Why the `unsafe` slices collide** (the file each pair/family mutates):

| Shared mutable file | Contending slices | Serialization rule |
|---|---|---|
| `apps/api/src/catalog/unknown-items/unknown-items.controller.ts` | US1-LIST · US2 · US3 · US8 | serialize the whole family |
| `apps/api/src/catalog/unknown-items/unknown-items.service.ts` | US2 · US3 · US8 | (subset of above) |
| `apps/api/src/catalog/reconciliation/reconciliation.controller.ts` | US1-RECONCILIATION (T038) · US7-REOPEN | serialize the pair |
| `apps/api/test/catalog/__support__/seed-unknown-items.ts` (shared fixture) | ISOLATION-HARNESS | land before any consumer |
| `packages/contracts/openapi/catalog/unknown-items.yaml` (GATED) | CONTRACT | gated keystone — alone |

**Endorsed-candidate parallel groups** (both `proposed: true` in the map, awaiting endorsement):

- `PHASE2-FOUNDATIONAL` = `007-FORBIDDEN-CATEGORY` ∥ `007-REVIEW-QUEUE-PROJECTION` ∥ `007-ISOLATION-HARNESS` (distinct files; all gated only on `007-SETUP`).
- `PHASE8-REGRESSION-GUARDS` = `007-US4` ∥ `007-US5` ∥ `007-US6` (test-only over a frozen reconciliation runtime).

**Critical path** (longest chain, includes the gated stall):
`007-SETUP → 007-CONTRACT 🔒 → 007-US7-REOPEN (or 007-US8-BULK-DISMISS) → 007-POLISH-AUDIT-SWEEP → 007-POLISH-SMOKE-COVERAGE → 007-CLOSEOUT` (with the two SIGN-OFF gates also required before `007-CONTRACT`). The `[GATED]` approval on `007-CONTRACT` is the one unavoidable human-in-the-loop bottleneck on this path.

---

## SIGN-OFF Decisions

Two product decisions were deferred from `/speckit-plan` (research §R1 / §R6) into `tasks.md` as `[SIGN-OFF]` gates (T002, T003). Both are recorded here as the authoritative verdict. **These gate the dependent GREEN tasks; recording them unblocks implementation.**

### T002 — `sale_context` tightening (research §R1; gates T032 / T042)

**Verdict: TIGHTEN — option (a), tighten now.**

The shipped `tenantAdminListUnknownItems` response (and the shipped `UnknownItem` schema at `packages/contracts/openapi/catalog/unknown-items.yaml` lines 704–711; runtime `unknown-items.controller.ts:168,225`) currently returns `sale_context`. 007 FR-007 / 006 FR-021a make this a **MUST NOT** for the review surface, and the shipped list **is** the review queue. Therefore:

- The 007 GATED contract extension (T010) switches the list, inspect, and FR-001a terminal-detail responses to the **`ReviewQueueItem`** projection (= `UnknownItem` minus `sale_context`) **in this slice** — not behind a deprecation window.
- This **modifies a 005-shipped response shape.** In-scope consequences flagged for the GATED slice (T010) and its conformance work:
  - 005's contract-conformance tests for `tenantAdminListUnknownItems` MUST be updated to expect the `sale_context`-free shape (or assert it is absent).
  - Any 005-era consumer/test that asserted `sale_context` **presence** on the list response MUST be reconciled. (Search before GREEN: `grep -rn "sale_context" apps/api/test/catalog/`.)
  - The `info.version` bump on the YAML documents the response-shape change (additive elsewhere, narrowing here — call it out in the version note).
- **Rejected:** "leave `sale_context` on the shipped list" — that would ship an FR-007 violation and was only permissible under an explicit FR-007 waiver, which is **not** granted.

**Rationale:** FR-007 is a MUST NOT and the shipped list is the user-facing review queue; leaving descriptive metadata on it is a data-surface defect, not a backward-compat nicety. Tightening now (vs. a deprecation window) avoids shipping a known leak into the first review-API release. The cost — touching 005's conformance tests — is bounded and is exactly what the GATED slice exists to review.

### T003 — Idempotency-key retrofit (research §R6; gates key-replay assertions in T060–T062)

**Verdict: ISOLATE — option (b), do not retrofit shipped ops in v1.**

- The **new** state-changing operations (reopen — T053/T054; bulk-dismiss — T057/T058) carry the `Idempotency-Key` header and provide **identical-replay-response** (replay same key+body → prior response; changed body → `idempotency_key_conflict` / 409).
- The **shipped** link / create / dismiss operations keep their existing **monotonic-guard no-duplicate-effect** (a retry of an already-applied action returns `already-reconciled`, never a second effect). They are **not** retrofitted with an idempotency key in v1.
- Consequence for tasks: the "If T003 = (a), add key-replay assertions" clauses in **T060 / T061 / T062 do NOT apply** — the regression guards assert no-duplicate-effect (monotonic guard) only, not identical-replay-response.

**Rationale:** FR-063's reworded two-strength model (no-duplicate-effect for all ops; identical-replay-response for key-bearing ops) is **fully satisfied** by isolate — the shipped ops already meet the no-duplicate-effect floor (Constitution §XI) via their monotonic guard. Retrofitting a key onto live ops is a behavior change with no v1 requirement driving it; it is recorded as an **optional future enhancement**, not v1 scope. This keeps 007 additive and avoids a second behavior change to shipped ops (T002 is already one).

**Asymmetry note:** T002 defaults to *tighten* (the alternative violates a MUST NOT) while T003 defaults to *isolate* (the alternative is an optional enhancement). The two SIGN-OFFs look parallel but are not — recorded here so a future reader does not mistake isolate-for-T003 as license to also isolate (leave-unchanged) for T002.

---

## SESSION UPDATE — 2026-05-29 — Phase 2–5 (P1 MVP) implemented → **PR #405 OPEN to `main`**

> **State reconciliation:** the `[GATED]` contract slice (T010/T011) **merged to
> `origin/main` via PR #404** (squash `f2622ee`) before this session — the
> `ReviewQueueItem` schema, the 3 new operationIds, `forbidden`, and the list
> params are all on `main`, and `contract-007.spec.ts` (49 conformance cases)
> rides along. The "Merged on main: None yet" section below is therefore
> **stale** as of this session (the execution-map `status: proposed` fields are
> stale for the same reason — #404's allowed_files did not include the map).
> Trust `git log origin/main`, not the `status:` fields, until CLOSEOUT (T073)
> reconciles them.

**Worktree:** `C:\Users\user\Documents\GitHub\dp2-007-wave1`, branch
`feat/007-wave1-p1-mvp` off `9026340` (latest `origin/main`). Single
integration worktree for the whole P1 wave (the slices form a dependent chain —
US1 needs the projection helper, US2 needs the US1 swap). **Committed as 4
grouped commits and opened as PR #405 to `main`** (awaiting CodeRabbit/CI +
human review; NOT merged). The execution-map carries `status: in_review` for the
7 wave-1 slices (and `merged` for 007-CONTRACT via #404); CLOSEOUT (T073)
reconciles them to `merged` once #405 lands.

**Slices completed this session (all GREEN against WSL Testcontainers Postgres):**

| Slice | Tasks | Outcome |
|---|---|---|
| 007-FORBIDDEN-CATEGORY | T020/T021 | Guard test (5 cases): 403→`forbidden` distinct from 404→`not_found`. **GREEN was already on `main`** — the `statusToCode` 403→FORBIDDEN mapping predates 007 (api skeleton `44f8fd6`); the slice value is the named regression guard. |
| 007-REVIEW-QUEUE-PROJECTION | T022/T023 | Shared `toReviewQueueItem(row, canSeeProduct)` helper in `dto/review-queue-item.dto.ts` (R7.2 single home; 100% cov). No `sale_context` (FR-007); FR-001a key-omission suppression. RED→GREEN, 7 cases. |
| 007-ISOLATION-HARNESS | T024/T025 | `seed-unknown-items.ts` +8 terminal rows (4 dismissed + 4 resolved, A/B×X/Y). `review-queue-sweep.spec.ts` (9 live + 3 `it.skip` tripwires for reopen/bulk-dismiss = US7/US8, out of wave). 003-owned `isolation-harness.ts` untouched. |
| 007-US1-LIST-PROJECTION | T030–T033 | `unknown-items.controller` list+dismiss → `toReviewQueueItem`. RED→GREEN (`list-projection`, `list-terminal-detail`); `list-queue`/`dismiss-*` regress clean. |
| 007-US1-RECONCILIATION-PROJECTION | T038 | `reconciliation.controller` link+create-product → `toReviewQueueItem`. **Finding (resolved):** action responses pass `canSeeProduct=true` (caller acted on the product) — FR-001a suppression is a browse-surface rule (list/inspect) only. Full reconciliation suite GREEN. |
| 007-US2-LIST-EXTENSIONS | T034–T037 | `list-unknown-items.dto.ts` + `listForTenant`: `source_system` filter, `sort` (age_asc/desc/store), `group_by` (contiguous ordering). Injection-safe (whitelisted enums + bound params). **Finding:** contract has NO facets object / NO age_bucket param (response is `{items,next_cursor}`, additionalProperties:false) — scope was narrower than the spec prose implied. RED→GREEN, FR-005 reject-not-clamp preserved. |
| 007-US3-INSPECT | T040–T043 | NEW `GET /{id}` → `tenantAdminInspectUnknownItem`, `ReviewQueueItem`, no candidate hint (FR-070), non-disclosing 404 (SI-004) via `findByIdForTenant`. List auth posture (no RolesGuard). RED→GREEN, 8 cases. |

**Decisions recorded this session:**
- **`canSeeProduct = (ctx.storeId === null)`** for browse surfaces (list/inspect) — tenant-wide actors see the product reference, store-scoped omit it (FR-001a; SC-007). User-decided. **Note for CLOSEOUT:** the rule keys on *store context*, NOT *role* — a tenant-wide admin operating with a store context set is treated as store-scoped (the create-product test runs a `tenant_admin` with `storeId=STORE_A_X`). Action responses (link/create/dismiss) never suppress.

**Verification:** full `catalog` suite — **56 suites / 429 passed / 5 skipped (US7/US8 tripwires) / 4 todo (pre-existing)**. New DTO files 100% coverage. No forbidden surface touched; `isolation-harness.ts` untouched; `git diff --check` clean. No commit/push/PR.

**Deferred (out of this wave, not regressions):** US7-REOPEN (Phase 6), US8-BULK-DISMISS (Phase 7), US4/5/6 regression guards (Phase 8), polish T070–T076, CLOSEOUT T073. The 3 `it.skip` tripwires in `review-queue-sweep.spec.ts` mark the reopen/bulk-dismiss isolation cases those slices must add.

---

## Merged on `main`

_None yet._ The 007 planning chain is committed on `spec/007-unknown-items-review-queue-api` (3 commits, see TL;DR) but not merged. No application code, schema, or OpenAPI YAML has been changed — the OpenAPI extension is the `[GATED]` T010 slice, not yet executed.

---

## Local only — committed/uncommitted, not on `main`

| Stage | Subject | Reference |
|---|---|---|
| Spec + clarify + plan + Phase 0/1 | spec.md (10 US, 35 own-FR, 11 SI, 9 SC; 3 clarifications), plan.md (Constitution PASS ×2, 005 dependency-readiness map), research.md (R1–R6), data-model.md, contracts/README.md, quickstart.md, checklists/requirements.md | `aab701d` |
| tasks.md (Phase 2) | 39 dependency-ordered tasks; RED/GREEN + Predecessors/Acceptance house style; GATED-first | `45ae621` |
| Analyze remediation | T074 (FR-053 determinism), T075 (FR-054 system-failure retry), T076 (FR-023/045/SC-003 absence-guard) + FR traceability refs; 42 tasks | `8a97e97` |
| SIGN-OFF decisions | This document — T002 = tighten, T003 = isolate | (this commit) |

---

## Active findings

_None._

## Next recommended action

1. **Request `[GATED]` approval** for T010 (extend `packages/contracts/openapi/catalog/unknown-items.yaml`). Per the T002 verdict, this slice also reconciles 005's `sale_context` conformance expectations.
2. **Dispatch the RED→GREEN pairs** per `tasks.md` §13 critical path: T010 (GATED) → foundational RED/GREEN (T020–T025) → US story pairs → polish (T070–T076) → T073 (this wave-status final update).
3. Per standing rules: no implementation, push, or PR without explicit instruction.
