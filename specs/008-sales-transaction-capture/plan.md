# Implementation Plan: Sales / Transaction Capture

**Branch**: `docs/008-roadmap-and-sales-spec` | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification at [`spec.md`](./spec.md); owner decisions in [`gate-money-temporal.md`](./gate-money-temporal.md) (§Decisions Recorded, RESOLVED 2026-05-30).

**Mode**: Planning-only. This `/speckit-plan` output authorizes **no implementation**. It creates **no** schema, migration, OpenAPI YAML, package file, or code. The `[GATED]` artifacts it designs against (the `packages/contracts/openapi/**` sale contract and the `0012+` SQL migration) are each their own approval-gated slice, not authored here (Constitution §IV/§VIII, Standing Rules §3).

---

## Summary

008 introduces the first **sale fact** the SaaS owns: a `sales` invoice header + `sale_lines` snapshots, with `void` / `refund` modeled as separate append-only terminal events. It builds **alongside** the 005 POS ingestion seam (reusing the `sourceSystem + externalId` dedup + `Idempotency-Key` interceptor, the tenant-context/RLS helpers, the audit + outbox emitters) — it does not re-invent ingestion. The Money + Temporal Decision Gate is **resolved**: money is `numeric(19,4)`, tax is a single per-line snapshot amount, the SaaS comparison total rounds per-line/half-up, tender is deferred to 010, the money representation is a string-backed value object (no new dependency), timestamps follow a fixed required/optional set, provenance hashes via SHA-256 over canonical JSON, and the sale is an immutable fact (dedup-as-concurrency, no version column). No new observability signal is introduced.

---

## 1. Technical Context

### 1.1 Stack inheritance — no new decisions

008 runs on the existing stack with **zero new platform dependencies**: Node 20 / TypeScript 5 strict, NestJS 11 (api + worker), PostgreSQL 16 + RLS + Drizzle, Redis 7 + BullMQ, OpenAPI 3.1 + Zod, Jest + Supertest + Testcontainers, pino + OpenTelemetry + Prometheus. The money representation (gate A.6) is a **string-backed value object round-tripped to DB `numeric(19,4)`** — deliberately chosen so **no big-decimal library and no `[GATED]` `package.json` change is required** (see §10).

### 1.2 Inputs from the spec

- **Entities** (new): `sales`, `sale_lines`, void terminal event, refund terminal event (spec Key Entities).
- **Behavioral requirements**: FR-001..102 + SI-001..012 (spec §6/§7).
- **Resolved owner decisions**: gate A.1–A.6, B, C, D.1–D.3 (`gate-money-temporal.md` §Decisions Recorded), mirrored into spec §Clarifications (Session 2026-05-30).

### 1.3 NEEDS CLARIFICATION

**None.** Every open parameter was resolved in the decision gate (the gate is CLOSED; `/speckit-clarify` found no residual ambiguity). Implementation parameters left to this plan/`tasks.md` are HOW-level, not unresolved WHAT.

### 1.4 Performance goals

- Inline single-sale capture: directional p95 ≤ 500 ms, p99 ≤ 1 s at the SaaS boundary (spec SC-010, aligned to 005 SC-008; owner confirms the exact budget).
- Bulk offline-recovery sync: governed by the per-tenant bound (§1.5), not the inline budget.

### 1.5 Constraints

- **Money exact-decimal + ISO currency** on every monetary field; floats forbidden (FR-005, §III).
- **POS totals preserved verbatim** (FR-030); SaaS comparison total is advisory only (FR-031/032).
- **Snapshot frozen at capture** (FR-003); catalog changes never mutate past `sale_lines` (§IX/§X).
- **Idempotent ingestion** on `sourceSystem + externalId` (+ optional `Idempotency-Key`), reusing 005's contract unchanged (FR-050/051).
- **Object safety**: forbidden mass-assignment fields, strict `.strict()` boundary, safe-404 cross-tenant, default-deny (FR-061/062, §XII).
- **Per-tenant bulk-sync bound**: offline-recovery batch ceiling **500 events/request**, layered on the inherited 001/004 platform rate-limit posture (gate D.2, FR-080/SI-011).

