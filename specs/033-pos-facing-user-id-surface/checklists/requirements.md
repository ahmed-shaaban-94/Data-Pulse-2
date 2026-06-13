# Spec-Quality Checklist: 033 — POS-facing `user_id` surface

**Purpose**: `/speckit-analyze` input. Each item is checked against spec.md / plan.md / tasks.md.
**Date**: 2026-06-13

## Requirement quality

- [x] Every FR is testable and unambiguous (FR-033-1..6 each map to a concrete code/contract assertion).
- [x] Every SC is measurable (SC-033-1..5 are assertable in a test or by diff inspection).
- [x] No vague adjectives ("robust", "fast") left unquantified.
- [x] Scope boundary explicit (N-033-1..5 enumerate non-goals).

## Coverage

- [x] Every FR is referenced by ≥1 task (verified: FR-033-1..6 all present in tasks traceability matrix).
- [x] Every SC is referenced by ≥1 task (verified: SC-033-1..5 all present).
- [x] No task exists without a requirement justification (T0–T6 each cite FR/SC).
- [x] Both carried OQs (OQ-033-1, OQ-033-2) are resolved in plan.md to plan-level decisions.

## Consistency (cross-artifact)

- [x] Terminology canonical across spec/plan/tasks: `user_id` (= `users.id`, §16 neutral key) vs `id` (= `clerk_user_id`, v1 bridge).
- [x] Edit-surface anchors in plan.md match tasks.md (L385/L498/L568; `PosOperatorSummaryBody`; `PosOperatorSummary` schema).
- [x] **C1 — Status vs footer contradiction (MEDIUM)**: spec.md Status said PLANNING/authorized while the footer still read "STOP — SPECIFY phase boundary … no plan.md/tasks.md authored." → **RESOLVED**: footer rewritten to "Materialize Stop Gate — CLEARED" (spec.md `## Gate posture` footer), consistent with the Status line.
- [x] G10 posture consistent: spec Status, plan §G10, and tasks T0 all describe the same re-verify result.

## Review findings (independent adversarial pass, 2026-06-13)

- [x] **R-MED — `additionalProperties: false` breaks the naive backward-compat claim**: `PosOperatorSummary` (contract L410) closes the object; a strict consumer validating the old pinned schema rejects `user_id`. → **RESOLVED**: SC-033-3 + User Story 2 split into lenient/strict legs; plan §OQ-033-2 reworked to a coordinated pin-pair decision; T1 carries the coordination note; T4 US2 rewritten to validate against the real old schema (not a lenient hand-rolled pick). **Open input for dispatch**: confirm POS-Pulse validation mode (strict vs lenient).
- [x] **R-LOW — schema description goes stale**: `PosOperatorSummary` description (L411–415) lists only 5 fields. → **RESOLVED**: folded into T1 step 3 (update description to include `user_id`).
- [x] **R-INFO — dangling "analyze report" reference**: the checklist cited a non-existent analyze-report artifact. → **RESOLVED**: this section now records the analyze + review outcomes inline; no separate report file is produced for a docs-only chain.
- [x] **Core technical claims verified by reviewer against real code**: exactly three `signed_in` emit-sites (no missed fourth); replay path has `userRow.id` in scope with null envelope; `UserLookupRow.id` is non-null `string` so `required` is safe; no migration/envelope/resolution change; L385/L498/L568 anchors accurate.

## Constitution alignment

- [x] §IV contract-first honored (T1 contract is a first-class task, not an afterthought).
- [x] §VIII gated-path isolated (only T1 is `[GATED]`; runtime tasks are not).
- [x] §IX read-not-mutate (no authority handover; surfaces existing value).
- [x] §XII / §XIV object-safety + PII discipline (outbound-only UUID, not a secret/credential).

## Implementation readiness

- [x] A fresh agent could execute T1–T6 cold from the briefs (exact files + anchors + MUST-NOTs given).
- [x] TDD ordering explicit (T4 RED-first before T3 lands; or RED against pre-T3 code).
- [x] No migration implied anywhere (FR-033-6 / SC-033-4 cross-checked in T0 + T5).
