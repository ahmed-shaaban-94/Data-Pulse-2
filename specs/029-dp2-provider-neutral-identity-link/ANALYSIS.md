# Analysis — Draft D3 DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **DRAFT — NOT DISPATCHED.** SPECIFY-time internal-consistency readiness pass (`/speckit-analyze`-equivalent). Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. **Readiness != dispatch-authorization** — dispatch requires explicit scoped owner approval + verified G10.

**Spec:** [spec.md](./spec.md) - [plan.md](./plan.md) - [tasks.md](./tasks.md) - [checklists/requirements.md](./checklists/requirements.md)
**Mode:** SPECIFY-ONLY / DRAFT. **Date:** 2026-06-12. **Reviewer pass:** per-spec analyze + checklist (distinct from the cross-repo collision report).
**Method:** Manual `/speckit-analyze`-equivalent. The bespoke `auth-028-analyze-ready` workflow is a 3-spec orchestrator (DP-2 029, DP-2 030, Connector 007) and would recurse/exceed this single-spec scope; manual path chosen per the task's "either path is fine" allowance. No protected file edited, no git side effect.

---

## A. Method & scope

This is the finer **internal-consistency** check across `spec.md <-> plan.md <-> tasks.md`, confirming:

1. every functional requirement / acceptance criterion traces to >=1 task (or to a non-dispatchable constraint);
2. plan phases cover all spec sections;
3. each acceptance criterion has a task or verification step;
4. no contradiction / duplication;
5. gates are correctly tagged (G10 + G3, no G2).

Evidence cited by the spec (E-1/E-2/E-3) was re-verified **read-only** against Data-Pulse-2 `origin/main` this session — all three match verbatim:

- **E-1** — `packages/db/drizzle/0001_pos_operator_identity.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`, format CHECK `clerk_user_id IS NULL OR clerk_user_id <> ''`, partial UNIQUE `users_clerk_user_id_uidx ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL`. **Confirmed.**
- **E-2** — `apps/api/src/pos-operators/pos-operators.service.ts`: header comment line 8 "Resolve the local user by `users.clerk_user_id = sub`"; `findUserByClerkSubject` (def ~617) `SELECT ... WHERE clerk_user_id = $1 LIMIT 1`; callers at ~331/410/448/586/692. **Confirmed.**
- **E-3** — `apps/api/src/pos-operators/clerk-verifier.ts` imports `verifyToken` from `@data-pulse-2/auth`; `packages/auth/src/clerk-jwt.ts` is `export { verifyToken } from "@clerk/backend"` with the "keeps the `@clerk/backend` dependency contained ... import only from here" header. **Confirmed** — the spec's E-3 precision (re-export is the real call site, not a direct `@clerk/backend` call in `clerk-verifier.ts`) holds.

Evidence basis is sound; the spec does not assert any unverified work as done.

---

## B. Requirement -> task coverage matrix

Goals (G-n) and Acceptance criteria (A-n) traced to plan phases and tasks. "Covered-by-constraint" = a negative/meta requirement satisfied at the draft/docs-only level, intentionally with no build task. "Covered-by-verification" = proven by a test/verification task rather than built.

### Goals

| Goal | Plan phase | Task(s) | Status |
|---|---|---|---|
| **G-1** neutral identity link `(provider_key, issuer, subject) -> user_id` + 028 section 16 attrs | Phase 1 | T1, T2 | Covered |
| **G-2** `IdentityProviderPort`/Adapter with 028 section 16 op set; Clerk = only v1 impl | Phase 2 | T3, T4, T5 | Covered |
| **G-3** re-point resolution to the link via provider-neutral verified subject (PI-3) | Phase 3 | T6 | Covered |
| **G-4** reclassify `users.clerk_user_id` as v1 bridge column (off the join) | Phase 5 | T8 | Covered |
| **G-5** future provider switch = per-adapter change; no 2nd provider in v1 | Test strategy (provider-readiness) | T9 (provider-readiness case), T5 (seam defined) | Covered-by-verification |
| **G-6** backfill safe, idempotent, fail-closed for unmappable subjects | Phase 4 | T7 | Covered |

### Acceptance criteria

