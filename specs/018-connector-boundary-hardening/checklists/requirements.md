# Specification Quality Checklist: Connector Boundary Hardening v1

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation Notes (iteration 1)

- **No implementation details**: spec deliberately uses domain language — "connector instance", "machine credential", "raw secret returned once", "non-disclosing rejection". No table names, columns, ORM, HTTP verbs, or framework names. The technical decisions (the `connector_registration` table, the `auth_tokens` FK, the DB unique-on-unrevoked invariant, the guard) live in the brainstorm design doc and resurface at `/speckit-plan`, not here. PASS.
- **No [NEEDS CLARIFICATION] markers**: the three genuinely-forkable decisions are captured as **Open Questions (carried to planning)** with stated v1 defaults, not as in-line blockers — consistent with the spec-kit "informed defaults, document assumptions" rule. They are scope/security decisions with reasonable defaults, so they do not block the spec. PASS.
- **Testable/unambiguous**: each FR is a single MUST with an observable outcome; the at-most-one-active and atomic-rotation invariants (FR-008/009/010) and the non-disclosing-enforcement set (FR-015/016) map directly to acceptance scenarios in US2/US4 and to SC-003/004/005.
- **Measurable + tech-agnostic SCs**: SC-001..008 are stated as user/operator-observable outcomes (e.g. "old credential rejected on the very next request", "no raw secret retrievable afterward") with no system-internal metrics.
- **Scope bounded**: negative requirements FR-025/026/027 + the Out of Scope section fence the feature against 019/020/023/016/029 and the connector repo.

## Result

All items pass on iteration 1. Spec is ready for `/speckit-plan`.

## Clarification (Session 2026-06-06)

`/speckit-clarify` run; 3 questions asked + answered (recommended option accepted for all):
- Site uniqueness → ENFORCED on (tenant, environment, ERPNext site ref) — FR-005a, SC-009.
- Credential expiry → 90-day default, operator-overridable up to a max ceiling, never unbounded — FR-012, SC-010.
- Lifecycle observability → unlabeled lifecycle counter on the shared metrics surface, in addition to audit — FR-022a, SC-011.

Two open questions remain CARRIED to planning (genuinely plan-time / preflight-dependent, not blockers): administrative surface form (REST-gated vs CLI), legacy-credential handling (preflight stop-and-raise). All checklist items remain PASS after integration.
