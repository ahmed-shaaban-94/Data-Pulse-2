# Implementation Plan: Product-Master Reconciliation v1

**Branch**: `021-product-master-reconciliation-v1` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/021-product-master-reconciliation-v1/spec.md`

## Summary

021 is the **reconciliation surface over the 013 product-master mapping**, built
in 017's proven **run → report → repair** shape. Its subject is product/item-mapping
divergence (not stock, not posting). The MVP (US1) is a **pure DP2-side
read-projection** — active `tenant_products` (003) that lack a confirmed-and-active
`erpnext_item_map` (013) row, classified `unmapped_dp2_product` /
`suggestion_unconfirmed` — surfaced to a Tenant Admin behind `cookieAuth`. Repair
(US2) **drives 013's existing suggest/confirm/re-point lifecycle** (no new mapping
primitive; honors 013's `version` guard + 1:1 active partial-unique). The
two-sided run (US3) compares the DP2 mapping set against the connector's
ERPNext-item view, persisting a classified mismatch report; it is **stub-tolerant**
(an absent connector view is reported, never a run failure), with the live read
gated behind a future `021-ITEM-VIEW-CONTRACT`. 021 owns a small `[GATED]`
`erpnext_product_reconciliation_*` table family (run + result + repair_attempt) and
a `[GATED]` operator OpenAPI contract; it reads but never mutates 013/003/008.

## Technical Context

**Language/Version**: Node.js 20 LTS · TypeScript 5.x (strict)

**Primary Dependencies**: NestJS 11 (api + worker) · Drizzle ORM · Zod (runtime
validation) · BullMQ (Redis 7+) for the run processor · pino + OpenTelemetry +
Prometheus exporter (observability)

**Storage**: PostgreSQL 16+ with Row-Level Security. New `[GATED]`
`erpnext_product_reconciliation_*` table family (run + result + repair_attempt) via
an explicit SQL migration (`0022` indicative — next after `0021`), with paired
`*.down.sql`. Reads (never writes) `tenant_products` (003 `0007–0011`),
`erpnext_item_map` (013 `0017`), and the platform `audit_events` table (writes
in-tx only).

**Testing**: Jest + Supertest + Testcontainers (real-Postgres tenant-isolation
harness). `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs where supported;
CI runs Testcontainers. The drift allowlists (`EXPECTED_MIGRATIONS`,
`EXPECTED_CATALOG_MODULES`) must be updated in lockstep with the new migration +
schema module.

**Target Platform**: Linux server (containerized api + worker).

**Project Type**: Multi-tenant SaaS backend (web-service); api module + worker
module in the existing pnpm monorepo. No frontend in this repo (dashboard is a
separate future feature consuming the `[GATED]` contract).

**Performance Goals**: Report-only in v1 (no dedicated perf env — the 005/008/009/010/017
precedent). The US1 backlog projection should page in bounded time on a
realistic tenant catalog; the US3 run is a bounded worker job. Specific perf
assertions are deferred (report-only), not gated.

**Constraints**: DP2 makes **no outbound ERPNext HTTP** (the connector is the only
ERPNext caller, ADR 0008); 021 is **stub-tolerant** until the connector ships the
item-view contract. RLS fail-closed on every owned table; cross-tenant
non-disclosure (safe 404). Human-operator-only (`cookieAuth`); no machine bearer,
no POS device scheme. 013/003/008 are never mutated by 021.