### 1.6 Scale / scope

- Additive only: a new `apps/api/src/catalog/sales/` module mirroring the `reconciliation/` triad, the `[GATED]` `0012+` migration + sale-fact schema, and the `[GATED]` OpenAPI sale contract — each as its own gated slice. No change to 003 catalog schema, 005 reconciliation contracts, or any shipped RLS.

---

## 2. Constitution Check

Anchored to `.specify/memory/constitution.md` v3.0.1. 008 is the **first feature to exercise §IX/§X/§XI on a real sale entity** (001 §14 recorded them "not exercised — no sale entities defined here").

### 2.1 Initial gate evaluation

| Principle | Verdict | Binding |
|---|---|---|
| I. Reference, not source of truth | PASS | Spec authored from requirements + constitution; nothing lifted from legacy `Data-Pulse`. |
| II. Multi-tenant by default | PASS | FR-060 (NOT NULL `tenant_id`/`store_id`, fail-closed RLS `current_setting('app.current_tenant', true)::uuid`), SI-001..004; cross-tenant = non-disclosing 404. |
| III. Backend authority & integrity | PASS | FR-005 money exact-decimal + currency (**pinned `numeric(19,4)`, gate A.1**); FR-030..032 POS totals preserved; FR-070/071 concurrency posture justified (immutable fact + dedup, **no version column**, gate D.1). |
| IV. Contract-first POS integration | PASS-with-gate | POS ingestion is contract-first; the OpenAPI sale contract is a **`[GATED]`** slice (not authored here). No raw DB entities in responses — `toBody()` projection (binds plan/tasks). |
| V. Async work in workers | PASS | FR-081 — heavy/batched processing (snapshot enrichment, mismatch compute, `processedAt`) off-request in a worker carrying `tenantId`/`storeId`/`correlationId`, tenant context set before DB access. |
| VI. Test-first quality | PASS-with-binding | SC-001..010 + the **mandatory RLS-bypass probe** (wrong-tenant GUC ⇒ zero rows) on each new sale-fact table, cross-tenant + cross-store sweep, malicious-override (FR-061), idempotency-replay (FR-050); RED before GREEN. |
| VII. Observable systems | PASS | FR-091 reuses the already-named signals (POS sync lag, duplicate-event rate, reconciliation-mismatch rate); **no new metric** (§3.3). FR-042/092 forbid raw-payload/secret logging. |
| VIII. Reproducible & versioned releases | PASS-with-gate | New schema/migration (`0012+`) is **`[GATED]`** + reversible (binds the migration slice); none authored here. The money value object adds **no dependency** (§10). |
| IX. Source-of-truth model | PASS (exercised) | FR-002/003 (SaleLine snapshot is truth for the invoice; catalog is reference); FR-040..042 (raw POS payload + provenance traceable). Cross-layer write forbidden (FR-003). |
| X. Retail temporal semantics | PASS (exercised) | FR-020..024 (full field set, UTC `TIMESTAMPTZ`, server security clock, store-tz `businessDate`, delayed events accepted); FR-010..012 (void/refund separate terminal events). Required/optional per gate B. |
| XI. Idempotency & external IDs | PASS | FR-050..052 (`sourceSystem + externalId` dedup, no double-apply); FR-051 reuses 001/005's `Idempotency-Key` primitive + token semantics; SI-010. |
| XII. Authorization & object safety | PASS | FR-061 (mass-assignment forbidden), FR-062 (strict boundary, default-deny), FR-063 (object-level authz), FR-014/SI-004 (safe-404). |
| XIII. Auditability & provenance | PASS | FR-090 (canonical audit per event), FR-040..042 (provenance incl. SHA-256-over-canonical-JSON payload hash, gate C), FR-092 (insert-only, emitter-redacted). |
| XIV. PII & data lifecycle | PASS | SI-012 / gate D.3 — sale fact = **business-class**, retention inherits 001 long-horizon insert-only, tombstone-on-erasure; no PII/payment persisted in v1 (tender deferred, gate A.5). |
| Per-Tenant Resource Isolation | PASS | FR-080/SI-011 — documented bulk-sync bound (500/req, gate D.2) layered on inherited 001/004 posture. |

