# Implementation Plan: POS Sale Capture / Sync-Status / Idempotency Contract

**Branch**: `chain/032-sale-capture-sync-planning` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/032-pos-sale-capture-sync-status-and-idempotency-contract/spec.md`

> **SPECIFY-ONLY planning artifact.** This plan describes architecture and approach. It authors **no** OpenAPI YAML, **no** SQL/migration, **no** service/worker code. `contracts/` and `data-model.md` in this folder are planning **prose** describing the intended surface — the actual `sales.yaml`, migration `0025`, and service code are produced by a separate, owner-gated DP-2 implementation slice (spec §11, §12). The four §13 owner decisions remain OPEN and are NOT resolved here.

## Summary

Plan the Data-Pulse-2 server leg for a captured POS sale: receive → dedup → assign a server-authoritative status → classify sync failures for retry vs. operator repair, and expose a read/repair surface the later Console consumes. DP-2 is the contract/orchestration boundary (POS → DP-2 → Connector → ERPNext); it never posts to ERPNext from this slice and never decides tender settlement (no server settlement endpoint exists — F-2). The build reuses what already ships: L2 atomic dedup is LIVE (F-4, pin, do not rebuild), `sale.captured` is already registered (F-5, verify the producer binding, do not re-register). The genuine gaps are the **read side** (server-authoritative sync-status), the **failed-sync classification** surface, and a **server-mediated repair/retry** op — all VERIFIED-ABSENT today (F-1).

The technical approach follows the spec's own ordering: capture contract (§6) on top of live L2 dedup + an engaged L1 Idempotency-Key seam; a persisted server-authoritative status (§7); a refusal taxonomy + dead-letter classification bound to 028 (§8); and a generated-client read/repair surface (§9). First slice on owner approval is spec §11 items **3 + 7** (status + read surface) because it unblocks the Console lane independent of the OPEN AlreadyApplied-422 decision.

## Technical Context

**Language/Version**: TypeScript (Node.js) — matches the shipped `apps/api/src/catalog/sales/` capture stack. Exact runtime version is a repo invariant, re-verified at dispatch; not re-decided here.

**Primary Dependencies**: Existing DP-2 API framework + worker/outbox infrastructure (`OUTBOX_EVENT_TYPES`, the live two-layer idempotency in `sales/`), PostgreSQL with RLS, the platform `idempotency_keys` mechanism (Constitution "Idempotency & External IDs" — the L1 seam to engage). No new third-party dependency is introduced by this plan.

**Storage**: PostgreSQL (source of truth; `TIMESTAMPTZ` UTC). New persisted server-authoritative sale-status + any dead-letter/quarantine state land in migration slot **`0025`** (next-free, re-verified at dispatch — §2 pins `0024_pairing_codes` as current head). The migration itself is authored by the implementation slice under Principle VIII approval, NOT here.

**Testing**: Contract tests against `sales.yaml` §12 ops (OpenAPI conformance, Principle IV/VI); integration tests on real Postgres (Testcontainers) for tenant + store isolation, RLS bypass probe, cross-tenant/cross-store sweeps; idempotency replay tests (L1 + L2 → no duplicate); dead-letter/NEEDS_REPAIR classification tests. Tests authored by the implementation slice (test-first), enumerated here as task intent only.

**Target Platform**: Linux server (DP-2 multi-tenant SaaS backend).

**Project Type**: Web service (backend API + background workers). No frontend in this slice — the Console sync-ops UI is later/downstream and consumes the generated client.

**Performance Goals**: Capture stays request-synchronous for validation/authorization/dedup/status-write; any downstream forwarding is a worker concern (Constitution Principle V). Specific p95/throughput targets are an implementation-slice concern; not invented here.

**Constraints**:
- Architecture invariant: POS → DP-2 → Connector → ERPNext. No POS→ERPNext, no Console→ERPNext, no ERPNext fork. DP-2 is the contract boundary.
- SPECIFY-ONLY: no OpenAPI/migration/code authored in this plan.
- Must NOT regress the live provenance-conflict `409` (`TerminalEventProvenanceConflictError`).
- Must NOT invent a `payments.confirm`/`settled_at` server settlement endpoint (F-2).
- Must NOT re-register `sale.captured` (F-5).
- Must NOT rebuild the live L2 `ON CONFLICT … DO NOTHING` dedup (F-4).

**Scale/Scope**: One tenant's POS fleet writing captures; read/repair surface scoped per tenant + store. Scope is the DP-2 server leg only (capture / sync-status / idempotency / refusal / dead-letter / read+repair). Excludes tender settlement, Connector posting logic, Console UI, and any 028 auth re-decision.

### NEEDS CLARIFICATION (carried as OPEN owner decisions — NOT resolved in this plan)

These are the spec §13 owner decisions. The plan is intentionally written so the first slice (items 3 + 7) does not depend on any of them.

1. **AlreadyApplied 422 vs keep-409** (F-3): distinct `422` for genuine already-applied replay vs. keeping the live `409`, without regressing provenance-conflict `409`. → Plan keeps `409` live everywhere and treats `422` as an additive, owner-gated path (spec §11 item 5), sequenced AFTER the read/status slice.
2. **L1 Idempotency-Key engagement scope**: capture-only vs. all POS write ops. → Plan engages L1 on capture only as the documented seam; broadening to all write ops is deferred to the owner.
3. **Repair authority**: Console-mediated only, no POS-local override v1. → Plan models repair as a server-mediated, audited op that acts only on DP-2-classified NEEDS_REPAIR; no POS-local override path is designed. Final authority confirmation deferred to owner (029 Q11 / 028 OQ-2 OPEN).
4. **`sales.yaml` ops contract-first vs. alongside service work**: → Plan describes the contract surface as prose; whether the YAML is authored first or alongside code is an owner decision, NOT fixed here.

## Constitution Check

*GATE: SPECIFY-ONLY plan. No code/contract/migration is authored, so no principle is violated by this artifact. The table records the principles the eventual implementation slice MUST satisfy, mapped to spec sections.*

| Principle | Relevance to this feature | Posture in this plan |
|---|---|---|
| II. Multi-Tenant SaaS by Default | Capture, status, read/repair are all tenant + store scoped; RLS fail-closed | Read/repair surface scoped per tenant+store; cross-tenant lookups use safe-404; honored, not re-decided |
| III. Backend Authority & Data Integrity | DP-2 owns authoritative status; uniform error envelope; money preserved as received | Persisted server-owned status; POS never overrides; uniform `{error:{code,message,request_id}}`; no rewrite of POS totals |
| IV. Contract-First POS Integration | Capture + read/repair are POS/Console-facing; `sales.yaml` §12 is source of truth | Contract described as prose here; YAML authored by slice; stable `operationId`; no raw DB entities |
| V. Async Work Belongs in Workers | `sale.captured` drain + dead-letter classification are worker concerns | Producer emits in-transaction; drain advances status; dead-letter surfaces, never silent drop |
| VI. Test-First Quality | Contract + isolation + idempotency + dead-letter tests | Enumerated as task intent (test-first); authored by slice |
| VIII. Reproducible & Versioned Releases | Migration `0025`; `sales.yaml` versioning | Approval-gated; migration + YAML NOT authored here |
| IX. Source-of-Truth Model | SaleLine snapshot is invoice truth; provenance preserved | Status is a server projection over the sale fact; provenance (028) preserved in dead-letter |
| X. Retail Temporal Semantics | `occurredAt`/`receivedAt`/`processedAt`; void/refund modeled separately | Status transitions stamped on server clock; terminal events not mutated |
| XI. Idempotency & External IDs | L1 Idempotency-Key + L2 `(tenant, source_system, external_id)` | L2 LIVE (pin); L1 engaged on capture; replay → prior response, no double-apply |
| XII. Authorization & Object Safety | 401/403 bound to 028; mass-assignment forbidden; default-deny | Refusal taxonomy binds 028 by reference (G10); repair acts only on DP-2-classified NEEDS_REPAIR |
| XIII. Auditability & Provenance | Dead-letter preserves provenance; repair is audited | Never silent drop; repair op audited; correlation/audit timeline exposed read-only |

No Complexity Tracking entries — this plan introduces no constitution violation requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/032-pos-sale-capture-sync-status-and-idempotency-contract/
├── spec.md              # Merged spec (clarify session appended 2026-06-12)
├── plan.md              # This file (/speckit-plan output) — SPECIFY-ONLY
├── research.md          # Phase 0 output — decisions/rationale (prose)
├── data-model.md        # Phase 1 output — entity/status PROSE (no SQL, no migration)
├── quickstart.md        # Phase 1 output — verification narrative
├── contracts/           # Phase 1 output — surface PROSE (no OpenAPI YAML)
│   └── README.md        # Describes the §6/§9 surface as prose; the real sales.yaml is slice-authored
└── tasks.md             # Phase 2 output (/speckit-tasks) — ordered, NOT dispatched
```

