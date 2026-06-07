# Cross-Artifact Analysis: 019 — ERPNext live stock-view (Bin) read contract

**Feature ID**: 019 · **Date**: 2026-06-07 · **Constitution**: v3.0.1
**Scope**: Non-destructive consistency / coverage / constitution / ambiguity check
across spec.md ↔ plan.md ↔ tasks.md (with research.md + data-model.md as supporting
design). No auto-fix of CRITICAL/HIGH — findings are logged.

---

## 1. Findings table

| ID | Severity | Location | Summary | Recommendation |
|---|---|---|---|---|
| F-01 | LOW | spec FR-002 vs data-model §2.3 | Spec says the report carries a list of `{erpnextItemRef, quantity}` entries plus a read timestamp; data-model names the wrapper `BinViewSnapshotReport` with `entries[]` + `readAt`. Consistent (prose vs shape). | None — accept. |
| F-02 | LOW | tasks T010 vs FR-009 | T010 is the only `[GATED]` task; FR-009 forbids a standing mirror so there is correctly NO `[GATED]` migration task. A reader used to prior arc specs may expect a SCHEMA slice. | Accept — no-table decision is explicit in plan/data-model/R3 + tasks Notes. |
| F-03 | MEDIUM | spec FR-018 / R8 / tasks T041 | The biggest downstream consequence (sync `EMPTY_BIN_VIEW` → async report-backed run lifecycle) is correctly OUT of scope, but 019's contract is pinned-but-inert until the separate 017-rewire ships. | Accept as out-of-scope; ensure T091 names the 017-rewire follow-up. Flag to owner: contract is inert until the rewire ships. |
| F-04 | LOW | spec US3 acceptance #2 | Behavior on reporting against a superseded/stale (but in-scope) request is left to the runtime slice ("rejected or recorded-as-stale per resolved policy"), not pinned in the contract. | Accept — runtime-policy detail, deferred to T040; the contract only needs out-of-scope/absent `not_found` + idempotent replay. |
| F-05 | LOW | plan Project Structure | Lists `apps/api/src/connector/...` + the 017 processor as surfaces "touched" — but the buildable slice touches NEITHER (only YAML + conformance spec). | Accept — plan labels them future/downstream; Structure Decision restates no `packages/db` change. |
| F-06 | LOW | SC-004 | Static "zero float / valuation field" check is only verifiable once the YAML exists (T012). | Accept — T012 adds exactly this assertion inside the contract slice. |
| F-07 | INFO | spec edge case "negative DP2 on-hand" vs FR-008 | Two negatives exist (Bin-side quantity permitted; DP2-side on-hand → `negative_balance_flagged` before compare). Could confuse a reader. | Accept — research/data-model precise re 017 §6.3 ordering; consistent with the 017 `classify()` order. |

No CRITICAL or HIGH findings. No constitution conflict (design serves §IX; the only
forbidden surface is the `[GATED]` YAML, properly flagged).

---

## 2. Coverage summary

### 2.1 FR → task (every FR ≥1 task)

FR-001 → T010/T011/T012 · FR-002 → T010/T011/T012 · FR-003 → T010/T011 ·
FR-004 → T010/T030/T031 · FR-005 → T010/T013/T022 · FR-006 → T010/T020/T021 ·
FR-007 → T010/T030/T031 · FR-008 → T010/T012/T090 · FR-009 → data-model §1 (no
table)/tasks Notes/T090 · FR-010 → T010/T090 · FR-011 → T010/T090 · FR-012 →
design invariant/T090 · FR-013 → T010/T013 · FR-014 → T010/T012/T020/T021 ·
FR-015 → T010/T011 · FR-016 → T010/T031 · FR-017 → design (read-only; no write
task) · FR-018 → T041 (FUTURE)/R8. **All 18 FRs mapped.**

### 2.2 User story → task

US1 (P1 MVP) → T011–T013 (+T010) · US2 (P2) → T020–T022 · US3 (P3) → T030–T031.
Each independently verifiable via the conformance spec.

### 2.3 SC → coverage

SC-001 (017 classification) — design mapping to 017 `classify()`; contract slice
proves the shapes enable it (full proof needs the future rewire — noted, not a
contract-slice gap). SC-002/003/005 — conformance + future runtime tests. SC-004 —
T012 static check. SC-006 — design invariant. All homed.

### 2.4 Orphan check

SETUP (T001/T002), Polish (T090–T092) — cross-cutting, expected. FUTURE (T040–T042)
— labeled downstream, non-dispatchable. No task invents scope beyond the FRs.

---

## 3. Constitution conflict scan

No conflicts. Constitution-positive for §IX (no read-down look-alike) + §VIII (no
migration/dep change). The single forbidden surface (`packages/contracts/openapi/**`,
T010) is `[GATED]` and not authored in this pass. §V async-worker concern (run
lifecycle) is deferred (FR-018), not violated.

---

## 4. Verdict

**Consistent and buildable.** No CRITICAL/HIGH. The one MEDIUM (F-03) is an
acknowledged downstream dependency: 019's contract is correct but inert until the
separate 017-rewire consumes it — owner should know value is realized only when that
follow-up ships. Recommend proceeding to the `[GATED]` CONTRACT slice (T010) under
explicit approval.