**Initial gate: PASS.** No principle requires a Complexity-Tracking justification (§10 records only *avoided* complexity).

### 2.2 Post-design re-check

After Phase 1 artifacts (`research.md`, `data-model.md`, `contracts/README.md`, `quickstart.md`) the 14 principles + supporting sections were re-evaluated: no artifact creates backend code, schema, migration, or OpenAPI; the data model honors the gate decisions (numeric(19,4); single per-line tax; SHA-256 canonical; occurredAt/receivedAt/businessDate NOT NULL, processedAt/sourceClockAt nullable, lines inherit; no tender); the contract design is consumption-only and defers the YAML to a gated slice. **Post-design gate: PASS.**

---

## 3. Architecture Impact Map

Per Constitution Working Agreement (`.specify/memory/architecture-impact.md`).

### 3.1 Impact classification

**New additive module + new gated schema.** Touches (when implemented, across gated slices): a **new** `apps/api/src/catalog/sales/` module (controller/service/module triad mirroring `reconciliation/`), the **new** sale-fact Drizzle schema + `0012+` migration (`[GATED]`), the **new** OpenAPI sale contract (`[GATED]`), and new test suites. **Reuses unchanged**: 001/005 idempotency interceptor (`apps/api/src/idempotency/`), the tenant-context + `with-tenant` helpers (`packages/db/src/middleware/tenant-context.ts`, `packages/db/src/helpers/with-tenant.ts`), audit insert (`packages/db/src/helpers/audit-insert.ts`), and the outbox producer (`packages/db/src/outbox/producer.ts`). **Does not touch**: 003 catalog schema, 005 reconciliation contracts, auth module, or any other feature's surface.

### 3.2 Triggered review gates

- **`[GATED]` OpenAPI contract** — the sale contract under `packages/contracts/openapi/**` requires explicit per-slice approval (§IV/§VIII, Standing Rules §3). Its own slice, before any implementing slice's GREEN. **Not created by this plan.**
- **`[GATED]` SQL migration** — the `0012+` migration creating `sales`/`sale_lines`/void/refund + their RLS policies (§VIII). Paired `*.down.sql`, reviewed for lock duration. Its own slice. **Not created by this plan.**
- **Isolation-harness extension** — every new sale/terminal-event operation MUST be added to the cross-tenant + cross-store sweep, and a raw-SQL **RLS-bypass probe** added per new table (§VI).
- **Per-tenant resource-isolation posture** — the bulk-sync bound (gate D.2) must land documented with the first ingestion-heavy slice.

### 3.3 New observability signals

**None.** FR-091 reuses the constitution's already-named signals — **POS sync lag**, **duplicate-event rate**, **reconciliation-mismatch rate** — plus the existing request/correlation-id logging. 008 introduces no new metric category.

---

## 4. Dependency Readiness (the 008 implementability map)

### 4.1 Seam-by-seam: shipped / reuse / new

| 008 capability | Existing status on `main` | 008 work |
|---|---|---|
| POS-facing ingestion route | **Shipped pattern** — `posCaptureItem`, `@Post("api/pos/v1/catalog/unknown-items")` in `unknown-items.controller.ts` (no `@Controller` prefix arg; full path on the method) | **New, mirror the pattern**: a sibling `/api/pos/v1/...` sale-capture + void + refund route in a new `sales/` module |
| Idempotency on writes | **Shipped** — `idempotency.interceptor.ts` + `@Idempotent` decorator; body-fingerprint mismatch ⇒ deterministic conflict, no side-effects | **Reuse unchanged** (FR-051); 008 adds no new primitive |
| `sourceSystem + externalId` dedup | **Shipped pattern** — natural dedup in the capture path | **Reuse the pattern** for sale/void/refund (FR-050) |
| Tenant context + RLS GUC | **Shipped** — `tenant-context.ts` middleware + `with-tenant.ts` helper set `app.current_tenant` in-transaction | **Reuse unchanged** for the new sale tables (FR-060) |
| Audit emission | **Shipped** — `audit-insert.ts` canonical insert | **Reuse** for capture/void/refund/rejection (FR-090) |
| Outbox / async | **Shipped** — `outbox/producer.ts` transactional outbox | **Reuse** for off-request processing (FR-081) |
| Sale-fact schema (`sales`/`sale_lines`/void/refund) | **NOT shipped** — no sale schema anywhere (highest migration `0011`) | **New + `[GATED]`** — Drizzle schema + `0012+` migration, its own slice |
| Sale OpenAPI contract | **NOT shipped** | **New + `[GATED]`** — its own slice; designed in `contracts/README.md`, YAML not authored here |

