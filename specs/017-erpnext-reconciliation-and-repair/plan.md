# Implementation Plan: ERPNext Reconciliation & Repair

**Branch**: `017-erpnext-reconciliation-and-repair` (work off `main`; per-slice feature branches) | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-erpnext-reconciliation-and-repair/spec.md`

## Summary

017 is the ERPNext arc's **operational reconciliation surface** — `run → report →
repair` — for a human Tenant Admin. It makes the 015 posting dead-letter backlog
**visible** (P1 MVP), exposes an **idempotent repair / re-post** workflow that
preserves the 015 O-3 invariant (a repaired posting resolves to exactly one
ERPNext document — same `document_ref`, never a second document or a silent
rewrite) (P2), and runs **stock reconciliation** comparing DP2 on-hand (009)
against the ERPNext valuation view for the 014-mapped warehouse, persisting
mismatch reports classified in 014's vocabulary (P3).

**Technical approach.** A new `apps/api` operator module (human `cookieAuth` /
DashboardAuthGuard, mirroring 014's `/api/v1/catalog/...` admin convention)
exposes list/run/repair over a new
`[GATED]` `packages/db` reconciliation-state table (runs + results + repair
attempts) plus a read-projection over the **existing** 015 `erpnext_posting_status`
table. **Posting repair is a pure state transition**: it re-makes a
`permanently_rejected` 015 row eligible (`pending`, sequence re-headed — the same
mechanism US2-ACK already ships) so the connector re-posts via the **existing**
012 feed/ack — no new machine contract, no outbound ERPNext HTTP from DP2. The
**stock reconciliation run** is async worker work (§V) that consumes the
connector's ERPNext-Bin view behind the fixed 012 boundary; for v1 the
connector-side ERPNext read is a contract seam (the connector repo owns the
actual fetch). The reconciliation signals extend the **shared**
`erpnext_posting_reconciliation_total` family 015-POLISH already registered.

## Technical Context

**Language/Version**: TypeScript 5.x strict (`exactOptionalPropertyTypes`), Node.js 20 LTS

**Primary Dependencies**: NestJS 11 (api + worker), Drizzle ORM, Zod (runtime validation), BullMQ + Redis 7 (async run), pg

**Storage**: PostgreSQL 16+ with RLS (fail-closed empty-GUC CASE guard). One new `[GATED]` reconciliation-state table (next migration after `0019` → **`0020` indicative**, confirm at authoring); reads the existing `erpnext_posting_status` (0019), `erpnext_warehouse_map` (0018), `stock_movements` (0014).

**Testing**: Jest + Supertest + Testcontainers (WSL-only; `MIGRATION_TEST_ALLOW_SKIP=1` soft-skip, `WORKER_INCLUDE_DB_TESTS=1` for worker DB specs)

**Target Platform**: Linux server (api `:9464`, worker `127.0.0.1:9091`)

**Project Type**: Web-service backend (SaaS) — admin/operator API + worker. No frontend in this repo (dashboard is a separate future feature consuming the OpenAPI).

**Performance Goals**: Report-only (005/008/009/010 precedent — no perf env). The backlog list is index-backed; a reconciliation run is bounded per (tenant, store) and bounded per page (the 009 500/req ceiling precedent).

**Constraints**: No outbound ERPNext HTTP from DP2 (connector boundary). 008 sale fact + 009 ledger NEVER mutated by 017. Repair bounded by the 015 `POSTING_RETRY_BUDGET`. Money exact-decimal string, never float. No PII/money/raw payloads in logs or metric labels.

**Scale/Scope**: Per-tenant operator surface; dead-letter backlog typically small relative to total postings; stock reconciliation scoped per (tenant, store) run.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | How 017 satisfies it |
|---|---|
| **I. Reference, not source of truth** | No legacy carry-over; 017 is greenfield over shipped 008/009/014/015 facts. |
| **II. Multi-tenant RLS (fail-closed)** | The new reconciliation-state table is `tenant_id NOT NULL` + ENABLE/FORCE RLS with the empty-GUC CASE guard (0012/0017/0019 pattern); runtime role never `BYPASSRLS`; cross-tenant reference → non-disclosing 404 (FR-003). RLS-bypass probe + cross-tenant tests required (§VI). |
| **III. Backend authority & integrity** | DP2 stays operational on-hand authority; reconciliation never silently overwrites either side (FR-016). Money exact-decimal string. Repair is a server-authoritative state transition, not a client write. Uniform error envelope. |
| **IV. Contract-first** | The operator API gets a new `[GATED]` OpenAPI contract (list/run/repair); responses are explicit `toBody()` wire shapes, never raw rows (FR-001/002). The 012 posting-feed.yaml is **read-only input** — 017 adds NO machine contract (FR-017/018). |
| **V. Async in workers** | The stock reconciliation **run** is worker work (idempotent, retry-safe, carries `tenantId`/`storeId`/`correlationId`, sets `app.current_tenant` in-tx, redacted failure logs). |
| **VI. Test-first** | RED→GREEN per slice; Testcontainers tenant-isolation + RLS-bypass probe + cross-tenant + mass-assignment-rejection tests; ≥80% coverage. |
| **VII. Observable** | Extends the **shared** `erpnext_posting_reconciliation_total` family (015-POLISH) + adds run/repair counters in the shared api/worker metrics files (NOT per-feature); no PII/money/raw payloads. |
| **VIII. Reproducible releases** | The new table + migration is a `[GATED]` `packages/db` slice (paired `*.down.sql`, lock review, drift-test allowlists). The OpenAPI contract is a `[GATED]` `packages/contracts` slice. |
| **IX. Provenance / immutability** | 008 sale fact + 009 ledger NEVER mutated (FR-013); reconciliation runs + repair attempts are **append-only** records; provenance (`sourceSystem`+`externalId`) carried through. |
| **XII. Object safety** | Mass-assignment ban (strict DTOs); body-supplied tenant/store/server-owned fields rejected; cross-tenant non-disclosure (FR-003). |
| **XIV. PII & data lifecycle** | Reconciliation rows are BUSINESS-class (refs, provenance, classes, counts) — no PII, no payment data. §XIV data-class guard on the new table; long-horizon retention (a report/dead-letter is retained, not deleted). |

**Gate result (initial): PASS** — two `[GATED]` surfaces (the `packages/db`
table+migration and the `packages/contracts` operator OpenAPI) are anticipated and
will be serialized as approval-gated slices; no unjustified violations. No
Complexity Tracking entries needed.

**Gate result (post-Phase-1 re-check): PASS, unchanged.** The Phase 1 design
(research.md + data-model.md + contracts/README.md) introduced no new violation:
- Repair re-uses the **015 O-3 state machine** (no new idempotency primitive — §III) and the **015 retry budget** (no unbounded loop — FR-019).
- The new `0020` tables are RLS fail-closed, `tenant_id NOT NULL`, append-only repair audit, no DELETE policy, no money/PII (§II/§IX/§XIV) — and READ the 015 dead-letters rather than mirroring them (no derived-projection drift, the 010 lesson).
- The operator contract is `cookieAuth`-only, explicit wire projections, strict bodies, canonical error envelope (§IV/§XII); the 012 contract stays read-only input (no new machine surface).
- The stock run is idempotent worker work that never mutates 008/009 (§V/§IX), tolerant of an absent connector view (decoupled, the 009 precedent).
- Signals extend the **shared** metrics family (§VII, the 010/015 precedent).
Two `[GATED]` slices remain the only approval thresholds; everything else is `apps/api` / `apps/worker` / tests.

## Project Structure

### Documentation (this feature)

```text
specs/017-erpnext-reconciliation-and-repair/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (operator reconciliation/repair OpenAPI)
├── checklists/
│   └── requirements.md  # /speckit-specify output (all pass)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
packages/db/
├── src/schema/catalog/erpnext-reconciliation.ts        # [GATED] new Drizzle schema (runs + results + repair attempts)
├── src/schema/index.ts                                 # barrel re-export
├── drizzle/0020_erpnext_reconciliation.sql             # [GATED] migration (number indicative — confirm)
├── drizzle/0020_erpnext_reconciliation.down.sql
└── __tests__/{cli/migrate.spec, schema/catalog/barrel.spec, migration/0020-*}  # drift allowlists + round-trip

