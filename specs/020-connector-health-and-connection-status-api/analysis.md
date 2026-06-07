# Cross-Artifact Analysis — 020 Connector Health and Connection-Status API

Non-destructive consistency + coverage analysis across `spec.md`, `plan.md`, `research.md`, `data-model.md`, `tasks.md`. Date: 2026-06-07. No artifact was modified by this analysis; findings are logged, not auto-fixed.

## Findings

| ID | Severity | Location | Summary | Recommendation |
|----|----------|----------|---------|----------------|
| F1 | LOW | spec FR-017 / tasks T026 / plan §XIII | Heartbeat deliberately writes NO per-beat audit row (cardinality), but the constitution lists "action that crosses a trust boundary" as auditable. A heartbeat does cross the machine↔SaaS boundary. | Accept as designed: §XIII permits bounded discretion; per-beat audit is high-cardinality telemetry, already observable via the counter + `last_seen_at`. Optional future: a single audit on the FIRST-ever heartbeat per registration (`never_seen→seen`). Not a v1 blocker. |
| F2 | LOW | data-model "Tenant-consistency note" | The `connector_health.tenant_id = connector_registration.tenant_id` invariant is enforced by guard-derived write + RLS, not a DB CHECK/trigger in v1. | Consistent with 018's own DEFERRED consistency-CHECK precedent. Document as a known follow-up; the application path makes a mismatch unreachable. No change. |
| F3 | LOW | data-model row lifecycle (CASCADE) vs FR-016 | Health row is `ON DELETE CASCADE` on the registration, but FR-016 requires a disabled registration's health to remain readable. | No conflict: 018 registrations are logically disabled (`disabled_at`), not row-deleted, so the health row persists (FR-016 holds). CASCADE only fires on rare hard-delete. Data-model already states this. No change. |
| F4 | MEDIUM | research D6 / spec Q6 / FR-018 | The currently-stale gauge is deferred; no v1 metric proves a connector went dark (only `connector_heartbeat_total`). Per-instance dark-detection requires polling the P1 read. | Acceptable for v1 (operator read covers per-instance verdict; counter covers platform-wide liveness). Proactive dark-ALERTING is explicitly NOT v1 — it is the named scheduled-sweep follow-up (rhymes with 029). Spec assumptions + research D9 already state this. |
| F5 | LOW | tasks T004/T005 migration number `00NN` | Migration number is a placeholder (expected `0022`) pending `main` state at gate time. | Correct for a no-implement pass; the gate-time task confirms the real number. Carried in research "Open items." No change. |
| F6 | LOW | spec FR-013 / data-model `source_clock_at` | `source_clock_at` is OPTIONAL provenance, never used for the verdict. Risk a future implementer treats it as authoritative. | Already guarded by FR-009 + §X; `deriveLiveness` takes only `last_seen_at`, structurally preventing misuse. No change. |
| F7 | LOW | tasks T028 (US3) overlaps T014/T015 (US1) | US3 detail read is largely delivered by US1's `getHealth`; US3 risks being a near-empty phase. | Intentional — US3 is a thin P3 drill-down over the same read-model; T027/T028 harden the detail projection + test. Keeping it a distinct testable slice is fine. No change. |

**No CRITICAL or HIGH findings.** No constitution conflict (all touched principles PASS; the single LWW deviation is justified in plan Complexity Tracking). No contradictory requirement across artifacts.

## Coverage Summary

### Every FR mapped to >=1 task?

| FR | Task(s) | Covered |
|----|---------|---------|
| FR-001 | T010, T013, T014, T015 | yes |
| FR-002 | T007, T008, T014 | yes |
| FR-003 | T027, T028 | yes |
| FR-004 | T009, T013 | yes |
| FR-005 | T011, T015 | yes |
| FR-006 | T011, T014 | yes |
| FR-007 | T020, T025 | yes |
| FR-008 | T019, T023, T024 | yes |
| FR-009 | T018, T024 | yes |
| FR-010 | T017, T023 | yes |
| FR-011 | T022 | yes |
| FR-012 | T021, T024 | yes |
| FR-013 | T007, T023 | yes |
| FR-014 | T003, T004, T012 | yes |
| FR-015 | T003, T013 | yes |
| FR-016 | T007/T008, T014 | yes |
| FR-017 | T026 | yes |
| FR-018 | T029 | yes |
| FR-019 | T016, T026 | yes |
| FR-020 | T006, T009, T017 | yes |

**All 20 FRs mapped.**

### Every user story mapped?

- US1 (P1 operator read) -> T009-T016
- US2 (P2 heartbeat) -> T017-T026
- US3 (P3 detail) -> T027-T028

### Every Success Criterion traceable?

SC-001->T010/T013; SC-002->T008/T010; SC-003->T018/T020; SC-004->T011/T019/T020; SC-005->T022; SC-006->T012; SC-007->T030. All 7 mapped.

### Any task with no requirement?

T001/T002 (setup) + T031/T032 (polish/perf) are infrastructure/cross-cutting (expected, no 1:1 FR); T029->FR-018, T030->SC-007. No orphan task carries unjustified scope.

## Conclusion

The artifact set is internally consistent and fully covers the spec. No CRITICAL/HIGH findings; the seven LOW/MEDIUM findings are design-acknowledged (per-beat audit omission, app-enforced tenant consistency, deferred dark-alerting) and consistent with arc precedent (018). Ready for the gate-approval + implementation phase.
