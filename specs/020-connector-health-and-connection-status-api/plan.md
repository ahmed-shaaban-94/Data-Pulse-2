# Implementation Plan: Connector Health and Connection-Status API

**Branch**: `020-connector-health-and-connection-status-api` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-connector-health-and-connection-status-api/spec.md`

## Summary

Deliver the connector health/connection-status capability that spec 018 named as the 020 arc handoff. A registered connector instance (018 `connector_registration`) periodically POSTs a liveness **heartbeat** over the machine `connectorBearer` scheme; DP2 records a server-clock `last_seen_at` plus a bounded set of self-reported observational fields in a new tenant-scoped `connector_health` read-model. A tenant administrator reads the **connection status** (list + single-detail) over the human `cookieAuth` session (018 session-only admin pattern), receiving a derived liveness verdict (`healthy` / `stale` / `never_seen` / `disabled`) computed at read time against the server clock and a documented staleness threshold. DP2 makes **no outbound ERPNext HTTP**; ERPNext-reachability is a connector self-report only. No money, no PII (BUSINESS-class).

Technical approach: a new NestJS module in the api app reusing 018's `ConnectorAuthGuard` (for the heartbeat write, identity from guard-attached context) and the 018 session-only admin guard + `RolesGuard` + `TenantContextGuard` (for the operator reads). Service uses `runWithTenantContext` (GUC-scoped RLS), an upsert for the heartbeat (LWW), and a read-time verdict derivation. A new `[GATED]` migration adds `connector_health`; a new `[GATED]` OpenAPI contract `connector-health.yaml` defines the three operations. **This plan and its artifacts are docs-only; no gated file is created in this planning pass.**

## Technical Context

**Language/Version**: TypeScript 5.x strict, Node.js 20 LTS

**Primary Dependencies**: NestJS 11 (api app), Drizzle ORM, Zod (runtime validation / strict DTOs), pino (structured logs), OpenTelemetry + Prometheus exporter (`api.metrics.ts`)

**Storage**: PostgreSQL 16+ with RLS (fail-closed CASE guard). One new table `connector_health`, one row per `connector_registration`. Explicit SQL migration (next free number after `0021` — expected `0022`), `[GATED]`.

**Testing**: Jest + Supertest + Testcontainers (real-Postgres RLS/isolation harness); `MIGRATION_TEST_ALLOW_SKIP=1` for local Docker-less runs where supported. CI runs with Testcontainers enabled (hosted `ubuntu-latest`; `main` unprotected — verify `db-integration` per PR).

**Target Platform**: Linux server (api process; Prometheus on `:9464`). No worker required for v1 (verdict is read-derived; no scheduled sweep).

**Project Type**: Web service (multi-tenant SaaS backend), api app only for v1.

**Performance Goals**: Heartbeat write is a single-row upsert (O(1)); operator list is bounded per tenant by the number of registrations (small). Report-only perf (no dedicated perf env), consistent with 008/009/010 precedent.

**Constraints**: No outbound ERPNext HTTP anywhere in this feature (arc boundary). No money, no PII. Heartbeat is high-frequency machine traffic — no per-beat audit row, no per-instance metric label (cardinality discipline). Last-write-wins on the health row (justified §III).

**Scale/Scope**: A handful of connector instances per tenant (typically one). Heartbeat frequency on the order of one per minute per instance.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Touches? | Posture | Justification |
|---|---|---|---|
| **II. Multi-Tenant SaaS by Default** | YES | PASS | `connector_health.tenant_id` NOT NULL + FK; fail-closed RLS (empty-GUC CASE) mirroring `0019`/`0020`/`0021`; cross-tenant reads return safe 404; runtime role never BYPASSRLS; heartbeat tenant context resolved from the 018 guard, not the body. |
| **III. Backend Authority & Data Integrity** | YES | PASS w/ justification | Authorization server-side (018 guards). FK to `connector_registration` enforces identity at DB layer. **Last-write-wins on the health row is explicitly justified**: `last_seen_at` is monotonic observational data with no invariant two writers can corrupt; an optimistic `version` column adds contention for no correctness benefit (Concurrency section + Complexity Tracking row). Uniform error envelope. No money in this feature, so money rules N/A. |
| **IV. Contract-First POS Integration** | YES | PASS | New `[GATED]` OpenAPI 3.1 `connector-health.yaml` with stable `operationId`s, explicit `security` (cookieAuth for reads, connectorBearer for heartbeat), canonical error envelope, conformance tests. Responses are explicit wire projections (no raw DB entities). |
| **V. Async Work Belongs in Workers** | PARTIAL | PASS | No async work in v1 — the verdict is derived synchronously on read; the heartbeat write is a fast single-row upsert that legitimately completes in-request. A future scheduled stale-sweep (proactive alerting) WOULD be a worker; it is explicitly deferred and named, not silently inlined. |
| **VI. Test-First Quality** | YES | PASS | RED→GREEN. Testcontainers isolation harness; RLS bypass probe; cross-tenant + cross-store(N/A here) sweeps; malicious-override (body identity ignored) test; heartbeat idempotency/convergence test; liveness-threshold boundary test; ≥80% coverage. |
| **VII. Observable Systems** | YES | PASS | `request_id`/`correlation_id` on both paths; structured logs redacted at the boundary; one unlabeled counter `connector_heartbeat_total` in the shared `api.metrics.ts` 3-place register (no per-instance/tenant/secret label). |
| **IX. Source-of-Truth Model** | YES | PASS | `connector_health` is a **read-model / observational projection**, not a source of truth for identity (018 `connector_registration` is). ERPNext-reachability is preserved as connector self-report (provenance), never DP2's own probe result. |
| **X. Retail Temporal Semantics** | YES | PASS | `last_seen_at` is the **server clock** (`receivedAt`-class); the connector-reported clock is stored as `source_clock_at` provenance and never used for the liveness verdict. Storage UTC `TIMESTAMPTZ`. |
| **XI. Idempotency & External IDs** | YES | PASS | Heartbeat is naturally idempotent/convergent (upsert keyed by registration → LWW). Re-run converges to the same state. No double side effect. |
| **XII. Authorization & Object Safety** | YES | PASS | Heartbeat identity from server-side guard context, never the body; strict DTO (`.strict()`) rejects unknown keys; mass-assignment ban (`tenant_id`/`registration_id`/`last_seen_at` not body-assignable); object-level authz on every read; default-deny; safe 404 cross-tenant; operator surface rejects token principals incl. `dashboard_api` bearer (018 session-only). |
| **XIII. Auditability & Provenance** | PARTIAL | PASS | High-frequency heartbeat does NOT write a per-beat audit row (cardinality discipline, FR-017). Operator reads ride standard request observability. If any audit is emitted it follows the canonical shape and carries no secret. |
| **XIV. PII & Data Lifecycle Discipline** | YES | PASS | BUSINESS-class only; no PII, no payment, no secret in `connector_health`. Logging redaction at the boundary. Single-region residency posture stated. No soft-delete needed (health row is derived; deletion follows the registration via FK — see data-model). |

**Result**: PASS. One justified deviation (LWW instead of optimistic concurrency) recorded in Complexity Tracking. No principle violated.

## Project Structure

### Documentation (this feature)

```text
specs/020-connector-health-and-connection-status-api/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + rationale + alternatives
├── data-model.md        # Phase 1 — entities, fields, relationships, RLS posture
├── spec.md              # Feature spec (already written)
├── tasks.md             # Phase 2 — dependency-ordered tasks
├── analysis.md          # Cross-artifact consistency analysis
└── review.md            # Self-review
```

### Source Code (repository root) — TARGET layout for the future implementation (NOT created in this planning pass)

```text
apps/api/src/
├── connector-health/
│   ├── connector-health.module.ts
│   ├── connector-health.controller.ts        # 3 routes: heartbeat (connectorBearer), list + detail (cookieAuth/session-only)
│   ├── connector-health.service.ts           # upsert heartbeat (LWW), read+derive verdict, runWithTenantContext
│   ├── dto/
│   │   ├── connector-heartbeat.dto.ts         # Zod .strict() — self-reported fields only, no identity
│   │   └── connector-health-view.dto.ts       # wire projection (toBody)
│   └── connector-health.liveness.ts           # pure verdict-derivation (last_seen_at + now + threshold + disabled_at)
└── observability/metrics/api.metrics.ts       # ADD connector_heartbeat_total (shared 3-place register) — existing shared file

