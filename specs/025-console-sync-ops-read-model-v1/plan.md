# Implementation Plan: Console Sync-Ops Read-Model v1

**Branch**: `025-console-sync-ops-read-model-v1` | **Date**: 2026-06-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/025-console-sync-ops-read-model-v1/spec.md`

## Summary

025 delivers a **console-facing, read-only sync-ops read-model**: one cohesive
projection that aggregates the ERPNext sync operational state the Retail Tower Console
(sibling React/Vite SPA) needs — 015 posting health (`erpnext_posting_status`) and 017
reconciliation runs/reports (`erpnext_reconciliation_*`) — into a single tenant-scoped
view, plus forward-compatible `not_available` placeholders for the not-yet-built 020
(connector health) and 021 (product-master reconciliation) domains. It is a
**compute-on-read projection** over existing state (009/017 posture, 017
`READ-NOT-MIRROR-015`): **no new persistent table, no migration, no write surface, no
new authority, no mirror.** The only gated artifact is a new console-facing OpenAPI 3.1
contract under `/api/v1/...` secured by **cookieAuth / `DashboardAuthGuard`** (human
operators only), mirroring 017's `reconciliation.yaml`. Three operations: a sync-ops
summary, a posting dead-letter backlog list, and a reconciliation run-history list.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20 LTS, pnpm workspaces

**Primary Dependencies**: NestJS 11 (api app only — no worker work in v1), Drizzle ORM
(read queries only over existing 015/017 schemas), Zod (runtime request/response
validation), OpenAPI 3.1 (contract of record)

**Storage**: PostgreSQL 16+ with RLS — **read-only** over existing tables
(`erpnext_posting_status` from 015, `erpnext_reconciliation_run` / `_result` from 017).
**No new table, no new migration, no Drizzle schema change.**

**Testing**: Jest + Supertest + Testcontainers (real-Postgres tenant-isolation harness);
`MIGRATION_TEST_ALLOW_SKIP=1` for local Docker-less runs where supported. OpenAPI
conformance tests for the new contract.

**Target Platform**: Linux server (DP2 api service; Prometheus exporter `:9464`)

**Project Type**: Web-service backend (NestJS api). The consumer (Retail Tower Console)
is a separate repo and is out of scope here.

**Performance Goals**: Report-only pending a dedicated perf environment (consistent with
005/008/009/010). Target posture: the summary is a single bounded request; list surfaces
are cursor-paginated and bounded.

**Constraints**: Read-only; no mirror (recompute-on-read); cookieAuth human-only;
tenant-scoped via RLS + `runWithTenantContext`; canonical error envelope; explicit wire
shapes (no raw DB entities); exact-decimal pass-through for any money.

**Scale/Scope**: 3 read operations, ~5 projection DTOs, 1 read-model service, 1 new api
sub-module, 1 `[GATED]` OpenAPI contract file (prose-described here, authored under
approval), 1 Testcontainers isolation harness. No worker, no schema, no migration.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Touched? | Posture | Verdict |
|---|---|---|---|
| **II — Multi-Tenant RLS** | Yes | Every read runs under `runWithTenantContext`; RLS fails closed on unset GUC; cross-tenant/cross-store reads return canonical non-disclosing 404; no read bypasses tenant context. | PASS |
| **III — Backend Authority & Integrity** | Yes (read) | Server-side authz; canonical error envelope + `request_id`; any money pass-through is exact-decimal + currency, never re-derived/rewritten; no cache-as-truth (recompute-on-read). | PASS |
| **IV — Contract-First** | Yes | New `[GATED]` OpenAPI 3.1 contract is source of truth; stable `operationId`s; explicit `security` (cookieAuth); explicit wire shapes (no raw DB entities); conformance tests enforced in CI. | PASS |
| **V — Async in Workers** | No | v1 is synchronous read-only; no background job introduced. | N/A |
| **VI — Test-First** | Yes | RED→GREEN; Testcontainers isolation harness; cross-tenant + cross-store sweep; auth-failure + machine-credential-rejection tests; ≥80% coverage. | PASS |
| **VII — Observable** | Yes | Reuses shared sync-ops signals (`reconciliation mismatch rate` / POS sync lag named in §VII) in the shared metrics surface; no per-feature metrics file; structured logs carry `request_id`/`tenant_id`. | PASS |
| **VIII — Reproducible/Gated** | Yes | The OpenAPI contract is `[GATED]` and authored only under approval; **no** `package.json` / `pnpm-lock` / Drizzle schema / SQL migration change. | PASS |
| **IX — Source-of-Truth / No Mirror** | Yes (load-bearing) | Read-through projection; never copies source rows into a new table; never becomes authority; 015/017 remain the truth; repair/run-trigger stay 017 writes. | PASS |
| **X — Temporal Semantics** | Yes (read) | Surfaces existing 015/017 timestamps (dead-letter time, run start/finish) as stored UTC `TIMESTAMPTZ`; introduces no new clock semantics. | PASS |
| **XI — Idempotency** | No | No write/mutation; nothing to dedup. | N/A |
| **XII — Object Safety** | Yes | Strict request validation (reject unknown keys); object-level authz on every read; tenant/store resolved from session/context, never from body; cross-tenant safe-404. | PASS |
| **XIII — Auditability** | Partial | Reads are not in the constitutional auditable-events list; no audit emission required for v1 read-only access. Documented as an explicit non-action. | PASS (N/A by class) |
| **XIV — PII & Lifecycle** | Yes | Surfaces only provenance (`sourceSystem`/`externalId`) + operational state already visible via 015/017; introduces no new PII class; logger redaction inherited at the boundary. | PASS |

**Result**: PASS — no violation. No entry in Complexity Tracking required.

## Project Structure

### Documentation (this feature)

```text
specs/025-console-sync-ops-read-model-v1/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (projection shapes; no persistence)
├── contracts/           # Phase 1 output — PROSE description of the [GATED] contract
│   └── console-sync-ops.contract.md   # describes the future OpenAPI file (not the YAML)
├── spec.md              # Feature spec (already written)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