### 4.2 Capture is the POS-facing surface (distinct from 005/007 dashboard reads)

008's sale ingestion is a `/api/pos/v1/...` (POS-device-token) surface, like 005's `posCaptureItem` — **not** a dashboard `cookieAuth` surface. Dashboard reads of sale facts (for a future console) are a separate concern; 008 owns the capture + the minimal authorized read needed for void/refund object-resolution.

### 4.3 LOAD-BEARING: an ad-hoc sale line and an unknown-item capture are COMPLEMENTARY, not the same record

A scan with no catalog match can produce **both** an 008 `sale_line` (snapshotting price/name/tax/unit as charged, FR-004) **and** a 005 `unknown_items` capture (the catalog-reconciliation signal). They are distinct records with distinct purposes and MUST NOT be conflated; 008 MUST NOT auto-create a tenant product from a sale line (FR-004).

### 4.4 TL;DR implementability gate

All ingestion plumbing (idempotency, dedup, tenant-context/RLS, audit, outbox) is **shipped and reused unchanged**. The only genuinely new surface is the sale-fact schema + its OpenAPI contract — both `[GATED]`, each its own slice. The decision gate is closed, so there are no open WHAT-level blockers.

---

## 5. Project Structure

### 5.1 Documentation (this feature)

```text
specs/008-sales-transaction-capture/
├── spec.md                  # /speckit-specify output (+ Clarifications, gate resolutions)
├── gate-money-temporal.md   # owner decision gate — RESOLVED
├── checklists/
│   └── requirements.md      # spec-quality checklist (all pass)
├── plan.md                  # THIS FILE
├── research.md              # Phase 0 — settled decisions + rationale
├── data-model.md            # Phase 1 — entities, fields, nullability (design level, NOT DDL)
├── contracts/
│   └── README.md            # Phase 1 — operation/contract DESIGN; YAML deferred to a [GATED] slice
├── quickstart.md            # Phase 1 — planning/validation workflow (not a runtime runbook)
└── tasks.md                 # /speckit-tasks output (NOT created by this command)
```

### 5.2 Source code (repository root) — ADDITIVE only, created by implementing slices

```text
apps/api/src/catalog/sales/          # NEW module, mirrors reconciliation/ triad
├── sales.controller.ts              #   /api/pos/v1/... capture + void + refund routes
├── sales.service.ts                 #   capture/void/refund logic; reuses dedup + tenant-context
└── sales.module.ts

packages/db/src/schema/
└── sales/                           # NEW sale-fact Drizzle schema — [GATED]
    ├── sales.ts                     #   invoice header
    └── sale-lines.ts                #   line snapshots (+ void/refund terminal-event tables)

packages/db/drizzle/
├── 0012_sales.sql                   # NEW migration — [GATED], paired 0012_sales.down.sql
└── 0012_sales.down.sql

packages/contracts/openapi/
└── pos-sales/ (or catalog/sales)    # NEW OpenAPI sale contract — [GATED], NOT created here

apps/worker/                          # off-request processing (processedAt, mismatch compute) — reuses outbox
```

**Structure decision**: a new `apps/api/src/catalog/sales/` module mirroring the shipped `reconciliation/` triad. The `[GATED]` schema/migration and OpenAPI contract are **flagged, not authored** — each is its own approval-gated slice (§3.2).

---

## 6. Phase 0 — Research

See [`research.md`](./research.md). With the decision gate resolved, Phase 0 records the settled decisions (Decision / Rationale / Alternatives) rather than open research — there are no NEEDS CLARIFICATION to resolve.

