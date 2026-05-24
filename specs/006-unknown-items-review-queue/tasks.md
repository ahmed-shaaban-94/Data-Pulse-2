---

description: "Task list — Unknown Items Review Queue (006)"
---

# Tasks: Unknown Items Review Queue

**Input**: Design documents from `specs/006-unknown-items-review-queue/`
**Prerequisites**: spec.md (required), plan.md (required), research.md, data-model.md, contracts/README.md, quickstart.md
**Tests**: NOT explicitly requested — 006 ships no code, so test scaffolding belongs to the downstream features. Validation tasks below are sign-off gates against the spec, not code tests.

**Pre-condition (not a task)**: PR #308 (the 006 spec + plan + Phase 0/1 artefacts + this `tasks.md` + `execution-map.yaml` + `wave-status.md`) is merged on `origin/main`. If PR #308 has not merged yet, hold all Phase 1+ work until it does.

**Agent OS compatibility**: This `tasks.md` is the canonical brief source for 006's slices. The dispatch-time schema fields (`allowed_files`, `validation`, `agent`, `parallel_safety`, etc.) live in [`execution-map.yaml`](./execution-map.yaml); the human-readable narrative + Next-Action prompt lives in [`wave-status.md`](./wave-status.md). Slice IDs in `execution-map.yaml` match the task IDs below 1:1 (T001..T023). Maestro short prompts like `Use Agent OS. Execute slice T010. Stop before commit.` work against 006 the same way they work against 005.

---

## ⚠️ Important — 006 ships no implementation

006 is a **product-level UX specification only** (spec §0, plan §9). The tasks below are therefore **coordination, validation, and readiness gates** — not source-code work. They track the non-code obligations that fall on the 006 feature owner:

- (a) get the spec + plan + Phase 0/1 artefacts cleanly merged and crosslinked from repo-level coordination surfaces
- (b) get reviewer sign-off on each user story's acceptance criteria so the spec is genuinely consumable downstream
- (c) hold the implementability gate for **the future API feature** until 005 Wave 2 reconciliation ships
- (d) hold the implementability gate for **the future UI feature** until the future API feature merges and Impeccable rounds run inside that feature