| AC | Spec ref | Plan phase | Task(s) | Status |
|---|---|---|---|---|
| **A-1** identity-link concept with all 028 section 16 attrs | section 5 | Phase 1 | T1, T2 | Covered |
| **A-2** `IdentityProviderPort` defined; single Clerk adapter only v1 impl | section 6 | Phase 2 | T3, T4, T5 | Covered |
| **A-3** resolution joins the link via neutral subject; no path uses `clerk_user_id` as join key | section 7; G-3 | Phase 3 | T6 (+ T8 documents demotion) | Covered |
| **A-4** `verifyIdentityToken` replaces direct `ClerkVerifier`/`verifyToken`; `@clerk/backend` stays contained | section 6; E-3 | Phase 2 + 3 | T4, T6 | Covered |
| **A-5** `clerk_user_id` reclassified as v1 bridge — retained, legacy, off join, not dropped | section 5; G-4; N-7 | Phase 5 | T8 | Covered |
| **A-6** backfill idempotent, reversible, fail-closed | section 5; section 8; G-6; G3 | Phase 4 | T7 | Covered |
| **A-7** single active link per user in v1; schema permits future dual-link without reshape | section 5; D3-LOCAL; OQ-7 | Phase 1 | T2 | Covered |
| **A-8** no contract/OpenAPI, no `clerkJwt` rename, no credential change, no POS/Console change | N-2/N-3/N-4/N-5 | Test strategy (regression) | T9 (regression), T10 (verify) | Covered-by-verification |
| **A-9** future switch = per-adapter; no 2nd provider integrated in v1 | G-5; N-6; OQ-7 | Test strategy (provider-readiness) | T9 (stub-adapter case) | Covered-by-verification |
| **A-10** no implementation/migration/contract/gate mutation **by this draft** | N-1; N-8 | — (draft-authoring property) | **Covered-by-constraint** (no build task — correct) | Covered |

**No acceptance criterion or goal is uncovered.** A-10 is a property of the docs-only draft-authoring step, not a post-dispatch build task; it correctly maps to no T-task and is satisfied at the constraint/`requirements.md` level. A-8 and G-5/A-9 are negative/readiness criteria proven by verification tasks (T9 regression + provider-readiness, T10 slice-verify) rather than built — this is the right shape, not a gap.

### Task -> upstream trace (reverse check)

| Task | Justified by | Orphan? |
|---|---|---|
| T0 pre-flight | Plan Phase 0; G10/G0 gate discipline | No |
| T1 link migration | G-1, A-1; Phase 1 | No |
| T2 uniqueness + single-active guard | G-1, A-7; D3-LOCAL; Phase 1 | No |
| T3 define port | G-2, A-2; Phase 2 | No |
| T4 Clerk adapter | G-2, A-2, A-4; Phase 2 | No |
| T5 remaining seams | G-2 (downstream D8/user-admin); section 6; Phase 2 | No |
| T6 resolver re-point | G-3, A-3, A-4; Phase 3 | No |
| T7 backfill | G-6, A-6; Phase 4 | No |
| T8 reclassify `clerk_user_id` | G-4, A-5, N-7; Phase 5 | No |
| T9 test pass | A-1...A-9 (verification), G-5 readiness | No |
| T10 slice-verify + return | A-3/A-5/A-8 confirm; CLAUDE.md return-to-orchestrator | No |

Every task traces to a goal/AC or to required gate/process discipline. No orphan tasks.

---

## C. Consistency findings (spec <-> plan <-> tasks)

### Pass — verified consistent

- **C-P1 — Phase/task alignment.** Plan's five phases map cleanly onto tasks: Phase 1 -> T1/T2; Phase 2 -> T3/T4/T5; Phase 3 -> T6; Phase 4 -> T7; Phase 5 -> T8; Test strategy -> T9; plus T0 pre-flight (Phase 0) and T10 verify/return. No spec section is left without a plan phase and a task.
- **C-P2 — Gate tagging consistent and correct.** G10 is on **all** tasks (boundary blocks all D3 work) and stated identically in spec gate-posture, plan "Gate tags for the whole slice," and the tasks gate legend. G3 sits on exactly the schema-touching tasks — **T1, T2, T7** — and on Phases 1 and 4. **T8 carries G10 only (no G3) — correct**, because reclassification is documentation-only (the index/CHECK stay; no DDL change). **No G2 anywhere** — consistent across all three files, with the reason stated (no contract surface; `clerkJwt` rename is sibling drift D4, additive off D1). No mis-tagged gate.
- **C-P3 — Scope boundary identical across files.** N-2...N-7 (no envelope/D1-D2, no contract/D4, no POS/D6, no Console/D8, no 2nd provider, no `clerk_user_id` drop) are restated consistently in spec section 3, plan "Out of plan," tasks "Dependency notes / Not gated on D3," and requirements.md. No drift between the four scope statements.
- **C-P4 — DAG edges consistent.** D3->D8 and D3->D6 (with D6 also needing D1/D5, D8 also needing the Console `62d0906` re-pin) appear identically in spec Dependencies, tasks "Downstream," and requirements.md. "D3 = DAG foundation, no upstream drift dep, gated only on G10" is uniform.
- **C-P5 — Clarifications fully propagated.** OQ-6 (neutral link in v1 / `clerk_user_id` as bridge), OQ-7 (readiness-only, no 2nd provider), D3-LOCAL (single active link per user, schema permits dual-link), D3-VERIFY (`verifyIdentityToken` neutralizes both verification and join), D3-RESOLVE (no credential change) all flow into the matching goals/ACs/tasks. No resolved clarification is contradicted downstream.
- **C-P6 — Internal-ordering coherent.** Tasks "Internal ordering" (schema T1/T2 parallel port T3/T4/T5; resolver T6 needs both; backfill T7 needs schema; reclassify T8 needs T6+T7) matches the plan's "schema -> port -> resolver -> backfill -> reclassify" sequencing and the per-task `Depends on` column. T6 depends on T2+T4; T8 on T6+T7; T9 on T6+T7+T8; T10 on T9 — acyclic and self-consistent.
- **C-P7 — Fail-closed invariant preserved end-to-end.** mig `0001` ADR D4 "fail closed when a verified JWT has no local mapping" is carried into G-6, A-6, section 5 migration-safety, section 7 resolver (non-enumerating 401/refusal), Phase 3/4, and T6/T7. No path silently drops an unmappable subject.

