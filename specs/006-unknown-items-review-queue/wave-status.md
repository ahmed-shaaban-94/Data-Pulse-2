# Wave Status — `006-unknown-items-review-queue`

**Last updated:** 2026-05-24 (post-merge closeout: PR #308 @ `678cbd2` merged 2026-05-23; PR #311 @ `8ea103a` merged 2026-05-24 — Agent OS compatibility artefacts on `main`)
**Spec:** [`specs/006-unknown-items-review-queue/`](.)
**Base:** `origin/main` at `8ea103a` (PR #311, 006 Agent OS compatibility, 2026-05-24)
**Active findings:** 0
**Resolved findings:** 0

---

## TL;DR

**006 is a docs-only feature.** No application code, no schema, no OpenAPI YAML, no UI artefacts. Every slice in [`execution-map.yaml`](./execution-map.yaml) carries `type: docs` and `approval_required: false`. The "deliverable" 006 produces is the spec + plan + Phase 0/1 artefacts + this execution map merged on `main`, so downstream features (a future API feature, then a future UI feature) can cite 006 as their product brief.

**23 slices**, all at `status: proposed` or `status: blocked` at authoring time:

- **3 setup slices** (T001–T003) — CodeRabbit follow-through + CLAUDE.md crosslink + 005 wave-status forward-link.
- **6 foundational gate slices** (T004–T009) — three external-work gates (`blocked`) + three drift-check slices (`proposed`).
- **10 sign-off slices** (T010–T019) — one per spec.md user story (US1–US10); all share `checklists/requirements.md` so they are `parallel_safety: unsafe` and serialise.
- **4 handoff slices** (T020–T023) — open the future API feature spec, open the future UI feature spec, final sign-off-log sweep, CLAUDE.md Active-feature verification.

**Next moves (superseded — see [§ Next recommended action](#next-recommended-action) below for the current state as of 2026-05-28):**

The authoring-time plan below is retained for history. All of steps 1–3 are now DONE: PR #308/#311 merged the artefacts; T002 + T003 crosslinks landed in PR #380; the `PHASE2-DRIFT-CHECKS` group (T007–T009) closed in PR #381. Only steps 4–5 remain, and neither is Claude-executable (reviewer sign-offs + external-gated feature-spec openings).

1. ~~**PR #308 and PR #311 are merged**~~ — done; 006 artefacts on `main`.
2. ~~**Dispatch the Phase 1 crosslink pair** (T002 + T003)~~ — done (PR #380).
3. ~~**Run the drift checks** (`PHASE2-DRIFT-CHECKS`: T007 + T008 + T009)~~ — done (PR #381).
4. **Open the Phase 3–12 sign-off sweep** — schedule reviewers against `quickstart.md` scenarios; sign-offs serialise on `checklists/requirements.md`. *(reviewer-owned)*
5. **Hold T020 / T021** until the foundational gates observe their external triggers (T004–T006 already complete; the gates now wait on the future API/UI feature specs being prioritised). *(external-gated, `approval_required`)*

**No waves.** Unlike 005 (which has Wave 1 capture + Wave 2 reconciliation), 006 has phases mapping to spec.md §5 user stories. The "Wave" in the filename is convention; 006's narrative below is single-phase coordination.

---

## Merged on `main`

| Stage | Subject | Reference |
|---|---|---|
| Spec + plan + Phase 0/1 artefacts | 006 product-level UX brief — 10 user stories, 38 FRs (incl. FR-001a / FR-021a / FR-062a / FR-070a / FR-100 with `forbidden`), 9 SI requirements, 8 SCs, 12 edge cases, 4 clarifications + 3 external-review revisions | PR #308 @ `678cbd2` (2026-05-23) |
| `tasks.md` + `execution-map.yaml` + `wave-status.md` | Agent OS compatibility artefacts — slice schema, T001..T023 coordination tasks, execution map with parallel groups, wave-status initial authoring | PR #311 @ `8ea103a` (2026-05-24) |
| T001 close-by-vacuity + T002 + T003 | T001: CodeRabbit posted "No actionable comments" on PR #308 at `7cfe25c` → close-by-vacuity recorded in `execution-map.yaml`. T002: 006 row added to `CLAUDE.md` Specs summary. T003: forward-link from 005's wave-status.md to 006. Validation greps all pass. | PR #380 @ `8e543b1` (2026-05-28) |
| T006 + T007 + T008 + T009 close-by-execution | T006: 003 services (`tenant-catalog.service.ts` 232 LOC, `product-aliases.service.ts` 245 LOC) both on main, GREEN (no skeleton markers). T007: constitution at `v3.0.0` (SemVer-patch range satisfied). T008: standing-rules.md §3 forbidden-paths list matches plan.md §9.4 claim — drift-free. T009: both coordination artefacts on disk; plan.md §6.1.1 narrative holds. All four slices validated without requiring file edits — outcomes recorded in `execution-map.yaml`. | PR #381 @ `525b10b` (2026-05-28) |
| T023 close-by-execution | Active feature section of CLAUDE.md does not reference 006 follow-up work; 006 appears only in Specs summary (added by T002 in PR #380). Slice's expected state holds; no CLAUDE.md edit required. Separately-flagged doc-debt (the "004 active" framing is stale — 004 substantially closed, 005 shipped Waves 1+2) is out of T023's scope and recorded as a future CLAUDE.md-refresh slice candidate. | PR #382 @ `167ec2b` (2026-05-28) |
| T004 + T005 close-by-execution | T004: 005 Wave 1 COMPLETE on main (PR #351 WAVE1-POLISH). Slice literal grep `wave_1.*(closed\|complete\|done)` fails (snake_case mismatch — actual doc uses `Wave 1`); intent grep matches twice. T005: 005 Wave 2 COMPLETE on main (PR #374 WAVE2-POLISH); 10 `005-WAVE2-*` slices listed in 005 execution-map, 24 `status: merged` entries. Both gates close-by-execution; no plan.md edit. T004's literal-grep mismatch flagged as slice-grammar doc-debt (a future slice should harmonize the grep with the wave-status grammar the project actually uses). | PR #383 (this PR) (2026-05-28) |

---

## Local only — committed/uncommitted, not on `main`

_None._ All planning artefacts are on `main` — PR #308 (spec/plan/Phase 0–1) merged 2026-05-23; PR #311 (tasks.md/execution-map/wave-status) merged 2026-05-24.

---

## Active findings

_None._

**Other known issues** (planning-time decisions, not findings):

- The Agent OS `execution-map.yaml` + `wave-status.md` files for 006 were authored late (2026-05-24, after the initial /speckit-plan run). The prior plan §6.1.1 framing claimed an exemption from CLAUDE.md bootstrap items 5 + 6; that framing has been reversed (§6.1.1 now describes the compact docs-only form 006 uses). See plan §6.1.1 for the rationale.
- `tasks.md` was generated by `/speckit-tasks` against 006 even though plan §9.5 said it was optional. The decision was to generate a coordination-only tasks.md that serves as the canonical brief source for each slice in this `execution-map.yaml`. Slice IDs T001..T023 are 1:1 with task IDs.

---

## Resolved findings

_None._

---

## Blocked

These slices cannot transition to `ready` until their external trigger fires:

| Slice | Status | Blocked by | What it waits for |
|---|---|---|---|
| T004 | blocked | 005 Wave 1 closeout on `origin/main` | `005/wave-status.md` shows `wave_1.status: closed`. Currently Wave 1 is in progress (last closeout PR was #305 on 2026-05-23). |
| T005 | blocked | 005 Wave 2 reconciliation spec authored + merged | 005's `execution-map.yaml` lists Wave 2 reconciliation slices and at least one is merged. 003 PHASE3_RED_WAVE dependency is cleared (T350/T351 + T383/T384 GREEN pairs merged); 005 Wave 2 task authoring is still pending. |
| T020 | blocked | T005 transitions to merged | Cannot open the future API feature spec until 005 Wave 2 reconciliation lands. |
| T021 | blocked | T020 transitions to merged | Cannot open the future UI feature spec until the future API feature merges. |
| T022 | blocked | All Phase 3-12 sign-offs (T010..T019) recorded | Final sweep of the sign-off log. |

---

## Ready

These slices have no unsatisfied dependencies and can dispatch when their slot opens:

| Slice | Phase | Agent | Allowed files | Parallel-safe with |
|---|---|---|---|---|
| T001 | 1 — Setup | opus-maestro | `specs/006-unknown-items-review-queue/**` | T003 (different file) |
| T002 | 1 — Setup | opus-maestro | `CLAUDE.md` | — (T023 also touches CLAUDE.md) |
| T003 | 1 — Setup | opus-maestro | `specs/005-pos-catalog-sync-reconciliation/wave-status.md` | T001 (different file) |
| T007 | 2 — Foundational drift check | opus-maestro | `specs/006-unknown-items-review-queue/{spec,plan}.md` (read-only verification) | T008, T009 |
| T008 | 2 — Foundational drift check | opus-maestro | (read-only) | T007, T009 |
| T009 | 2 — Foundational drift check | opus-maestro | (read-only) | T007, T008 |
| T010 | 3 — US1 sign-off | reviewer | `specs/006-unknown-items-review-queue/checklists/requirements.md` | — (sign-offs serialise) |
| T011 | 4 — US2 sign-off | reviewer | (same file) | — |
| T012 | 5 — US3 sign-off | reviewer | (same file) | — |
| T013 | 6 — US4 sign-off | reviewer | (same file) | — |
| T014 | 7 — US5 sign-off | reviewer | (same file) | — |
| T015 | 8 — US6 sign-off | reviewer | (same file) | — |
| T016 | 9 — US7 sign-off | reviewer | (same file) | — |
| T017 | 10 — US8 sign-off | reviewer | (same file) | — |
| T018 | 11 — US9 sign-off | reviewer | (same file) | — |
| T019 | 12 — US10 sign-off | reviewer | (same file) | — |
| T006 | 2 — Foundational gate | opus-maestro | `specs/006-unknown-items-review-queue/plan.md` | T004, T005 (different files) |
| T023 | 13 — Handoff | opus-maestro | `CLAUDE.md` | — (T002 also touches CLAUDE.md) |

**Parallel groups** (both executed; retained as the dispatch-grammar record):

- `PHASE1-CROSSLINK` — { T001, T002, T003 } — closed via PR #380 (T001 close-by-vacuity + T002/T003 crosslinks).
- `PHASE2-DRIFT-CHECKS` — { T007, T008, T009 } — `parallel_safety: safe`; three independent drift-verification reads, all closed via PR #381.

---

## Next recommended action

**All Claude-executable 006 slices are CLOSED.** As of 2026-05-28, every docs/coordination slice an agent can run is `complete-by-execution` (or `complete-by-vacuity`): T001 (#379), T002 + T003 (#380 — crosslinks; status reconciled from stale `proposed` on 2026-05-28), T004 + T005 + T006 (#383/#381), T007 + T008 + T009 drift checks (#381), T023 handoff (#382). The deliverables for T002 (CLAUDE.md Specs-summary row) and T003 (006 forward-link in 005's wave-status) were already on `main` via PR #380; the execution-map's `proposed` status for them was stale bookkeeping, now reconciled.

**What remains is NOT Claude-executable:**

1. **Per-user-story sign-offs (T010–T019) + final review (T022)** — `agent: reviewer`. These require a human reviewer to judge the spec/quickstart against `checklists/requirements.md` and sign off. Dispatch one P1 sign-off at a time (T010–T015 share the checklist file; serialise), then batch the P2 sign-offs (T016–T019).
2. **Downstream feature-spec openings (T020 + T021)** — `status: blocked`, `approval_required: true`. They open *new* API + UI feature specs that do not yet exist; gated on explicit user authorisation and on the upstream feature being prioritised. Not actionable until then.

There is no remaining agent-runnable planning work in 006. The next move is the human reviewer sweep (T010–T019), outside Claude's scope.

---

## Notes

- 006 has **no waves** — single-phase coordination. The "Wave 1 / Wave 2" terminology in 005 maps to wave-status sections in 005, not to 006.
- All 23 slices touch documentation only. There is no `[GATED]` slice in 006's execution-map; `approval_required: true` appears only on T020 + T021 because they open *new feature specs* (downstream work), not because they touch a gated path.
- Sign-off slices (T010–T019) share `checklists/requirements.md`. To serialise correctly, dispatch them one at a time. Each slice's validation grep targets a unique `T0NN sign-off` heading anchor.
- Both Phase-1/Phase-2 parallel groups (`PHASE1-CROSSLINK`, `PHASE2-DRIFT-CHECKS`) have executed and closed (PRs #380/#381). The only un-dispatched slices remaining are reviewer-owned sign-offs (T010–T019, T022) and the external-gated, `approval_required` feature-spec openings (T020, T021).