`/speckit-tasks` for 006 was optional per plan §9.5; this file fulfils the "minimal dependency-tracking tasks.md" option. **No task below produces application code, schema, OpenAPI YAML, NestJS modules, or React components.** When work that *does* produce those artifacts is identified, it lands in the future API feature's own `tasks.md` or the future UI feature's own `tasks.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps task to a user story from spec.md §5 (US1..US10)
- File paths reference the spec / plan / quickstart docs — those are the only files 006 owns

## Path Conventions

- **006-owned files**: `specs/006-unknown-items-review-queue/**` (spec.md, plan.md, research.md, data-model.md, contracts/README.md, quickstart.md, checklists/**)
- **Downstream-feature paths** (for context only — 006 tasks do NOT touch these): a future API feature may write under `apps/api/src/catalog/**`, `packages/contracts/openapi/**` (`[GATED]`); a future UI feature may write under `apps/dashboard/src/**`
- **Reference docs**: `CLAUDE.md` (Active feature / Specs summary), `docs/agent-os/**`, `specs/005-pos-catalog-sync-reconciliation/**`

---

## Phase 1: Setup (Coordination & Crosslink)

**Purpose**: After PR #308 merges, crosslink 006 from the repo-level coordination surfaces so downstream features can find and cite it, and clear any in-flight review feedback.

- [ ] T001 [P] Address any new findings from CodeRabbit re-review on commit `7cfe25c` (or later) before PR #308 merges; if findings require spec / plan / artefact changes, apply them and trigger one more CodeRabbit pass via `@coderabbitai review` comment on PR #308
- [ ] T002 [P] Add a "006 — Unknown Items Review Queue" entry to the **Specs summary** section of `CLAUDE.md`, citing `specs/006-unknown-items-review-queue/spec.md` as the product brief and noting downstream features are gated on 005 Wave 2
- [ ] T003 [P] Add a forward-link from `specs/005-pos-catalog-sync-reconciliation/wave-status.md` to 006, noting that 006 is the consuming product-level brief for unknown-item review UX (informational only — no semantic change to 005)

---

## Phase 2: Foundational (Implementability Gates for Downstream Features)

**Purpose**: Track the readiness conditions that gate **the future API feature** and **the future UI feature**. 006 itself remains shippable; these gates only block the downstream specs from opening.

**⚠️ CRITICAL**: The future API feature spec cannot be opened until T004 + T005 + T006 are observed. The future UI feature spec cannot be opened until the future API feature merges.

- [ ] T004 [Gate] 005 Wave 1 (capture path) closed on `origin/main`. **Done-when**: `specs/005-pos-catalog-sync-reconciliation/wave-status.md` shows `wave_1.status` is the closed/done value 005's wave-status schema uses (currently `wave_1` is in progress per its 2026-05-23 closeout in PR #305). When observed, record the final Wave 1 commit SHA inline in `specs/006-unknown-items-review-queue/plan.md` §5.1.
- [ ] T005 [Gate] 005 Wave 2 (reconciliation) spec authored and merged on `origin/main`. **Done-when**: a slice with `reconciliation` semantics is listed in `specs/005-pos-catalog-sync-reconciliation/execution-map.yaml` AND the corresponding service module appears under `apps/api/src/catalog/` on `origin/main`. When observed, update `specs/006-unknown-items-review-queue/plan.md` §5.3 with Wave 2's slice IDs, contract surface, and merge commit SHAs.
- [ ] T006 [P] [Gate] 003 PHASE3_RED_WAVE **GREEN** slices land. **Done-when**: `apps/api/src/modules/catalog/tenant-catalog.service.ts` has a GREEN-tier `create()` implementation (not just RED skeleton) AND `ProductAliasesService` has a GREEN-tier alias-uniqueness implementation on `origin/main`. Record their PR / commit refs in `specs/006-unknown-items-review-queue/plan.md` §5.3.
- [ ] T007 [P] [Gate] Constitution version still compatible. **Done-when**: a one-shot grep against `.specify/memory/constitution.md` confirms the header version is `v3.0.1` or a SemVer-compatible patch successor (`v3.0.x`). If the constitution bumps to `v3.1.x` or higher, the §II / §III / §IV / §IX / §XII / §XIII / §XIV touchpoints listed in 006's spec header MUST be re-read and any drift triggers `/speckit-clarify` against 006 before opening the future API feature.
- [ ] T008 [P] [Gate] Standing-rules / CodeRabbit config drift check. **Done-when**: `docs/agent-os/standing-rules.md` §3 forbidden-paths list still matches the claim in `specs/006-unknown-items-review-queue/plan.md` §9.4 (no migrations, no `packages/contracts/openapi/**`, no `.github/**`, no `package.json`, no `pnpm-lock.yaml`). One-shot verification, not a continuous watch.
- [ ] T009 [P] Verify the Agent OS compatibility surface for 006 — `specs/006-unknown-items-review-queue/execution-map.yaml` + `specs/006-unknown-items-review-queue/wave-status.md` exist and mirror this `tasks.md` 1:1 (slice IDs T001..T023 match task IDs). **Done-when**: (a) `ls specs/006-unknown-items-review-queue/{execution-map.yaml,wave-status.md}` succeeds, (b) every T0NN task ID in this file appears as a slice `id:` in `execution-map.yaml`, and (c) `plan.md` §6.1.1 narrative matches reality (006 carries both files in compact docs-only form, not exempted).

**Checkpoint**: When T004 + T005 + T006 are all complete, the future API feature spec can be opened (T021). T007 + T008 are one-shot drift checks. T009 closes the standing-rules structural gap and is independent of the gates.

---

## Phase 3: User Story 1 — Tenant admin reviews queue (Priority: P1) 🎯 MVP

**Goal**: Confirm the spec's US1 acceptance criteria are reviewer-validated and stable enough to inform the future API feature's harness extension (per `specs/006-unknown-items-review-queue/research.md` §R3).

**Independent Test**: Walk a reviewer through `specs/006-unknown-items-review-queue/quickstart.md` Scenario 1 against `specs/006-unknown-items-review-queue/spec.md` §5 US1 acceptance scenarios #1–3. Confirm each Given/When/Then matches expected behaviour and that no scope creep was introduced during sign-off.

### Validation task for User Story 1

- [ ] T010 [US1] Sign-off: walk through Scenario 1 of `specs/006-unknown-items-review-queue/quickstart.md` against US1 acceptance scenarios **#1, #2, and #3** in `specs/006-unknown-items-review-queue/spec.md` §5; record sign-off + any deltas as a dated entry under a new `## Sign-off log` section at the bottom of `specs/006-unknown-items-review-queue/checklists/requirements.md`

**Checkpoint**: US1 spec is consumable by the future API feature's planning. If sign-off reveals an unresolved product question, re-run `/speckit-clarify` rather than letting the future API feature absorb the ambiguity.

---

## Phase 4: User Story 2 — Store operator restricted view (Priority: P1)

**Goal**: Confirm US2's per-actor isolation safety floor is reviewer-validated.

**Independent Test**: Walk a reviewer through Scenario 2 of `quickstart.md` against `spec.md` §5 US2 acceptance scenarios #1–4. Verify the non-disclosing not-found behaviour is unambiguous.

- [ ] T011 [US2] Sign-off: walk Scenario 2 of `specs/006-unknown-items-review-queue/quickstart.md` against US2 acceptance scenarios **#1–#4** in `specs/006-unknown-items-review-queue/spec.md` §5; record sign-off + any deltas in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 5: User Story 3 — Filter / sort / group safely (Priority: P1)

**Goal**: Confirm US3's filter/sort/group safety boundaries (scope-respecting dropdowns, in-scope empty states) are reviewer-validated.

**Independent Test**: Walk Scenario 1 step 2 + Scenario 2 step 1 of `quickstart.md` against `spec.md` §5 US3 acceptance scenarios #1–6. Verify filter dropdowns never list out-of-scope dimensions.

- [ ] T012 [US3] Sign-off: confirm filter/sort/group safety in `specs/006-unknown-items-review-queue/spec.md` §5 US3 acceptance scenarios **#1–#6** (in particular **#2** — operator's filter dropdown lists only S1 — and **#5** — empty-state vs no-items-exist distinction); record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 6: User Story 4 — Item inspection with safe context (Priority: P1)

**Goal**: Confirm the inspection-view obligations (especially FR-001a, FR-021a, FR-080 MAY) match expectations after the 2026-05-24 external-review revisions.

**Independent Test**: Walk Scenario 1 step 3 + Scenario 1 step 5 of `quickstart.md` against `spec.md` §5 US4 acceptance scenarios #1–5 (note **#4 was rewritten 2026-05-24** to honour FR-021a's MUST NOT). Verify no contradictions remain between the user story and §6 FRs.

- [ ] T013 [US4] Sign-off: re-confirm US4 acceptance scenarios **#1–#5** in `specs/006-unknown-items-review-queue/spec.md` §5 — paying particular attention to the rewritten **#4** (descriptive metadata MUST NOT surface in v1) and **#5** (no out-of-scope candidate suggestions); record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 7: User Story 5 — Link to existing product (Priority: P1)

**Goal**: Confirm US5 link-flow obligations (target-unavailable, alias-conflict, race semantics) are reviewer-validated and aligned with 005 §6.5 / §6.6.

**Independent Test**: Walk Scenario 1 step 4 + Scenario 4 of `quickstart.md` against `spec.md` §5 US5 acceptance scenarios #1–5. Verify race-loser receives `already-reconciled`, not silent overwrite.

- [ ] T014 [US5] Sign-off: confirm US5 acceptance scenarios **#1–#5** in `specs/006-unknown-items-review-queue/spec.md` §5 — paying particular attention to **#3** (conflict) and **#4** (concurrent race) — plus the candidate-match safety floor in FR-040..FR-043; record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 8: User Story 6 — Create new product from unknown item (Priority: P1)

**Goal**: Confirm US6 create-flow obligations (atomic commit of product + alias + lifecycle, fail-closed on conflict) are reviewer-validated.

**Independent Test**: Walk Scenario 1 step 6 of `quickstart.md` against `spec.md` §5 US6 acceptance scenarios #1–5. Verify the create operation is transactional per 005 FR-063.

- [ ] T015 [US6] Sign-off: confirm US6 acceptance scenarios **#1–#5** in `specs/006-unknown-items-review-queue/spec.md` §5 — paying particular attention to **#2** (alias conflict → entire operation fails closed, no product left dangling); record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 9: User Story 7 — Dismiss item (Priority: P2)

**Goal**: Confirm US7 dismiss-flow obligations and the post-2026-05-24 `already-reconciled` (with `details.prior_state`) handling for the static-state-mismatch case are reviewer-validated.

**Independent Test**: Walk Scenario 1 step 7 of `quickstart.md` against `spec.md` §5 US7 acceptance scenarios #1–4. Verify the dismiss-of-terminal-row case returns `already-reconciled` with the prior-state discriminator, not the deprecated `already-terminal`.

- [ ] T016 [US7] Sign-off: confirm US7 acceptance scenarios **#1–#4** in `specs/006-unknown-items-review-queue/spec.md` §5 — paying particular attention to the rewritten **#3** (`already-reconciled` with `details.prior_state` discriminator, post-2026-05-24); record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 10: User Story 8 — Reopen item with tenant-wide authority (Priority: P2)

**Goal**: Confirm US8 reopen-flow obligations — particularly the post-2026-05-24 authority split (FR-062a: in-scope → `forbidden`, out-of-scope → `not-found`) and the fresh-`pending`-record model (per 005 FR-005) — are reviewer-validated.

**Independent Test**: Walk Scenario 3 of `quickstart.md` + Scenario 2 steps 5–6 against `spec.md` §5 US8 acceptance scenarios #1–6. Verify a store operator's in-scope reopen returns `forbidden`, not `not-found`, and is auditable.

- [ ] T017 [US8] Sign-off: confirm US8 acceptance scenarios **#1–#6** in `specs/006-unknown-items-review-queue/spec.md` §5 — paying particular attention to the post-2026-05-24 **#4 / #5** split (`forbidden` for in-scope, `not-found` for out-of-scope); record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 11: User Story 9 — Non-disclosing failure categories (Priority: P2)

**Goal**: Confirm the revised closed-set failure vocabulary (005 FR-091's seven categories + `forbidden`; `already-terminal` collapsed into `already-reconciled` via `details.prior_state`) is reviewer-validated and consistent across spec / plan / research / contracts / data-model / quickstart.

**Independent Test**: For each of the 8 categories (validation, target-unavailable, alias-conflict, idempotency-token-mismatch, already-reconciled, not-found, forbidden, system-failure), trace one Given/When/Then from `spec.md` §5 + `contracts/README.md` §2.3. Verify no orphaned `already-terminal` references remain.

- [ ] T018 [US9] Sign-off on the post-2026-05-24 closed-set vocabulary across `specs/006-unknown-items-review-queue/spec.md` FR-100, `specs/006-unknown-items-review-queue/contracts/README.md` §2.3, `specs/006-unknown-items-review-queue/research.md` §R4, and `specs/006-unknown-items-review-queue/data-model.md` §2.5. **Verification method**: run `rg -n "validation|target-unavailable|alias-conflict|idempotency-token-mismatch|already-reconciled|not-found|forbidden|system-failure|already-terminal" specs/006-unknown-items-review-queue/{spec,plan,research,data-model,quickstart}.md specs/006-unknown-items-review-queue/contracts/README.md` and verify all five docs enumerate identical 8-category sets, with `already-terminal` appearing only in historical revision-note context. Record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 12: User Story 10 — All review actions auditable (Priority: P2)

**Goal**: Confirm 006's audit obligations consume 005's existing audit pipe without introducing parallel surfaces.

**Independent Test**: Trace `specs/006-unknown-items-review-queue/spec.md` FR-110..FR-113 + `specs/006-unknown-items-review-queue/contracts/README.md` §2.4 against `specs/005-pos-catalog-sync-reconciliation/spec.md` §6.9 (FR-080..FR-083) + `specs/005-pos-catalog-sync-reconciliation/plan.md` §3.3. Verify 006 introduces zero new audit subjects, zero new metric names, and zero new audit-query surfaces.

- [ ] T019 [US10] Sign-off: confirm `specs/006-unknown-items-review-queue/plan.md` §4.4 + `specs/006-unknown-items-review-queue/contracts/README.md` §2.4 do not introduce any new metric or audit subject; record in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log

---

## Phase 13: Handoff to Downstream Features

**Purpose**: Final crosslink, knowledge transfer, and downstream-feature opening. Impeccable rounds belong to the future UI feature — not to 006 — per spec §11 and plan §9.3. This phase opens those downstream features when their gates are satisfied.

- [ ] T020 [Gate→Action] When 005 Wave 2 is complete (T005 closed), open the **future API feature spec** via `/speckit-specify` from a fresh worktree / branch, citing `specs/006-unknown-items-review-queue/spec.md` + `specs/006-unknown-items-review-queue/contracts/README.md` as inputs. The new spec directory follows the next-available NNN pattern under `specs/`. The future API feature carries its own clarify / plan / tasks / execution-map / wave-status artefacts — 006's `tasks.md` does not duplicate them.
- [ ] T021 [Gate→Action] When the future API feature merges (T020 closed), open the **future UI feature spec** via `/speckit-specify`, citing the merged future-API-feature contracts and `specs/006-unknown-items-review-queue/quickstart.md` as inputs. The future UI feature owns the `/impeccable shape` → `critique` → `audit` → `polish` → `clarify` chain per spec §11; **006 does not run any Impeccable rounds itself**.
- [ ] T022 [P] Final sweep of `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log — verify every Phase 3–12 sign-off (T010, T011, T012, T013, T014, T015, T016, T017, T018, T019) is present and dated. No spec / plan changes; archival check only.
- [ ] T023 Verify `CLAUDE.md` "Active feature" section reflects current state — if 006 has no in-flight follow-up work (expected steady state after T020 + T021 hand off), leave 006 referenced in "Specs summary" only. Single one-shot verification, not an open-ended monitoring task.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Pre-condition is PR #308 merged. T001 may run in parallel with the merge (CR fixes can land in 7cfe25c or successor before merge). T002 + T003 are post-merge crosslink work.
- **Foundational (Phase 2)**: T004 / T005 / T006 are gates on external work — they do not have actions until the gate condition is observed. T007 / T008 / T009 are one-shot drift checks / plan amendments, independent of the gates.
- **User Stories (Phase 3–12)**: All depend on PR #308 being merged (so reviewers can cite the spec / quickstart by their merged form). They do **not** depend on Phase 2 — sign-off can complete before 005 Wave 2 lands. Sign-off tasks are independent across stories and can be sequenced or parallelised per reviewer availability.
- **Handoff (Phase 13)**: T020 depends on T005 (005 Wave 2 merged). T021 depends on T020 (future API feature merged). T022 depends on Phases 3–12 sign-offs (T010–T019). T023 is a one-shot verification independent of everything else.

### User Story Independence

Every user story phase produces a single sign-off entry in `specs/006-unknown-items-review-queue/checklists/requirements.md` Sign-off log. Stories are independent in the sense that any one can be signed off without the others — but each phase consumes **the same spec.md** and **the same quickstart.md**, so material changes to those documents during sign-off should trigger re-checking already-signed phases. Treat sign-offs as point-in-time against the most recent spec/quickstart SHA.

### Parallel Opportunities

- T001, T002, T003 (Phase 1 — independent crosslink surfaces)
- T006, T007, T008 (Phase 2 — independent gates)
- T022 within Phase 13 (independent of T020 / T021 status; only requires Phases 3–12 done)
- All sign-off tasks T010 / T011 / T012 / T013 / T014 / T015 / T016 / T017 / T018 / T019 can run in parallel by different reviewers against the same spec/quickstart. They share a write target (`checklists/requirements.md` Sign-off log), so serialise the final commit if multiple sign-offs land in the same session — but the review activity itself is parallel.

### Within Each Story

- The sign-off task ([USn]) is the canonical gate.
- No code, no contract, no schema work — there is no internal ordering inside a story phase.

---

## Parallel Example: Sign-off Sweep

```text
# Run user-story sign-offs in parallel by different reviewers (no shared write
# contention while reviewing; serialise only the final checklist commit):
Task T010 [US1]:  Walk quickstart Scenario 1 against spec.md US1 #1–#3
Task T011 [US2]:  Walk quickstart Scenario 2 against spec.md US2 #1–#4
Task T012 [US3]:  Review spec.md US3 #1–#6 (filter/sort/group safety)
Task T013 [US4]:  Review spec.md US4 #1–#5 (especially #4 — descriptive metadata MUST NOT)
Task T018 [US9]:  Run rg vocabulary scan across 5 docs (research §R4 alignment)
```

Each task writes a separate entry to the Sign-off log in `specs/006-unknown-items-review-queue/checklists/requirements.md`; if multiple reviewers finish in the same window, commit sign-offs in a single squashed commit to avoid log-write conflicts.

---

## Implementation Strategy

### "MVP" for a non-code feature

The deliverable that makes 006 useful downstream is **the spec + plan + Phase 0/1 artefacts merged on `origin/main`**. That is a pre-condition for Phase 1, not a task within it — once PR #308 lands, 006 is already at its MVP state for downstream citation.

What remains in this `tasks.md`:

1. **Phase 1 crosslink** (T002, T003) — CLAUDE.md and 005 wave-status.md updated within a week of merge.
2. **Phase 1 CR follow-up** (T001) — clear any review findings before / immediately after merge.
3. **Phase 2 gates** (T004–T008) — set up watch-only; T009 closes the standing-rules structural gap.
4. **Phase 3–12 sign-offs** (T010–T019) — schedule with reviewers; aim for one P1 sign-off per week, then collapse P2 sign-offs into a single batch.
5. **Phase 13 handoff** (T020–T023) — when 005 Wave 2 lands, open the future API feature; when that merges, open the future UI feature.

### Incremental Delivery

- **Increment 1**: PR #308 merged (`status: ready for citation` by downstream).
- **Increment 2**: All P1 sign-offs recorded — T010, T011, T012, T013, T014, T015 (`status: P1 stable`).
- **Increment 3**: All P2 sign-offs recorded — T016, T017, T018, T019 (`status: fully signed`).
- **Increment 4**: Future API feature spec opens — T020 (`status: implementation handoff begun`).
- **Increment 5**: Future UI feature spec opens — T021 (`status: end-to-end implementation in flight`).

### What this `tasks.md` does NOT cover

- ❌ Any `apps/api/**`, `apps/dashboard/**`, `apps/worker/**` code changes.
- ❌ Any `packages/contracts/openapi/**` YAML.
- ❌ Any `packages/db/drizzle/**` migration.
- ❌ Any `.github/**`, `package.json`, `pnpm-lock.yaml` changes.
- ❌ Any `/impeccable shape | critique | audit | polish | clarify` rounds — they fire inside the future UI feature, never inside 006 (spec §11, plan §9.3).
- ❌ Anything that produces a new constitution gate.

If any of the above appear necessary, **stop and confirm scope** — they belong in the future API feature or the future UI feature, not in 006.

---

## Notes

- This `tasks.md` is intentionally smaller than a typical Spec Kit task list because 006 ships zero code. The task density reflects coordination work, not implementation work.
- [P] markers indicate independent work surfaces, not parallel build steps.
- [Gate] markers indicate tasks whose completion is observed (not authored) — they have explicit "Done-when" criteria stated inline.
- Sign-off entries accumulate in `specs/006-unknown-items-review-queue/checklists/requirements.md` under a `## Sign-off log` section that T010 creates; subsequent sign-offs append.
- Every `[USn]` sign-off task references **specific scenario numbers** (e.g., "US1 #1–#3", "US7 #3") rather than line numbers — line numbers drift with every edit.
- If 005 Wave 1 / Wave 2 semantics shift before Phase 13, re-run `/speckit-clarify` against 006 before reopening sign-off (per plan §5.4 risk surface).