### Findings — non-blocking (LOW severity)

- **F-1 (LOW, cosmetic / self-referential path drift).** The spec's authoring notes ("authoring & placement notes" section) and `requirements.md` (Forbidden-files item) describe the artifacts as living at the Orchestrator path `docs/specs/drafts/028-followups/d3-dp2-identity-link/`. The files physically reside at **`specs/029-dp2-provider-neutral-identity-link/`** in the **Data-Pulse-2** repo (where this review runs). The `requirements.md` statement "only files under `docs/specs/drafts/028-followups/...` were created" is now literally inaccurate **about location only**. This is a stale self-reference from the draft's original Orchestrator-staging authorship; it does **not** touch any substantive requirement, gate, evidence, or scope claim. **Not a blocker.** Owner may optionally update the two path references when the spec is next edited (out of this read-only review's remit — the task forbids editing spec.md/requirements.md).
- **F-2 (LOW, precision).** `tasks.md` T9 says the test pass "Proves A-1...A-10." A-10 ("no implementation/migration/contract/gate mutation **by this draft**") is a draft-authoring property that no post-dispatch test can prove — it is established before any task runs. T9 in fact proves A-1...A-9 (A-8/A-9 via regression + provider-readiness). Minor overclaim in task-note prose; does not affect coverage or sequencing. **Not a blocker.**

### Checked — no finding

- **No contradiction** between any goal, non-goal, acceptance criterion, plan phase, or task.
- **No duplication** that creates ambiguity (the deliberate restatement of scope/DAG across files is consistency reinforcement, not conflicting duplication).
- **No gate under- or over-tagging** (see C-P2).
- **No uncovered FR/AC** (see section B).
- **No orphan task** (see section B reverse trace).
- **No evidence claim unverified** (see section A — E-1/E-2/E-3 confirmed verbatim).

---

## D. Dispatch-readiness verdict

**READY** — internally complete and dispatch-ready, **subject to G10 verification + explicit scoped owner approval.**

Rationale:

- All six goals and all ten acceptance criteria trace to a task, a verification task, or (for the meta/negative criterion A-10) the docs-only constraint level. No FR/AC has zero coverage.
- spec <-> plan <-> tasks are mutually consistent: phases cover every spec section, dependency ordering is acyclic, clarifications propagate without contradiction, and the scope boundary and DAG edges are uniform across all four files.
- Gate tagging is correct and consistent: **G10 on all work**, **G3 on the schema-touching tasks (T1/T2/T7) only**, **no G2** (justified — no contract surface; `clerkJwt` rename is D4). T8's G3-absence is correct (documentation-only).
- Evidence (E-1/E-2/E-3) re-verified verbatim against `origin/main`; no unverified status is asserted as fact.

**Readiness != dispatch-authorization.** This verdict says the draft is internally sound enough to *become* a Data-Pulse-2 Queue Item; it does **not** authorize any implementation. Dispatch remains blocked until:

1. **G10 (Identity & Access Boundary Gate)** is verified satisfied for this consuming spec (producer = Orchestrator 028); and
2. the **owner explicitly approves** a scoped dispatch.

The two LOW findings (F-1 stale draft-path self-reference; F-2 T9 "A-1...A-10" overclaim) are cosmetic/precision notes for the owner's optional cleanup on the next edit. **Neither blocks readiness** — they touch self-referential prose, not substance.

---

> **Docs-only readiness record (SPECIFY-ONLY / DRAFT).** This analysis only reviews the D3 draft for internal consistency and coverage. It performs no implementation, defines no contract, creates no migration, and mutates no gate or kernel state. Dispatch to Data-Pulse-2 requires verified G10 + explicit scoped owner approval.