### Source Code (repository root) — described, NOT authored here

The implementation slice (separate, owner-gated) is expected to touch, under DP-2 review and single-writer serialization on the sale files (spec §11):

```text
apps/api/src/catalog/sales/      # capture (LIVE) + L1 engagement, status field, refusal wiring, dead-letter classification
apps/api/src/.../workers/        # sale.captured drain consumer + dead-letter/NEEDS_REPAIR quarantine
packages/contracts/openapi/sales.yaml   # §12 contract ops (slice-authored; owner decision on timing — §13)
<migrations>/0025_*              # server-authoritative status + dead-letter schema (slice-authored, Principle VIII approval)
```

**Structure Decision**: This slice extends the existing `apps/api/src/catalog/sales/` module and its worker/outbox infrastructure rather than introducing a new bounded context — capture already lives there with live two-layer idempotency, and the status/read/repair gaps are read-side and classification additions to the same domain. No new top-level project is created. All concrete paths above are the implementation slice's responsibility, recorded here for traceability only.

## Complexity Tracking

> No Constitution Check violations to justify. This SPECIFY-ONLY plan authors no code, contract, or migration; the eventual slice extends an existing module rather than adding a new project. Table intentionally empty.

## Phases

### Phase 0 — Research (research.md)

Resolves the non-owner-decision unknowns into recorded decisions: how to engage the L1 `idempotency_keys` seam on capture, how the persisted server-authoritative status relates to the POS-local outbox UX, how dead-letter classification routes RETRYABLE vs NEEDS_REPAIR, and how the read/repair surface stays generated-client-only. The four §13 owner decisions are recorded as OPEN, not resolved.