packages/contracts/openapi/erpnext-reconciliation/
└── reconciliation.yaml                                  # [GATED] operator API: list backlog / run / repair (cookieAuth)

apps/api/src/catalog/erpnext-reconciliation/
├── erpnext-reconciliation.module.ts
├── erpnext-reconciliation.controller.ts                # list backlog / trigger run / trigger repair (DashboardAuthGuard; routes under /api/v1/catalog/...)
├── erpnext-reconciliation.service.ts                   # backlog projection + repair state transition (re-uses 015 O-3)
├── reconciliation-report.projection.ts                 # toBody wire shapes
└── dto/*.ts                                            # strict Zod DTOs (mass-assignment ban)

apps/worker/src/erpnext-reconciliation/
└── reconciliation-run.processor.ts                     # async stock reconciliation run (§V)

apps/api/src/observability/metrics/api.metrics.ts       # extend shared posting-recon signal family (run/repair counters)
apps/worker/src/observability/metrics/worker.metrics.ts # worker-side run signal
apps/api/test/catalog/erpnext-reconciliation/**         # isolation harness + US1/US2/US3 RED/GREEN
apps/worker/test/erpnext-reconciliation/**              # run processor specs
loadtests/k6/erpnext-reconciliation.js                  # report-only perf scenario
```

**Structure Decision**: Mirrors the shipped catalog feature-module convention
(013 `erpnext-item-map`, 014 `erpnext-warehouse-map`, 015 `erpnext-posting`): a
new `apps/api/src/catalog/erpnext-reconciliation` module + an `apps/worker`
processor for the async run, backed by one new `[GATED]` `packages/db` table and
one new `[GATED]` `packages/contracts` operator OpenAPI. **Route namespace:**
`/api/v1/catalog/erpnext-reconciliation/...` — the real human-admin convention
014's `erpnext-warehouse-map` controller uses (`@Controller()` empty + full
per-method `api/v1/catalog/...` paths), NOT an `/api/admin/...` prefix (which no
existing module uses). Posting **repair**
re-uses the 015 `erpnext_posting_status` state machine (re-head to `pending`) — it
does NOT re-model the dead-letter. Stock reconciliation reads 009 + the 014
mapping + the connector's ERPNext-Bin seam (012 boundary).

## Complexity Tracking

> No Constitution Check violations — this section intentionally empty.