**Scale/Scope**: 3 owned tables, 1 read-projection, 1 operator contract (several
operationIds: list backlog, run, list runs/results, trigger repair), 1 worker run
processor. Three independently-shippable user stories (P1 connector-free MVP; P2
repair; P3 connector-gated run).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Touch? | Verdict / justification |
|---|---|---|
| **§I Reference, not source of truth** | yes | PASS — no ERPNext fork/core copy; ERPNext item identity reached only via the connector seam; 021 speaks DP2 terms. |
| **§II Multi-tenant RLS** | yes | PASS — every owned table is `tenant_id` NOT NULL + FK with fail-closed RLS (empty-GUC CASE guard); the US1 projection is tenant-scoped via `app.current_tenant`; cross-tenant reads/repairs return safe non-disclosing 404. RLS-bypass probe + cross-tenant sweep required (§VI). |
| **§III Backend authority & integrity** | yes | PASS — repair re-uses 013's `version` optimistic-concurrency guard (no LWW on the mapping); a stale-version confirm is a `409`. No money column anywhere (counts/qty values only on report rows, never floats; report carries no pricing). Uniform error envelope. |
| **§IV Contract-first** | yes | PASS — the operator surface ships as a `[GATED]` OpenAPI YAML first with stable `operationId`s + conformance tests; responses are explicit wire shapes (`toBody()` projection), never raw DB rows. The future connector ERPNext-item view is its own `[GATED]` `021-ITEM-VIEW-CONTRACT`. |
| **§V Async work in workers** | yes | PASS — the US3 reconciliation run is a BullMQ worker job carrying `tenantId` + `correlationId`, establishing tenant context before DB access; the US1 list + US2 repair are synchronous request paths (validation/authz/state change only). |
| **§VI Test-first quality** | yes | PASS — RED→GREEN per slice; Testcontainers isolation harness; cross-tenant sweep + RLS-bypass probe + malicious-override (mass-assignment) tests; ≥80% coverage. |
| **§VII Observable systems** | yes | PASS — the unmapped-backlog depth + reconciliation outcome are the §VII "reconciliation mismatch rate" family, registered in the shared `api.metrics.ts` (the 010 precedent), carrying no PII/money/raw-payload labels. |
| **§VIII Reproducible releases** | yes | **`[GATED]`** — the `0022` migration + the OpenAPI YAML are forbidden surfaces; authored only in their own approval slices with paired `*.down.sql` + lock-duration review + CHANGELOG. This planning chain authors NO gated file (prose only). |
| **§IX Source-of-truth** | yes | **The discriminating check.** PASS — 021 is reconciliation, NOT authority handover (013 §5 / 011-DR-STOCK-IMPACT). `tenant_products` (Tenant Catalog) stays authoritative for the retail product; ERPNext owns accounting Item identity; 008 sale facts immutable. A divergence is surfaced, never silently overwritten. 021 reads 013/003/008 and writes none of them. |
| **§XI Idempotency & external IDs** | yes | PASS — repair is idempotent (confirm of an already-confirmed mapping = no-op echo; 013 OQ-2 1:1 holds); the run worker is idempotent (a re-run converges; deterministic dedupe). |
| **§XII Authorization & object safety** | yes | PASS — `tenant_id`/`actor_user_id` resolved from the session, never body-supplied; strict DTOs reject unknown keys; object-level authz on every read/repair; safe 404 cross-tenant; default-deny guards. |
| **§XIII Auditability & provenance** | yes | PASS — every run + repair writes an `audit_events` row **atomically in-transaction** (the 017 FR-014 path, NOT the async `@Auditable`); insert-only; `metadata` bounded + redacted; suggestion provenance (`suggestion_source`) carried from 013. |
| **§XIV PII & data lifecycle** | yes | PASS — owned tables are BUSINESS-class: no PII, no payment data, no raw payloads; `summary`/`detail` jsonb carry counts + operator-facing qty/state values only. Retention is a state (`open`/`repaired`/`accepted`), not a row removal — no DELETE policy. |
| **§X Retail temporal semantics** | partial | N/A-leaning — 021 owns no sale-bearing entity; it records run `started_at`/`finished_at` + repair `created_at` (UTC `timestamptz`). It reads but never rewrites 008 sale facts (§X "historical sale facts not silently rewritten"). |

**Result: PASS.** No principle is violated. The two surfaces that *would* violate
if mis-built — §IX (authority handover) and §VIII (gated drive-by schema/contract) —
are addressed head-on (read-not-mutate; `[GATED]` slices only). No Complexity
Tracking entry required.

## Project Structure

### Documentation (this feature)

```text
specs/021-product-master-reconciliation-v1/
├── spec.md              # Feature spec (+ Clarifications)
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + rationale + alternatives
├── data-model.md        # Phase 1 — owned table family (PROSE/[GATED], no SQL) + reads
├── tasks.md             # Phase 2 — dependency-ordered, [GATED]-flagged slices
├── analysis.md          # Cross-artifact consistency analysis
└── review.md            # Self-review
```

> No `quickstart.md` or `contracts/` directory is authored in this no-implement
> planning pass. The operator contract and the connector ERPNext-item view are
> described in **prose** under the data-model "Contracts (prose)" heading and are
> each their own future `[GATED]` slice.

### Source Code (repository root)

The feature lands in the existing pnpm monorepo. Real DP2 paths the future
implementation slices will touch (NOT created in this planning pass):

```text
packages/db/
├── src/schema/catalog/
│   └── erpnext-product-reconciliation.ts   # [GATED] Drizzle schema (run/result/repair_attempt)
└── drizzle/
    ├── 0022_erpnext_product_reconciliation.sql       # [GATED] migration (indicative number)
    └── 0022_erpnext_product_reconciliation.down.sql  # [GATED] paired rollback

> ⚠️ **Cross-spec migration-number collision (resolve at gate time):** this wave
> also produced **020-connector-health-and-connection-status-api**, which likewise
> reserves the indicative `0022`. Both are gated and unmerged, so neither number is
> real yet. Whichever SCHEMA slice authors **second** MUST take the next free number
> off the then-current `main` (likely `0023`) and update its `EXPECTED_MIGRATIONS`
> tail accordingly. The indicative `0022` here is a placeholder, not a claim.

packages/contracts/openapi/catalog/
└── product-reconciliation.yaml             # [GATED] operator contract (cookieAuth)
# (future) packages/contracts/openapi/erpnext-connector/item-view.yaml — 021-ITEM-VIEW-CONTRACT [GATED]

apps/api/src/modules/catalog/erpnext-product-reconciliation/   # service + controller + DTOs + projection
apps/worker/src/...                          # the US3 run processor (BullMQ consumer)
apps/api/src/observability/api.metrics.ts    # register the reconciliation signal (shared file)

apps/api/test/...  + packages/db/__tests__/  # Testcontainers isolation harness + sweeps + drift allowlists
```

**Structure Decision**: Reuse the existing catalog-domain module layout (the
013/017 precedent — 017 namespaced its surface under
`/api/v1/catalog/erpnext-reconciliation`; 021's operator surface lives alongside,
e.g. `/api/v1/catalog/erpnext-product-reconciliation`). The owned schema module
lives under `packages/db/src/schema/catalog/` (the `erpnext-item-map` precedent);
the run processor is a worker consumer. No new package, no new top-level app.

## Complexity Tracking

> No Constitution Check violation — this section is intentionally empty. One new
> small table family + one operator contract is standard `[GATED]` treatment; the
> US1 read-projection deliberately avoids a persisted mirror, keeping the schema
> minimal.
