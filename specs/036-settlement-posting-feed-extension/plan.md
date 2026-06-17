# Implementation Plan: DP-012 Posting-Feed Settlement Extension

**Branch**: `036-settlement-posting-feed-extension` | **Date**: 2026-06-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/036-settlement-posting-feed-extension/spec.md`

> **Gated-boundary note.** Authored under Orchestrator decision **AD-SALE-SETTLEMENT-3 (RATIFIED Option A)**: **spec-level only.** This plan describes the *approach and design intent* for the extension; it does **NOT** author the `posting-feed.yaml` schema, any DTO, migration, or projection runtime. Phase-1 design artifacts here stay at the requirements/contract-*intent* level. `contracts/` is intentionally **not** populated with OpenAPI in this feature (see Project Structure). Authoring the contract surface + implementation are separate, gated, separately-approved steps.

## Summary

Extend the shipped DP-012 posting-feed (`posting-feed.yaml`) with an **additive, versioned, backward-compatible** `PostingWorkItem` kind for **settlement Payment-Entry postings**, so the connector can be told "post the Payment Entry for this approved 035 settlement" through the existing `connectorPullPostings` feed. The extension carries a self-sufficient settlement payload (payer/debtor ref, amount+currency, business date, receivable/sale provenance, target ERP Sales-Invoice ref, idempotency anchor), is projected only from **approved** 035 settlement events, and **fails-to-DLQ** when unresolvable. It satisfies **gate #2 of the SIGNED `011-DR-POSTING-R1`** — but does **not** lift R1.

## Technical Context

**Language/Version**: TypeScript (NestJS API), per existing DP-2 stack.

**Primary Dependencies**: Existing 012 posting-feed transport (`connectorPullPostings`/`connectorAckOutcome`, `connectorBearer`); 035 settlement model (`apps/api/src/settlement/`); the 015 posting-feed projection + DLQ machinery; the 008 sale projection (work-item already mirrors it).

**Storage**: PostgreSQL (existing). The settlement state + receivable live in migration `0027` (035). **No new migration is authored in this feature** (gated).

**Testing**: Contract-conformance (the 012 conformance suite precedent — 28/28), projection/integration tests, backward-compat assertions. **Authored as task descriptions, not code, in this feature.**

**Target Platform**: Linux server (DP-2 API).

**Project Type**: web-service (backend contract extension).

**Performance Goals**: Feed pull latency unchanged from current 012 (additive payload; no new round-trips). N/A new perf budget.

**Constraints**: Additive/backward-compatible (no breaking change to a pilot-relied-upon feed); fail-closed projection; exact-decimal money; multi-tenant RLS fail-closed; no credentials/`tenant_id` on the wire.

**Scale/Scope**: One new work-item kind + its payload + projection rule + DLQ path + conformance coverage. Connector-009 (consumer) is out of scope.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Reference, not source of truth** — N/A (no legacy carry-over).
- **II. Multi-tenant by default** — PASS (intent). Settlement work-items are tenant-scoped server-side; the wire carries **no `tenant_id`** (implicit in the authenticated `connectorBearer` scope), consistent with existing work-items. Projection reads 035/receivable rows under RLS (fail-closed). No cross-tenant disclosure.
- **III. Backend authority & data integrity (NON-NEGOTIABLE)** — PASS (intent). Settlement is DP-2-authoritative; the connector posts only an **approved** command (AD-1 §D6). **Money MUST use exact-decimal `numeric(p,s)`** — the settlement amount on the wire MUST preserve the 035 exact-decimal representation; no float. Idempotency anchor guarantees exactly-one Payment Entry (no last-write-wins on financial postings).
- **IV–VIII / IX–XIV** — addressed at design level in research.md; the financially-relevant gates (money representation, idempotency, fail-closed projection, no-PII-on-wire) are the load-bearing ones and are honored by the requirements.
- **Gated-boundary self-check** — PASS: this plan authors no OpenAPI/migration/runtime; it stops at design intent. R1 not lifted.

**Result: PASS (spec-level).** No constitution violations; the only "deferral" (contract + impl) is an *intentional gate*, not a violation — recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/036-settlement-posting-feed-extension/
├── spec.md              # /specify output (DONE)
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + R1 gate-#1/#4 scoping (requirements level)
├── data-model.md        # Phase 1 — settlement work-item FIELDS described (NOT schema/YAML)
├── quickstart.md        # Phase 1 — how a consumer/conformance test would exercise it
├── contracts/           # INTENTIONALLY EMPTY this feature — OpenAPI authoring is the gated step
└── tasks.md             # /tasks output (separate step)
```

### Source Code (repository root)

When (separately) implemented, the extension touches existing DP-2 surfaces — no new top-level structure:

```text
packages/contracts/openapi/erpnext-connector/
└── posting-feed.yaml          # [GATED — NOT authored here] the additive kind + payload

apps/api/src/
├── settlement/                # 035 — the projection SOURCE (approved settlement event)
└── catalog/ (posting-feed projection + DLQ)   # where the new work-item is projected/failed-closed

packages/db/drizzle/
└── [GATED — no new migration in this feature]

tests/
├── contract/   # 012 conformance extended (backward-compat + new kind)
└── integration/ # projection + fail-to-DLQ + idempotency
```

**Structure Decision**: Reuse the existing 012/015 posting-feed + 035 settlement surfaces; the extension is additive within them. No new module or transport (consistent with 023's "reuse 012 vocabulary"). Concrete file authoring is gated and out of scope here.

## Complexity Tracking

> Filled because the Constitution-Check "deferrals" are intentional gates that must be justified as deliberate, not as shortcuts.

| Violation / Deferral | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Contract (`posting-feed.yaml`) + runtime + migration **not authored in this feature** | AD-SALE-SETTLEMENT-3 Option A gates contract authoring + implementation behind separate owner approval; R1 (SIGNED) gates the posting itself | Authoring the schema now would cross the no-OpenAPI gate and pre-empt the owner's R1-lift decision — a stop-condition, not a simplification |
| R1 gate #1 (035-fitness) and #4 (payment recon) only **scoped**, not resolved | They are owner/DP-2 decisions feeding the R1 lift; this feature surfaces them, doesn't decide them | Resolving them here would assert an unratified R1 lift |
