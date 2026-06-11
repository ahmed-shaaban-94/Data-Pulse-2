# Analyze-Readiness Checklist — Draft D3 DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **DRAFT — NOT DISPATCHED.** SPECIFY-time `/speckit-checklist`-equivalent. Focused **dispatch-readiness** quality gate — distinct from the specify-time [requirements.md](./requirements.md) (scope/evidence/gate framing) and from the cross-repo collision report. Planning artifact under docs-only Orchestrator. **Readiness != dispatch-authorization.**

**Spec:** [../spec.md](../spec.md) - **Analysis:** [../ANALYSIS.md](../ANALYSIS.md)
**Created:** 2026-06-12. **Mode:** SPECIFY-ONLY / DRAFT.
**Purpose:** Confirm spec.md / plan.md / tasks.md are mutually consistent, coverage-complete, gate-correct, and free of dispatch-blocking gaps — the finer internal pass before D3 can *become* a Data-Pulse-2 Queue Item (still subject to G10 + owner approval).

> A checked box means the artifact set already satisfies the item, with the cite. Items are pass/fail; LOW non-blocking notes are recorded but do not fail the box.

## CHK-1 Coverage completeness

- [x] **CHK-1.1** Every goal G-1...G-6 traces to >=1 task. *(ANALYSIS section B Goals table — all Covered.)*
- [x] **CHK-1.2** Every acceptance criterion A-1...A-10 traces to a task, a verification task, or a documented constraint. *(ANALYSIS section B AC table — all Covered; A-10 covered-by-constraint, A-8/A-9 covered-by-verification.)*
- [x] **CHK-1.3** No task is an orphan (each traces upstream to a goal/AC or required gate/process step). *(ANALYSIS section B reverse-trace table — T0...T10 all justified.)*
- [x] **CHK-1.4** Negative/meta criteria (A-8, A-9, A-10) are not falsely flagged as gaps — they are correctly satisfied at verification (T9/T10) or constraint level. *(ANALYSIS section B note.)*

## CHK-2 Spec <-> plan <-> tasks consistency

- [x] **CHK-2.1** Each plan phase has at least one task and each task maps to a plan phase/test-strategy line. *(C-P1.)*
- [x] **CHK-2.2** Task dependency ordering is acyclic and matches plan sequencing (schema -> port -> resolver -> backfill -> reclassify). *(C-P6.)*
- [x] **CHK-2.3** No contradiction between goals, non-goals, acceptance criteria, plan phases, and tasks. *(ANALYSIS section C "Checked — no finding".)*
- [x] **CHK-2.4** Restated content across files (scope, DAG) is consistent reinforcement, not conflicting duplication. *(C-P3, C-P4.)*
- [x] **CHK-2.5** All resolved clarifications (OQ-6, OQ-7, D3-LOCAL, D3-VERIFY, D3-RESOLVE) propagate into goals/ACs/tasks without later contradiction. *(C-P5.)*

## CHK-3 Gate discipline

- [x] **CHK-3.1** G10 is tagged on every task (boundary blocks all D3 work) and stated identically in spec/plan/tasks. *(C-P2.)*
- [x] **CHK-3.2** G3 is tagged on exactly the schema-touching tasks (T1, T2, T7) — not over- or under-applied. *(C-P2.)*
- [x] **CHK-3.3** T8 (reclassify) correctly carries G10 only, no G3 — it is documentation-only with no DDL change. *(C-P2.)*
- [x] **CHK-3.4** No G2 is claimed anywhere, and its absence is reasoned (no contract surface; `clerkJwt` rename deferred to D4). *(C-P2; spec N-3.)*
- [x] **CHK-3.5** Producer-vs-consumer is correct: D3 *consumes* G10 (producer = Orchestrator 028), does not produce it. *(spec Relation to 028; section 4.)*

## CHK-4 Evidence integrity

- [x] **CHK-4.1** E-1/E-2/E-3 each cite an exact `origin/main` file and were re-verified verbatim this session. *(ANALYSIS section A.)*
- [x] **CHK-4.2** No unverified status is asserted as fact; link/port absence is recorded as drift, not as done. *(spec Evidence basis; ANALYSIS section A.)*
- [x] **CHK-4.3** E-3 precision holds — `clerk-verifier.ts` does not call `@clerk/backend` directly; the `packages/auth` re-export is named as the real call site. *(ANALYSIS section A E-3.)*

## CHK-5 Scope containment

- [x] **CHK-5.1** D3 is the identity-link foundation only; sibling drift D1/D2/D4/D6/D8 is explicitly out of scope. *(spec N-2...N-5; ANALYSIS C-P3.)*
- [x] **CHK-5.2** D3 changes only the identity->`user_id` first hop; membership/store/eligibility and the operator/sale-sync credential are untouched. *(spec section 7; T6 note.)*
- [x] **CHK-5.3** Fail-closed-on-unmappable-subject invariant is preserved across resolver and backfill. *(C-P7.)*
- [x] **CHK-5.4** `users.clerk_user_id` is demoted, not dropped (N-7); its index/CHECK are retained. *(spec section 5; T8.)*

## CHK-6 Dispatch-readiness framing

- [x] **CHK-6.1** Every artifact (spec, plan, tasks, requirements, this checklist, ANALYSIS) carries the SPECIFY/DRAFT — NOT DISPATCHED banner. *(banners across all six files.)*
- [x] **CHK-6.2** Readiness != dispatch-authorization is stated; dispatch is conditioned on verified G10 + explicit scoped owner approval. *(ANALYSIS section D; spec gate posture.)*
- [x] **CHK-6.3** No git side effect from this review (artifacts left as working-tree files on `docs/028-followups-analyze`; nothing staged/committed/pushed). *(review process.)*
- [x] **CHK-6.4** No protected file edited — only ANALYSIS.md and this checklist were created; spec.md/plan.md/tasks.md/requirements.md unchanged. *(review process.)*

## Non-blocking notes (owner-facing, do not fail any box)

- **N-A (LOW, F-1).** Stale draft-path self-reference: spec authoring-notes + requirements.md cite `docs/specs/drafts/028-followups/...`, but the files live at `specs/029-dp2-provider-neutral-identity-link/` in Data-Pulse-2. Location-only inaccuracy; no substantive impact. Optional cleanup on next owner edit. *(ANALYSIS F-1.)*
- **N-B (LOW, F-2).** tasks.md T9 "Proves A-1...A-10" overclaims — A-10 is a draft-authoring property no post-dispatch test can prove; T9 in fact covers A-1...A-9. Prose precision only. *(ANALYSIS F-2.)*

---

## Verdict

**READY** — all CHK boxes pass; coverage complete, spec/plan/tasks mutually consistent, gates correct (G10 all, G3 on T1/T2/T7, no G2), evidence verified. Two LOW non-blocking prose notes recorded. Dispatch remains gated on **G10 verification + explicit scoped owner approval** — readiness is not dispatch-authorization.

---

> **Docs-only readiness record (SPECIFY-ONLY / DRAFT).** This checklist reviews the D3 draft only. It performs no implementation, defines no contract, creates no migration, and mutates no gate or kernel state.
