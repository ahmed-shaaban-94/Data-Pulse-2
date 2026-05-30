# Specification Quality Checklist: Sales / Transaction Capture

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-30
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

## Notes

**Altitude note for a capture/ingestion feature.** 008 is the first feature to model a sale fact, so the *behavior of capturing and preserving a sale* is intrinsic WHAT, not implementation: "the line snapshot MUST be frozen at capture," "void/refund MUST be separate terminal events, never in-place mutation," "POS totals MUST be preserved as received," and "ingestion MUST be idempotent on `sourceSystem + externalId`" are behavioral obligations the constitution (§IX/§X/§XI) mandates. The checklist's "no implementation details" item is satisfied by holding back the **HOW**: the spec authors no DB/Drizzle schema, no SQL migration, no index/RLS DDL/CHECK constraint, no OpenAPI YAML, no path strings/HTTP methods/status codes/field names, and no NestJS/Zod/Postgres/Redis references (§12 Out of Scope reaffirms each). Entity names (`sales`, `sale_lines`, void/refund terminal events) are **domain nouns defined in Key Entities**, not storage or wire artifacts — they describe what is captured, not how it is stored or transported. Those HOW choices land in `plan.md` / `tasks.md` and the `[GATED]` `packages/contracts/openapi/**` + migration artifacts.

**Discrimination from 005.** 005 captures *unknown-item references* into `unknown_items` during a sale but models no sale. 008 earns its keep by modeling the **sale fact itself** — the invoice header + line snapshots + void/refund terminal events + provenance + temporal catalog — building **alongside** 005's proven POS ingestion seam (its `sourceSystem + externalId` dedup + idempotency-token contract), consuming those semantics unchanged rather than re-inventing ingestion.

**Gate-deferred decisions are not spec gaps.** Six+1 owner decisions (transaction money/tax/rounding, per-entity timestamp nullability, payload-hash algorithm, per-tenant bulk-sync bound, concurrency ratification, and sale-fact classification/retention) are routed to the **Money + Temporal Decision Gate** (`gate-money-temporal.md`) and tracked as §11 Open Questions OQ-1..OQ-7. These are constitution Follow-up TODOs (#1/#2/#3/#6/#7), intentionally owner-owned, not `[NEEDS CLARIFICATION]` ambiguities in the behavioral contract. The spec fixes the obligations (money is exact-decimal+currency, the timestamp field set, that a payload hash is retained); the gate fixes the open parameters. The spec is plan-ready in the sense that its WHAT is complete; `/speckit-plan` is additionally gated on the owner closing the decision gate.

**Validation result**: All items pass on the first iteration (no `[NEEDS CLARIFICATION]` markers; mandatory sections complete; SCs measurable + technology-agnostic; scope bounded by §0/§3/§12; dependencies + assumptions in §9/§10). The spec is ready for `/speckit-clarify` (optional — the material decisions are consolidated in the decision gate rather than as inline ambiguities) or `/speckit-plan` (after the gate is resolved).
