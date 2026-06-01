# Implementation Plan: POS Catalogue Read-Down Sync

**Feature**: 010-pos-catalog-read-down-sync
**Branch**: `spec/010-pos-catalog-read-down-sync` (off `origin/main`; isolated from in-flight `feat/009-us3-idempotency`)
**Spec**: [spec.md](./spec.md)
**Created**: 2026-06-01
**Constitution**: v3.0.1
**Status**: Plan v1.0 — Phase 0 + Phase 1 authored. **No application code, no migration SQL, no OpenAPI YAML authored by this plan** (gated surfaces; see Constitution Check).

## Summary

Platform-side read-down API publishing the resolved sellable store catalogue to device-authenticated POS terminals as **snapshot + delta**, scoped to `(tenant_id, store_id)` (wire term `branch_id`). Read-only; the platform stays the catalogue authority (§IX). Consumed by POS-Pulse 010 (separate repo). The plan resolves the spec's one deferred decision (delta mechanism) and identifies the gated surfaces (OpenAPI contract + a change-log migration) that ship as separate approved slices.

## Technical Context

**Language/Version**: TypeScript (NestJS, per existing `apps/api`)
**Primary Dependencies**: NestJS, Drizzle ORM, Postgres (existing platform stack)
**Storage**: Postgres (system of record, §"Backend Authority"); reads 003 catalog tables (`tenant_products`, `store_product_overrides`, `product_aliases`); **adds a catalogue change-log/projection-version mechanism** (gated migration — see Research R1)
**Testing**: Jest + contract tests against `packages/contracts/openapi/` (§IV, §VI test-first)
**Target Platform**: Linux server (platform API)
**Project Type**: web-service (platform REST API)
**Performance Goals**: snapshot p95 and delta p95 to be set in research (POS reads, latency-tolerant; the offline replica absorbs latency — not per-scan)
**Constraints**: read-only; no raw DB entities in responses (§IV `toBody()` projection); device-auth; tenant/store RLS (§II/§XII); exact-decimal money (§"Money"); non-disclosing cross-scope (§XII)
**Scale/Scope**: catalogue per `(tenant, store)` — POS-Pulse measured ~50k products at the consumer side (009 T054); snapshot must paginate at that scale

**NEEDS CLARIFICATION**: none remaining — the spec's deferred delta-mechanism question is resolved in Research R1 below.

## Constitution Check

| Principle | Gate | Status |
|:--|:--|:--|
| **IV. Contract-First POS Integration** | Documented in `packages/contracts/openapi/`; stable `operationId`; explicit `security`; versioned `/api/pos/v1/`; authenticated; no raw DB entities; conflict/duplicate-event rule documented | ✅ Plan honors all; **contract YAML is a `[GATED]` slice** (authored separately, not by this plan) |
| **IX. Source-of-Truth Model** | Read-only projection; never authoritative; does not collapse the 4 SoT layers (003 §5) | ✅ Read-down projection only; no write surface |
| **II/XII. Multi-tenant RLS / Object Safety** | Tenant+store scoping from principal; non-disclosing cross-scope | ✅ FR-002/004; device principal only |
| **XI. Idempotency & External IDs** | Delta replays converge; same cursor → same result | ✅ FR-021; cursor-based idempotent replay (R1) |
| **VI. Test-First Quality** | Contract tests enforce the OpenAPI; failing test before impl | ✅ Planned; contract-test-first per slice |
| **VII. Observable Systems** | Named signals | ✅ FR-070 (lookup-failure, reconciliation-mismatch, unpriced-issue) |
| **"Money, Tax, Rounding"** | Exact-decimal, never float | ✅ FR-051 decimal-string + currency |
| **Migrations reviewed (Backend Authority)** | Lock duration, back-comduration, rollback | ⚠️ **GATED** — R1 requires a change-log migration; ships as an approved migration slice with a review (additive, see R1) |
| **VIII / Standing Rules §3 — `[GATED]` surfaces** | `packages/contracts/openapi/**` + migrations require per-slice approval | ⚠️ **GATED** — this plan authors NO YAML and NO SQL; it scopes the gated slices |

**Gate result: PASS with two flagged `[GATED]` surfaces** (OpenAPI contract slice; change-log migration slice). Both are additive, both ship under explicit per-slice approval. No unjustified violations.

## Project Structure

### Documentation (this feature)
```
specs/010-pos-catalog-read-down-sync/
├── spec.md              # ✅ done (+ clarify)
├── plan.md              # ✅ this file
├── research.md          # ✅ Phase 0 (below, authored alongside)
├── data-model.md        # ✅ Phase 1
├── contracts/
│   └── README.md        # ✅ Phase 1 — contract obligations (NO YAML; gated slice authors the YAML)
└── quickstart.md        # ✅ Phase 1
```

### Source Code (repository root) — *scoped, NOT authored by this plan*
```
packages/contracts/openapi/catalog/read-down.yaml   # [GATED] — separate contract slice
packages/db/src/schema/catalog/<change-log>.ts       # [GATED] — change-log/version (R1)
packages/db/drizzle/<NNNN>_pos_catalog_read_down.sql # [GATED] — additive migration
apps/api/src/catalog/read-down/                       # controller + service + toBody projection (impl slice)
```

## Complexity Tracking

No constitution violations requiring justification. The two `[GATED]` surfaces (contract YAML, change-log migration) are not violations — they are the constitution's required approval path for those surfaces, scoped here and executed in their own slices.

## Phase 0 — Research (see [research.md](./research.md))

Resolves the spec's single deferred decision (delta mechanism) and sets performance/conflict policy. Key outcome: **R1 — a catalogue change-log / projection-version mechanism is REQUIRED** (derive-from-`updated_at` cannot express the "became-unpriced → remove" tombstone of FR-042), so 010 needs a `[GATED]` additive migration.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md) — the read projection, the change-log/cursor entity, the sellable-filter rule, the removal-tombstone.
- [contracts/README.md](./contracts/README.md) — operationIds, auth, scoping, payload, error taxonomy the gated YAML must satisfy (no YAML authored).
- [quickstart.md](./quickstart.md) — how a terminal does snapshot → delta → re-baseline.

## Phase 2 — (next) `/speckit-tasks`

Will generate the slice-ordered tasks: contract slice (`[GATED]`) → change-log migration slice (`[GATED]`) → service + projection + contract tests → observability + unpriced-issue signal. POS-Pulse 010 unblocks once the contract YAML is pinned + snapshot endpoint reachable.