### Phase 1 — Design & Contracts (data-model.md, contracts/, quickstart.md)

- `data-model.md`: prose description of the server-authoritative sale-status vocabulary + transitions, the dead-letter/NEEDS_REPAIR quarantine state, and the L1 idempotency-key record — at the conceptual level. No SQL, no migration file, no column DDL.
- `contracts/README.md`: prose description of the §6 capture contract (201 fresh / 200 replayed) and the §9 read/repair surface ops. No OpenAPI YAML emitted (that is the slice's `sales.yaml`, and its timing is an OPEN owner decision — §13 item 4).
- `quickstart.md`: a verification narrative (replay → same sale, no duplicate; failed sync → NEEDS_REPAIR with provenance intact; repair is server-mediated and audited).
- **Agent-context step SKIPPED**: the plan skill's Phase-1 step-3 edit of `CLAUDE.md` (between `<!-- SPECKIT START/END -->` markers) is intentionally NOT performed — `CLAUDE.md` is outside `specs/032/` and editing it would violate this chain's write-scope. Recorded here and in the run output.

### Phase 2 — Tasks (tasks.md)

Produced by `/speckit-tasks`. Ordered, dependency-aware, organized by user story, enumerated but NOT dispatched (spec §11). First MVP slice = §11 items 3 + 7 (status + read surface).
