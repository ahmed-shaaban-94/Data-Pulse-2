# Implementation Plan: Sales-Posting Command Contract v1

**Branch**: `023-sales-posting-command-contract-v1` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-sales-posting-command-contract-v1/spec.md`

**Constitution**: v3.0.1

---

## Summary

023 adds a **command-style** (per-work-item, imperative) transport for posting
DP2 sale facts (008) to ERPNext via the connector — an **additive, versioned,
parallel** alternative to the shipped 012 **pull/feed** transport (which 015
implements and which stays untouched). The connector still **initiates** the call
to a DP2-exposed endpoint, preserving the arc's no-outbound-HTTP invariant; it
addresses one specific posting work-item by reference, receives the full 008 sale
projection (with DP2-resolved ERPNext Item identity, provenance, `businessDate`),
posts it to ERPNext, and reports the outcome back idempotently. The immutable sale
fact is never mutated; only the existing 015 posting status advances, reusing the
017 DLQ + reconciliation surface.

The **deliverable of the eventual implementation chain** is a new `[GATED]`
OpenAPI YAML under `packages/contracts/openapi/erpnext-connector/` plus its
conformance test. **This planning chain authors NO code, NO YAML, NO schema, NO
migration** — it describes the gated contract in prose and sequences the work.

The single load-bearing open question (OQ-1 — genuine DP2→connector push, which
would invert §IX) was **RESOLVED by the owner 2026-06-07 in favour of the
connector-initiated command**; genuine push is rejected for 023, so the §IX
no-outbound-HTTP invariant is preserved with no residual risk.

---

## Technical Context

**Language/Version**: TypeScript 5.x (strict) on Node.js 20 LTS; pnpm workspaces.
(No code in this planning chain; this is the stack the eventual contract +
conformance test target.)

**Primary Dependencies**: NestJS 11 (api + worker), Drizzle ORM, OpenAPI 3.1 of
record, Zod for runtime validation, Jest + Supertest + Testcontainers. The
eventual conformance test reuses the non-recursive `loadOpenApiContracts` helper
(`apps/api/src/openapi/loader.ts`) with an explicit `dir`, exactly as
`posting-feed.yaml` is loaded.

**Storage**: PostgreSQL 16+ with RLS (read-only relevance — 023 reuses the
existing 015 posting-status / 017 reconciliation tables; it introduces NO new
schema). Redis 7+ / BullMQ are not in scope for the contract slice.

**Testing**: Jest structural conformance spec over the eventual YAML
(`apps/api/test/erpnext-connector/contract/…`), mirroring
`posting-feed.contract.spec.ts`. No runtime endpoint in this chain.

**Target Platform**: Linux server (DP2 api). The contract is consumed by the
external `Retail-Tower-ERP-Next-Connector` Frappe app.

**Project Type**: Web service (multi-tenant SaaS backend) — but this chain
produces **planning + a gated contract description only**.

**Performance Goals**: N/A for the contract spec. The command transport's *raison
d'être* is lower single-item posting latency vs feed-poll; concrete latency
targets are deferred to the implementation spec once the need (T005) is confirmed
(OQ-1 transport direction is already resolved → connector-initiated).

**Constraints**:
- No outbound HTTP from DP2 (the connector calls DP2). [§IX invariant]
- Money is exact-decimal string + ISO-4217 currency, never float. [gate A.6]
- Payment Entry / tender deferred (008 has no tender). [gate A.5]
- Additive only — no touch/rename/break of the 012 feed operations. [§IV]
- The contract YAML is `[GATED]`; not authored in any planning task.

**Scale/Scope**: Single new contract YAML (≈2 operations) + 1 conformance spec,
in a future `[GATED]` slice. This chain: 6 planning artifacts, 0 code files.

---

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1 design (below).*

| Principle | Applies | Assessment | Verdict |
|---|---|---|---|
| **§II Multi-Tenant / fail-closed / non-disclosure** | Yes | Command scope resolves from the `connectorBearer` principal only; cross-tenant/out-of-scope/absent `workItemRef` → identical non-disclosing `not_found`. Body scope rejected. | PASS |
| **§III Backend Authority & Money** | Yes | DP2 is the authority; it records the outcome and advances status. Money = exact-decimal string + currency (`numeric(19,4)`), never float (gate A.6) — verbatim from 012. | PASS |
| **§IV Contract-First** | Yes | The boundary is an OpenAPI 3.1 YAML of record; stable new `operationId`s; explicit wire projections (no raw DB); conformance test required; 012 feed operations untouched (no rename/version reuse). | PASS |
| **§V Async Work in Workers** | Partial | No new async work introduced by the contract; the connector's posting orchestration is its own concern. Any DP2-side projection job reuses the existing 015 worker seam. | PASS (n/a additions) |
| **§VI Test-First** | Yes | The eventual contract ships with a structural conformance test FIRST (RED→GREEN); tasks below put the conformance test ahead of/with the YAML. | PASS |
| **§VII Observable Systems** | Partial | No new metric mandated by the contract; if an implementation slice adds a command-posting counter it registers in the shared `apps/api/src/observability/metrics/api.metrics.ts` (not a per-feature file). Recorded as a forward note, not a contract obligation. | PASS |
| **§VIII Reproducible / Gated** | Yes | The contract YAML lives under the `[GATED]` `packages/contracts/openapi/**` surface. This chain describes it; the YAML is authored only in an approved `[GATED]` slice. No `package.json`/lockfile/migration touched. | PASS |
| **§IX Source-of-Truth / immutable facts** | Yes | Sale fact (008) never mutated; only 015 posting status advances; reversals are new reversing documents, never edits (O-4). The no-outbound invariant is preserved; the inversion (genuine push) was considered as OQ-1 and **REJECTED by the owner 2026-06-07** — connector-initiated only. | PASS |
| **§X Retail Temporal** | Yes | `businessDate` drives ERPNext `posting_date`; `recordedAt` is the server clock; void/refund modeled as separate reversal work-items. | PASS |
| **§XI Idempotency & External IDs** | Yes | Outcome report requires `Idempotency-Key` (existing interceptor); replay/echo/conflict semantics reused; `sourceSystem + externalId` provenance carried. No new primitive. | PASS |
| **§XII Authorization & Object Safety** | Yes | IDs/scope from server-side principal; mass-assignment ban; strict body (`additionalProperties: false`); default-deny auth; safe 404 cross-tenant. | PASS |
| **§XIII Auditability & Provenance** | Yes | Provenance (`sourceSystem`, `externalId`, `payloadHash`) carried on the work-item; outcome recording reuses the existing 015 audit/status path. | PASS |
| **§XIV PII & Data Lifecycle** | Yes | The command surface exposes no PII beyond the 012 sale projection already on the wire; single-region posture inherited; no credentials in any body. | PASS |

**Result: PASS, no violations.** Complexity Tracking below is therefore empty.
The one §IX-adjacent risk (genuine push) is NOT taken; OQ-1 was **RESOLVED by the
owner 2026-06-07 → connector-initiated**, and genuine push (which would have
required its own decision record + likely a separate spec) is rejected for 023.

### Re-check after Phase 1 design

The data-model (no new entities — all shapes reuse 012) and the prose contract
description (Phase 1) introduce no new principle exposure. Constitution Check
**remains PASS**.

---

## Project Structure

### Documentation (this feature)

```text
specs/023-sales-posting-command-contract-v1/
├── spec.md          # Feature spec (clarified)
├── plan.md          # This file
├── research.md      # Phase 0 — decisions + rationale + alternatives
├── data-model.md    # Phase 1 — entities, fields, relationships, RLS posture
├── tasks.md         # Phase 2 — dependency-ordered tasks ([GATED] flagged)
├── analysis.md      # Cross-artifact consistency analysis
└── review.md        # Self-review
```

No `quickstart.md` (no runnable surface in this planning chain).

### Source Code (repository root) — the eventual implementation targets (NOT created here)

```text
packages/contracts/openapi/erpnext-connector/
├── posting-feed.yaml            # 012 — EXISTING, READ-ONLY, untouched by 023
└── posting-command.yaml         # 023 — [GATED] future artifact (DESCRIBED in prose only)

apps/api/test/erpnext-connector/contract/
├── posting-feed.contract.spec.ts        # 012 — existing
└── posting-command.contract.spec.ts     # 023 — future conformance test (DESCRIBED only)

apps/api/src/openapi/loader.ts            # existing non-recursive loader (reused as-is)
```

**Structure Decision**: 023 lives entirely under
`specs/023-sales-posting-command-contract-v1/` for this chain. The eventual gated
contract sits beside `posting-feed.yaml` in the existing
`erpnext-connector/` contract directory; its conformance test sits beside the
existing `posting-feed.contract.spec.ts`. No new package, module, or directory is
introduced.

---

## Contracts (described in prose — the `[GATED]` artifact is NOT authored here)

The eventual `[GATED]` `packages/contracts/openapi/erpnext-connector/posting-command.yaml`
(OpenAPI 3.1) will define, on the new path segment
`/api/connector/v1/erpnext/commands` (distinct from the 012 feed's
`/api/connector/v1/erpnext/postings`), at minimum:

- **`connectorExecutePostingCommand`** (GET `…/commands/{workItemRef}`, or POST if
  the command must be acknowledged as "claimed" — decided in the contract slice):
  returns the full `PostingWorkItem` payload (sale projection + resolved
  `erpnextItemRef` per line + provenance + `businessDate` + `kind` +
  optional `reversalOf`) for one scope-bound work-item. `connectorBearer` auth.
  Non-disclosing `not_found` for cross-tenant/absent refs.
- **`connectorAckPostingCommand`** (POST `…/commands/{workItemRef}/outcome`):
  reports `posted` (+ `documentRef`) / `failed_transient` /
  `permanently_rejected` (+ `reason`). REQUIRED `Idempotency-Key`; 200-replay /
  201-fresh / 409-conflict; duplicate `posted` echoes the existing `documentRef`.
  Reuses the 012 `OutcomeAckRequest` / `RecordedOutcome` shapes.

Schemas reused **verbatim** from `posting-feed.yaml` (copied per the
self-contained-per-file convention, not cross-`$ref`'d): `DecimalAmount`,
`CurrencyCode`, `PostingWorkItem`, `Sale`, `SaleLine`, `ReversalRef`,
`ErpnextDocumentRef`, `ErpnextItemRef`, `RejectionReason`, `EtaStatus`,
`OutcomeAckRequest`, `RecordedOutcome`, `Error`. Closed `error.code` set on this
surface: `validation_failure`, `idempotency_key_conflict`, `not_found`,
`system_failure` (plus the generic 401). NO `snapshot_required` (no cursor in a
command transport).

**No DB schema / migration** is part of 023: the work-item, posting status, and
DLQ/reconciliation state are owned by 015 (and 017) and reused as-is. (Had OQ-1
resolved toward genuine push — it did not; the owner rejected it 2026-06-07 — a
callback-registration schema and an outbound-egress posture would have been
required; that is explicitly out of this spec and would need its own decision
record + `[GATED]` slices.)

---

## Complexity Tracking

*Empty — Constitution Check passed with no violations.* 023 introduces no new
project, no new pattern, no new primitive: it reuses the 012 transport vocabulary
and the 015/017 state. The only added concept (a command/imperative addressing of
one work-item) is a thin alternative path, justified by the "if needed" handoff
and gated on a confirmed need (Assumptions; T005 need-confirmation). Transport
direction (OQ-1) is already resolved → connector-initiated.