> **Gated-surface note.** The real OpenAPI YAML
> (`packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml` or sibling) is a
> `[GATED]` artifact. This planning chain DESCRIBES it in prose under `contracts/` but
> does NOT create or edit any file under `packages/contracts/openapi/**`.

### Source Code (repository root)

```text
apps/api/src/catalog/erpnext-sync-ops/        # NEW sub-module (sibling of erpnext-posting, erpnext-reconciliation)
├── erpnext-sync-ops.module.ts                # NestJS module wiring
├── erpnext-sync-ops.controller.ts            # 3 read routes, cookieAuth + DashboardAuthGuard + RolesGuard
├── erpnext-sync-ops.read-model.service.ts    # compute-on-read aggregation over 015/017 reads
├── dto/
│   ├── sync-ops-summary.body.ts              # SyncOpsSummary + DomainSummary wire shapes
│   ├── posting-backlog-item.body.ts          # PostingBacklogItem wire shape
│   ├── reconciliation-run.body.ts            # ReconciliationRunView wire shape
│   └── list-query.dto.ts                     # cursor/sort/group/store-filter query DTO (Zod .strict())
└── erpnext-sync-ops.projection.ts            # toBody() projections (no raw DB entities)

# READ-ONLY collaborators (existing — NOT modified beyond exported read helpers if any):
apps/api/src/catalog/erpnext-posting/          # 015 — source of posting status
apps/api/src/catalog/erpnext-reconciliation/   # 017 — source of runs/results
apps/api/src/observability/ (api.metrics.ts)   # shared signal surface (reuse, do not add a per-feature file)

apps/api/test/catalog/erpnext-sync-ops/        # Testcontainers integration + isolation harness
├── erpnext-sync-ops.isolation.harness.ts      # seed fixtures (tenants, posting rows, runs)
├── sync-ops-summary.int-spec.ts               # US1
├── posting-backlog.int-spec.ts                # US2
├── reconciliation-run-history.int-spec.ts     # US3
└── erpnext-sync-ops.contract-spec.ts          # OpenAPI conformance for the [GATED] contract
```

**Structure Decision**: 025 is a thin read-only sub-module under the existing
`apps/api/src/catalog/` tree, placed beside its two source modules
(`erpnext-posting`, `erpnext-reconciliation`) — the same neighbourhood 017 chose for the
operator reconciliation surface. It adds no schema package code and no worker code. The
gated OpenAPI contract is described in `contracts/` prose only.

## Complexity Tracking

> No Constitution Check violation — this section is intentionally empty.
