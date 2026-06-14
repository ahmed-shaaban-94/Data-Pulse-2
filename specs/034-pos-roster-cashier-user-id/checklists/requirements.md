# Specification Quality Checklist: Surface `user_id` on the POS Cashier Roster

**Purpose**: Validate specification completeness and quality before planning
**Created**: 2026-06-13
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details that pre-empt planning (the evidence basis cites real files, mirroring the shipped 033 precedent; the WHAT is a contract field, not a chosen algorithm)
- [x] Focused on the consumer value (POS-019 born-neutral provisioning; POS-017 unblock)
- [x] All mandatory sections completed (User Scenarios, Requirements, Success Criteria)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (auto-resolved from the 033 precedent + verified evidence)
- [x] Requirements are testable and unambiguous (FR-034-1..6)
- [x] Success criteria are measurable (SC-034-1..5)
- [x] Success criteria are technology-agnostic at the outcome level (a roster entry carries the neutral key; lenient/strict consumer behavior characterized)
- [x] All acceptance scenarios are defined (US1 ×3, US2 ×2)
- [x] Edge cases identified (UUID-not-secret, membership unchanged, no credential data)
- [x] Scope is clearly bounded (5 explicit non-goals)
- [x] Dependencies and assumptions identified (E-1..E-5 evidence basis; G10/G2 gate posture)

## Feature Readiness

- [x] Every FR has a clear acceptance path
- [x] User scenarios cover the primary flow (roster fetch carries `user_id`)
- [x] Measurable outcomes defined (SC-034-*)
- [x] No design lock-in beyond the verified ~4-line surfacing

## Notes

- This is the cashier-roster **sibling of 033** (which did the same for `PosOperatorSummary`). The spec auto-resolves its clarifications from 033's shipped resolutions; a `/speckit-clarify` pass is expected to be light.
- The one carried plan-phase note (mirrors 033 OQ-033-2): strict-vs-lenient consumer + contract-pin coordination. POS-Pulse validates leniently (allowlist reader), so the additive field is wire-safe; the coordination is a release-ordering detail, not a spec blocker.
- No constitution version is pinned in the spec body (DP-2 convention; the plan performs the explicit gate check).
