# Cross-Artifact Analysis — Console Sync-Ops Read-Model v1

**Branch**: `025-console-sync-ops-read-model-v1` | **Date**: 2026-06-07
**Scope**: non-destructive consistency check across spec.md <-> plan.md <-> tasks.md
(+ research.md, data-model.md, contracts/console-sync-ops.contract.md).

## Findings

| ID | Severity | Location | Summary | Recommendation |
|---|---|---|---|---|
| F1 | MEDIUM | spec FR-002/FR-003 <-> data-model | FRs reference 015/017 columns generically; exact source column names are not pinned (deliberately - they live in 015/017 schemas on `main`). | At implementation, bind the read queries to the actual 015/017 Drizzle selects/read helpers; verify status enum values (`permanently_rejected`) and result/run column names against the merged schema before T012/T013/T025. Not a spec defect. |
| F2 | MEDIUM | spec (020/021 deferral) <-> whole artifact | The two deferred domains (020/021) have no buildable source today; the `not_available` shape is a forward-compat stub. Risk: a future reader treats it as a built domain. | Keep the deferral explicit (it is, in spec Clarifications + Assumptions + FR-004 + research R1). When 020/021 land, a follow-up slice wires them; no breaking contract change (additive population only). |
| F3 | LOW | spec FR-013 (money pass-through) | Whether 015 posting projections actually carry a monetary amount is conditional ("if present"). | Confirm during T015/T021 whether the 015 posting-status projection surfaces an amount; if not, FR-013 is vacuously satisfied. Either way exact-decimal pass-through holds. |
| F4 | LOW | plan SS-XIII (audit) | Read-only reads are not in the constitutional auditable-events list, so v1 emits no audit on access. | Documented as an explicit non-action in the Constitution Check. If a future compliance need requires read-access auditing, raise a follow-up; not in v1 scope. |
| F5 | LOW | tasks T003 [GATED] ordering | The gated OpenAPI contract is a Phase-2 foundational task; conformance tests (T008/T016/T022) depend on it. | Correct as ordered: T003 must be approved+authored before conformance tests can pass. Flagged only to make the gate dependency explicit. |
| F6 | LOW | spec SC-005 / FR-014 | "Bounded page size" max value is not numerically fixed. | Pick a concrete default + max in the contract (T003/T004), consistent with 010/017 list defaults; not a spec-level ambiguity. |

**No CRITICAL or HIGH findings.** No constitution conflict detected (Constitution Check
in plan.md is all PASS / N-A-by-class). No contradictory requirements across artifacts.
No invented scope (gated surfaces described in prose only; no write/migration/schema).

## Coverage Summary

### FR -> task mapping (every FR maps to >=1 task)

| FR | Tasks |
|---|---|
| FR-001 (summary op) | T015 (+ T008 conformance) |
| FR-002 (posting health) | T012 |
| FR-003 (reconciliation health) | T013 |
| FR-004 (deferred `not_available`) | T014 |
| FR-005 (backlog list) | T020, T021 (+ T017) |
| FR-006 (run-history list) | T025, T026 (+ T023) |
| FR-007 (cookieAuth human-only, reject machine) | T006, T011 |
| FR-008 (tenant context / RLS fail-closed) | T007 |
| FR-009 (cross-tenant non-disclosure) | T010, T019, T024 |
| FR-010 (explicit wire shapes / envelope / operationId) | T004, T015, T021, T026 |
| FR-011 (read-only, no repair) | T017, T021 |
| FR-012 (read-through, no new table/migration) | T004, T012, T028 |
| FR-013 (money pass-through exact-decimal) | T015, T021 |
| FR-014 (cursor-paginated bounded) | T004, T018, T020, T025 |
| FR-015 (shared observability surface) | T027 |
| FR-016 ([GATED] OpenAPI contract) | T003 (+ T008/T016/T022 conformance) |

**Result**: 16/16 FRs covered.

### User story -> task mapping

| Story | Phase | Tasks |
|---|---|---|
| US1 (P1, summary) MVP | Phase 3 | T008-T015 |
| US2 (P2, backlog) | Phase 4 | T016-T021 |
| US3 (P3, run-history) | Phase 5 | T022-T026 |

All three user stories have tests + implementation and are independently testable.

### SC -> evidence mapping

| SC | Verified by |
|---|---|
| SC-001 (single summary request) | T009 |
| SC-002 (cross-tenant/store non-disclosure) | T010, T019, T024 |
| SC-003 (counts match source, no drift) | T009 |
| SC-004 (deferred = `not_available`) | T009, T014 |
| SC-005 (bounded gap-detectable pages) | T018 |
| SC-006 (auth/machine-credential rejection) | T011 |
| SC-007 (zero new migrations/tables) | T028 |
| SC-008 (contract conformance) | T008, T016, T022 |

### Orphan tasks (task with no requirement)

None. T001/T002 (setup) and T027-T030 (polish) map to cross-cutting FRs (FR-015) or
constitution gates (SC-007, SS-VI coverage); all implementation tasks trace to an FR.

## Constitution alignment

All touched principles (SS-II, III, IV, VI, VII, VIII, IX, X, XII, XIV) are PASS in
plan.md's Constitution Check. SS-IX (no-mirror) is the load-bearing invariant and is
enforced by the compute-on-read decision (research R2) + the no-new-table tasks
(T012, T028). No Complexity Tracking entry needed.
