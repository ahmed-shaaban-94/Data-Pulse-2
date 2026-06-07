# Cross-Artifact Analysis: Sales-Posting Command Contract v1

**Feature**: 023-sales-posting-command-contract-v1 | **Date**: 2026-06-07 | **Constitution**: v3.0.1

Non-destructive consistency check across `spec.md` <-> `plan.md` <-> `tasks.md`
(with `research.md` / `data-model.md` as supporting design). No artifact was
auto-edited to resolve CRITICAL/HIGH findings — they are logged.

---

## Findings

| ID | Severity | Location | Summary | Recommendation |
|---|---|---|---|---|
| ~~F-01~~ | ~~HIGH~~ → **RESOLVED 2026-06-07** | spec sec.10 OQ-1 / Clarifications Q6 | Transport direction was the single load-bearing ambiguity. **Owner ruled 2026-06-07: connector-initiated command; genuine push REJECTED for 023.** The §IX no-outbound-HTTP invariant is preserved; the contract's auth/path design (T006) is unblocked under the connector-initiated model. No residual ambiguity. | CLOSED. The YAML may be authored under the connector-initiated model once OQ-2 (need) + the §VIII gate (T007) clear. Genuine push, if ever wanted, is a separate decision record + spec. |
| F-02 | MEDIUM | spec sec.1 / Assumptions / research provisional-need note | The whole feature is "if needed"; the concrete need is an unvalidated assumption. If no need is confirmed, the contract slice should never run. | Acceptable for a planning spec. Need-confirmation is gated (T005). Owner confirms need before authorizing T007. |
| F-03 | LOW | plan sec.Contracts / tasks T009 | The command-fetch verb (GET vs POST-to-claim) is left "decided in the contract slice." Minor under-specification. | Acceptable — both preserve the invariant; deciding at YAML-authoring time is fine. Data-model treats it as a fetch returning PostingWorkItem. |
| F-04 | LOW | data-model / spec FR-002 | The command result omits the 012 itemCursor (no cursor in a command transport). Intentional divergence from PostingWorkItem, called out in data-model but not in spec FR-002. | Optional: add a one-line note to FR-002 that itemCursor is omitted. Not blocking; data-model + research D-3 cover it. |
| F-05 | LOW | tasks T012/T013 (US2) vs US1 | US1 and US2 are both P1 / co-MVP but edit the same single file (posting-command.yaml), so sequential in practice despite "independent." | Acceptable — noted in tasks Dependencies ("shared file -> sequential"). Independence is at the story/test level, not the file level. |
| F-06 | INFO | spec FR-011 / research D-7 | snapshot_required intentionally dropped (no cursor). Could be mistaken for an omission vs 012. | Already justified in research D-7 + tasks T013. No action. |

No CRITICAL findings. **No open HIGH findings** — F-01 (transport direction) was
RESOLVED by the owner on 2026-06-07 in favour of the connector-initiated command
model (genuine push rejected), so the one §IX-adjacent risk is now decided, not
merely flagged. Post-resolution severity tally: **0 CRITICAL · 0 HIGH (1
resolved) · 1 MEDIUM · 3 LOW · 1 INFO.** No constitution conflict (all 14
principles PASS or n/a per plan's Constitution Check).

---

## Coverage: every FR mapped to >=1 task

| FR | Covered by | OK |
|---|---|---|
| FR-001 command operation | T008, T009 | yes |
| FR-002 work-item payload (O-1) | T009, T011 | yes |
| FR-003 reversal payload (O-4) | T009 (ReversalRef) | yes |
| FR-004 outcome report (O-2) | T012, T013 | yes |
| FR-005 idempotency (sec.XI, O-3) | T012, T013, T014 | yes |
| FR-006 connectorBearer auth | T008, T009 | yes |
| FR-007 scope from principal (sec.XII) | T010 | yes |
| FR-008 non-disclosing 404 (sec.II/XII) | T010 | yes |
| FR-009 money string + currency (A.6) | T011 | yes |
| FR-010 wire projections (sec.IV) | T009, T013 | yes |
| FR-011 canonical Error + closed codes | T011, T013 | yes |
| FR-012 version-independence (O-6) | T017 | yes |
| FR-013 additive, 012 untouched (sec.IV) | T016, T018 | yes |
| FR-014 no sale-fact mutation; reuse 015/017 | T015 | yes |
| FR-015 terminal-state command is safe | T012, T015 | yes (light — see note) |
| FR-016 no tender (A.5) | T018, T013 | yes |
| FR-017 conformance test, explicit dir | T008, T012, T016, T017, T019 | yes |

Note on FR-015: terminal-state safety is asserted via idempotent-state behavior in T012/T015. If the implementation slice surfaces a distinct "already terminal" response path, add a dedicated conformance assertion. Not a gap at the contract level — logged as a watch-item.

## Coverage: every user story mapped

| Story | Phase | Tasks | OK |
|---|---|---|---|
| US1 (P1, command fetch) | Phase 3 | T008-T011 | yes |
| US2 (P1, idempotent outcome) | Phase 4 | T012-T015 | yes |
| US3 (P2, additive/version-isolated) | Phase 5 | T016-T018 | yes |

## Tasks with no requirement (orphans)

| Task | Justification |
|---|---|
| T001-T004 (planning) | Spec-Kit chain scaffolding; not FR-bound by design. |
| T005-T007 (owner gates) | Map to OQ-1 + Assumptions + sec.VIII gate, not a single FR. Legitimate foundational gates. |
| T019-T021 (polish) | Cross-cutting (CI green, docs, forward notes); standard polish, not FR-bound. |

No orphan implementation task. Every [GATED] implementation task traces to an FR.

---

## Consistency spot-checks

- Auth: spec FR-006 = plan = data-model = tasks -> connectorBearer (machine, NOT clerkJwt/cookie). Consistent.
- Money: spec FR-009 = research D-3/D-7 = data-model -> DecimalAmount string + CurrencyCode, no float. Consistent.
- Idempotency: spec FR-005 = research D-4 = data-model OutcomeAckRequest = tasks T012-T014 -> required key, 200/201/409, echo on duplicate posted. Consistent.
- No new schema: spec sec.3/FR-014 = plan sec.Contracts = data-model header = tasks T015/Notes -> no DB/migration; reuse 015/017. Consistent.
- Additivity: spec FR-013/US3 = plan = tasks T016/T018 -> 012 untouched, new operationIds/path. Consistent.
- Payment Entry deferral: spec FR-016 = research D-6 = data-model Sale.posTotal note = tasks T018 -> gate A.5 holds. Consistent.

## Guardrail compliance (this planning pass)

- No file created/edited under packages/contracts/openapi/**, packages/db/**, .github/**, package.json, pnpm-lock.yaml. OK (all contract/test work is [GATED] and described, not executed).
- No code, no migration, no YAML authored. OK
- All artifacts under specs/023-sales-posting-command-contract-v1/. OK