## 7. Phase 1 — Design & Contracts

- **Data model**: [`data-model.md`](./data-model.md) — the four new entities at field/nullability level, honoring the gate decisions. Design level, not DDL.
- **Quickstart**: [`quickstart.md`](./quickstart.md) — the planning/validation workflow for 008 (implementation is gated).
- **Contracts**: [`contracts/README.md`](./contracts/README.md) — operation DESIGN + inherited wire conventions; explicitly defers the OpenAPI YAML to a `[GATED]` slice (no field shapes copied).
- **Agent context**: the repo root `CLAUDE.md` carries **no `<!-- SPECKIT -->` markers** (it is hand-maintained), so the speckit marker-update step does **not** apply and `CLAUDE.md` is left unmodified.

---

## 8. Implementation Phasing (advisory — `/speckit-tasks` is next)

A likely slice order (the authoritative ordered list is `tasks.md` / `execution-map.yaml`, produced by `/speckit-tasks`):

1. **`[GATED]` OpenAPI sale contract** — capture / void / refund / read-by-id operations, FR-101 error categories, `toBody` projections.
2. **`[GATED]` `0012` migration + Drizzle schema** — `sales`/`sale_lines`/void/refund + fail-closed RLS + the paired `*.down.sql`.
3. **Isolation harness extension** — cross-tenant/cross-store sweep + RLS-bypass probe for the new tables (RED).
4. **Capture (US1)** — sale + line snapshot + dedup + provenance + totals-fidelity (RED→GREEN).
5. **Delayed/offline sync (US2)** — temporal handling, server-clock security.
6. **Void / refund terminal events (US3/US4)**.
7. **Idempotency + provenance hardening (US5)** and **isolation/object-safety/audit (US6)**.
8. **Worker** — off-request `processedAt` + mismatch computation.

## 9. Out of Scope (reaffirmed)

Per spec §3/§12: no tender/payment persistence (deferred to 010, gate A.5); no pricing/tax/promotions engine; no returns/refunds workflow depth; no inventory/purchasing modeling; no reporting/analytics (012); no dashboard UI; no POS-side sale behavior; no client SDK. No `[GATED]` artifact (OpenAPI, migration, `package.json`) created by this plan.

## 10. Complexity Tracking

| Potential complexity | Decision | Why simpler alternative was viable |
|---|---|---|
| Money arithmetic library (big-decimal) | **Not added** | Gate A.2 chose single per-line **snapshot** tax (SaaS does not recompute tax), so the only computation is the per-line/half-up comparison total (A.3/A.4). A string-backed value object round-tripped to `numeric(19,4)` (A.6) covers it with no float — **no `[GATED]` `package.json` dependency**. |
| Optimistic-concurrency `version` column | **Not added** | A captured sale is an append-only immutable fact; concurrency is idempotent dedup on `sourceSystem + externalId` (gate D.1). A version column on an append-only fact is meaningless; §III's "LWW must be justified" is satisfied by this justification. |

No constitution violations. The two rows above are *avoided* complexity, recorded for provenance.

---

## Appendix — Files inspected during planning

- `.specify/memory/constitution.md` (v3.0.1) — principles + supporting sections.
- `specs/008-sales-transaction-capture/spec.md`, `gate-money-temporal.md`, `checklists/requirements.md`.
- `apps/api/src/catalog/{unknown-items,reconciliation}/*.ts` — the ingestion seam pattern (POS route style, dedup, tenant-context).
- `apps/api/src/idempotency/{idempotency.interceptor.ts,idempotent.decorator.ts}` — the reused idempotency primitive.
- `packages/db/src/{helpers/with-tenant.ts,helpers/audit-insert.ts,middleware/tenant-context.ts,outbox/producer.ts}` — reused platform helpers.
- `packages/db/drizzle/` — confirmed highest migration `0011`; no sale schema exists.
- `packages/contracts/openapi/{catalog/unknown-items.yaml,pos-*.yaml,README.md}` — inherited wire conventions.
- `specs/007-unknown-items-review-queue-api/plan.md` — house plan structure mirrored here.