packages/db/
├── src/schema/connector-health.ts             # [GATED] Drizzle schema — NOT created in this pass
└── drizzle/0022_connector_health.sql          # [GATED] migration (number TBD at gate time) — NOT created in this pass

> ⚠️ **Cross-spec migration-number collision (resolve at gate time):** this wave
> also produced **021-product-master-reconciliation**, which likewise reserves the
> indicative `0022`. Both are gated and unmerged, so neither number is real yet.
> Whichever SCHEMA slice authors **second** MUST take the next free number off the
> then-current `main` (likely `0023`) and update its `EXPECTED_MIGRATIONS` tail
> accordingly. The indicative `0022` here is a placeholder, not a claim.

packages/contracts/openapi/erpnext-connector/
└── connector-health.yaml                       # [GATED] new contract — NOT created in this pass

apps/api/test/connector-health/                 # isolation harness + integration + contract conformance specs
```

**Structure Decision**: Single new api module `connector-health`, mirroring the 017/018 module shape (controller + service + dto + a pure derivation helper). Reuses the shared `api.metrics.ts` and the 018 guards. No new worker module (v1 has no async work). The `[GATED]` schema/migration/contract are described here in prose and authored only after gate approval in implementation.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Last-write-wins instead of the §III-preferred optimistic concurrency (`version` column) for the `connector_health` write | `last_seen_at` and the self-reported fields are monotonic observational data; the only correct convergence under concurrent heartbeats is "latest wins." There is no business invariant that two concurrent writers could violate. | An optimistic `version` column + `If-Match` would force the connector to read-before-write and retry on conflict for a fire-and-forget heartbeat, adding round-trips and contention for zero correctness gain. Optimistic concurrency is for mutable business resources, not high-churn telemetry. §III explicitly permits LWW when justified. |
