# Implementation Plan: POS Catalog Sync & Unknown Item Reconciliation

**Feature ID**: 005
**Spec**: [spec.md](./spec.md) (clarified + revised 2026-05-23; on `main` at PR #293 squash-merge `9d835eb`)
**Constitution**: v3.0.1 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: `plan/005-pos-catalog-sync-reconciliation` (planning artifacts only — implementation will land on separate gated slices)
**Status**: Draft (Phase 0–1 planning only — no code, no migrations, no contract YAML)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

> **Scope guardrail**: This plan covers ONLY the workflow that consumes
> 003's `tenant_products`, `product_aliases`, and `unknown_items` tables.
> It does **not** plan any new schema, migration, OpenAPI contract, POS
> app code, dashboard UI, sale flow, billing, analytics, reports, dbt,
> ClickHouse, Dagster, or observability dashboard work. The implementation
> path is intentionally **gated behind** the 003 service-layer slices
> (PHASE3_RED_WAVE — see §4.2). This planning artifact does **not**
> author `tasks.md`; that is a separate `/speckit-tasks` invocation.

---

## 1. Technical Context

### 1.1 Stack inheritance — no new decisions

005 introduces **no new dependencies, runtimes, or services**. The full stack is inherited unchanged from 001's plan and 003's plan:

| Concern | Inherited decision | Why it binds 005 |
|---|---|---|
| Database | PostgreSQL 16+ with RLS | Constitution §II. 005 reads and writes only 003's tables (`tenant_products`, `product_aliases`, `unknown_items`) under their existing RLS posture established in 0007–0010. |
| ORM | Drizzle ORM (TypeScript) | The 003 catalog schema modules in `packages/db/src/schema/catalog/` are the only sanctioned read/write surface for 005. |
| Migrations | Drizzle Kit → explicit SQL files | **005 introduces no migrations of its own.** All 005 storage lives on 003's existing tables and columns (including `unknown_items.sale_context jsonb` — see FR-006a and §4.3 below). |
| API framework | NestJS 11 (`apps/api/`) | Reuses 001's `TenantContextGuard`, `RolesGuard`, `RequestId`/`Logging`/`AuditEmitter` interceptors with zero modification. |
| Validation | Zod 3.x with `.strict()` at every boundary | Required for Constitution §III "body-supplied tenant_id/store_id/role/status/audit fields are never trusted" — directly binds 005's POS capture endpoint (FR-070, FR-071). |
| ID strategy | UUIDv7 (v4 fallback) | Unknown-item IDs and resolution-record IDs are UUIDs per 003's schema; 005 does not introduce a new ID strategy. |
| Idempotency | 002's request-level idempotency token + 001's idempotency interceptor | FR-021 / FR-021a / FR-021b / FR-021c consume this primitive. **005 introduces no new idempotency store.** Persistence of token→submission mapping uses the existing `idempotency_keys` infrastructure from 001 unless that infrastructure is found insufficient during Phase 0 research (see [research.md §R1](./research.md)). |
| Audit | `audit_events` + `AuditEmitter` interceptor + `audit-fanout` worker (001) | FR-080–FR-083 emit through the existing pipe. No new audit subsystem. |
| Observability signals | Pre-named in 003 §9 (`duplicate_alias_conflict`, capture/resolve/dismiss counters) | FR-081 forbids parallel naming. 005 emits into the names 003 already defines. |
| Auth principal | 002 (POS device + tenant + resolved store binding), 001 (tenant admin / store manager) | No new identity surface. |
| Workers / queues | BullMQ on Redis 7+ | No new queues; reconciliation is synchronous on the request thread. Audit-event emission rides on the existing audit-fanout queue. |

### 1.2 Inputs from the spec

- **5 prioritized user stories** (spec §5; 3× P1 capture / reconcile / fail-closed-on-conflict, 2× P2 idempotency / audit).
- **40 functional requirements** across 10 clusters (spec §6).
- **7 security/isolation requirements** (spec §7, SI-001 through SI-007).
- **8 measurable success criteria** (spec §8, SC-001 through SC-008), including the inline-capture latency target `p95 ≤ 500 ms, p99 ≤ 1 s` at the SaaS boundary.
- **12 edge cases** (spec §5 "Edge Cases").
- **5 resolved clarifications** in `## Clarifications` session 2026-05-23.

### 1.3 NEEDS CLARIFICATION

**None at the spec level** — all five clarifications resolved 2026-05-23. Three planning-level questions surfaced during the readiness probe and are listed in [research.md](./research.md). All have proposed answers; none block writing this plan or `tasks.md`.

### 1.4 Performance Goals

- **Inline capture (single-item)**: server-side `p95 ≤ 500 ms`, `p99 ≤ 1 s`, measured at the SaaS boundary (spec SC-008).
- **Bulk sync**: throughput-bounded by SC-002 (10,000 items, up to 50% unknown, deduplicated to distinct logical identifiers — no latency target).
- **Reconciliation operations**: not latency-budgeted in this spec; they are tenant-admin actions and may run on slower paths.

### 1.5 Constraints

- **003's data layer is canonical**: 005 MUST NOT mutate any 003 schema file, migration, or alias-uniqueness rule (Non-Goals §3, FR-040, FR-006a).
- **Non-disclosing errors everywhere**: cross-tenant / out-of-scope access never reveals existence (SI-001, SI-004, FR-013, FR-092).
- **Fail-closed on conflict**: any alias-uniqueness violation aborts the entire reconciliation operation transactionally (FR-041, FR-052, FR-062, FR-063, SI-005).
- **PII discipline preserved**: `unknown_items.sale_context jsonb` MUST be redacted at all logger boundaries per Constitution §XIV and 003 §8. 005 introduces no new redaction surface (SI-007).

### 1.6 Scale/Scope

- **Catalog size**: representative tenant has up to ~50k tenant products with ~100k aliases. Alias resolution per submission must run against the active alias set at SC-008 latency.
- **POS volume**: representative tenant has up to ~20 POS devices per store, ~100 stores per tenant, submission rate up to ~10/sec per store at peak (sale + sync combined).
- **Unknown-item queue depth**: representative review queue is ≤200 pending items at any time; SC-006 targets a 50-item queue cleared in 10 minutes.

---

## 2. Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (see §2.2).*

Constitution v3.0.1 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md)).

### 2.1 Initial gate evaluation

| Principle | 005 touchpoint | Verdict |
|---|---|---|
| **I. Reference, Not Source of Truth** | 005 consumes 003's authoritative tables; no parallel source of catalog truth is introduced. | ✅ Pass |
| **II. Multi-Tenant SaaS by Default** | All reads/writes flow through 003's RLS-enforced tables. Cross-tenant access is non-disclosing (SI-004, FR-013, FR-092). Workers use the same RLS-enforced pool (Constitution §II "workers not exempt"). | ✅ Pass |
| **III. Backend Authority & Data Integrity (NON-NEGOTIABLE)** | All POS-supplied fields validated by Zod at the boundary (FR-070, FR-071). `pos_supplied_label` is explicitly non-authoritative (FR-006). Concurrency safety: reconciliation operations are transactional (FR-053, FR-063); concurrent reconciliation race resolves to exactly one winner (US3 #3, FR-091 `already-reconciled`). | ✅ Pass |
| **IV. Contract-First POS Integration** | 005 reads 002's POS-Pulse identity surface. 005 does **not** define the POS capture endpoint contract in this plan — that lands in a follow-up gated slice that touches `packages/contracts/openapi/`. This plan only documents the **contract obligations** (request shape, response shape, idempotency token semantics) the eventual contract must satisfy. | ✅ Pass (with deferral noted in §8 phasing) |
| **V. Async Work Belongs in Workers** | Reconciliation is synchronous (a tenant-admin clicks "link" or "create"). Capture is synchronous (POS expects a response). Audit-event emission rides on the existing audit-fanout queue (no new queue). | ✅ Pass |
| **VI. Test-First Quality** | All planned implementation is RED-then-GREEN per 003's pattern. Phase 0 / Phase 1 deliverables include the test surfaces to seed before any service code. | ✅ Pass |
| **VII. Observable Systems** | Capture / resolve / dismiss / conflict events emit via existing signal names from 003 §9. `idempotency-token-mismatch` is a new failure category (FR-091) — this is a new metric name, see Architecture Impact Map §3.4 below. | ✅ Pass with note |
| **VIII. Reproducible & Versioned Releases (`[GATED]`)** | 005 implementation will touch `packages/contracts/openapi/**` (new POS capture endpoint) and `apps/api/src/**` (new service modules). Migrations: **none from 005**. The contract change is gated and will require explicit `[GATED]` approval on its own slice. | ✅ Pass with gate flagged |
| **IX. Source-of-Truth Model** | 005 introduces no parallel catalog records. Unknown items are not products (FR-001–FR-003 enforce 003's lifecycle). Tenant products are created only via explicit human reconciliation (SI-006, FR-060–FR-063). | ✅ Pass |
| **X. Retail Temporal Semantics** | Reconciliation never rewrites prior captures (FR-004 monotonic transitions, FR-005 fresh `pending` on resubmit). Past records are preserved verbatim. | ✅ Pass |
| **XI. Idempotency & External IDs** | FR-021 / FR-021a / FR-021b / FR-021c codify token semantics. `external_pos_id` aliases scoped by `source_system` per 003 §6 (FR-040). | ✅ Pass |
| **XII. Authorization & Object Safety** | Tenant-wide vs store-scoped authority is consumed from 001's membership model (FR-015, SI-003). Cross-store reconciliation is permitted only when the existing model grants tenant-wide authority. | ✅ Pass |
| **XIII. Auditability & Provenance** | Every state transition emits an audit event with `correlation_id` (FR-080–FR-083). Failed reconciliation attempts are first-class audit events (FR-082). | ✅ Pass |
| **XIV. PII & Data Lifecycle Discipline** | Identifier values are catalog reference data (not PII). `pos_supplied_label` flows through 003's existing `sale_context jsonb` redaction posture (FR-006, SI-007). No new redaction surface. | ✅ Pass |

**Initial gate verdict**: ✅ All 14 principles pass; no violations to justify in Complexity Tracking.

### 2.2 Post-design re-check

To be filled in after Phase 1 outputs (data-model.md, quickstart.md, contracts/) are written.

**Post-design verdict**: ✅ No deltas from §2.1 — Phase 1 outputs introduce no new principles touched, no new gates triggered. The Architecture Impact Map in §3 below captures the only architecture-affecting deltas (new idempotency-mismatch metric name, new POS capture endpoint operationId, new audit-event subjects). All remain Pass.

---

## 3. Architecture Impact Map

Per Working Agreement appendix and [`.specify/memory/architecture-impact.md`](../../.specify/memory/architecture-impact.md).

### 3.1 Impact Classification

- **Impact level**: **High**
- **Reason**: 005 introduces a new POS-facing endpoint (capture + dismiss + link + create reconciliation actions) backed by new NestJS service modules consuming 003's catalog tables. The change crosses the API ↔ DB boundary on a hot path (POS sale flow), introduces a new OpenAPI contract surface, emits new audit event subjects, and consumes an existing idempotency primitive in a new way. No new schema migration, no new external provider, no auth-surface change.
- **Boundary crossings**:
  - **API → Worker**: none (audit-fanout queue is an existing producer/consumer pair; 005 emits via the existing `AuditEmitter` interceptor).
  - **API → DB**: new reads of `tenant_products`, `product_aliases`, `unknown_items`; new writes of `unknown_items` (INSERT + UPDATE for lifecycle transitions) and `product_aliases` (INSERT + reactivation); conditional writes of `tenant_products` (create-new reconciliation path FR-061).
  - **Worker → DB**: none (audit-fanout already reads `audit_events` and `outbox_events`; 005 adds rows to those existing tables but introduces no new worker-side query).
  - **Package boundary**: new internal API surface from `apps/api/src/catalog/` (new module) consumed by the new POS capture controller. No cross-package import expansion.
  - **External provider**: none.
  - **OpenAPI/codegen**: new `operationId`s under `packages/contracts/openapi/`. Exact names deferred to the contract slice (see §8.3). Anticipated: `posCaptureItem`, `tenantAdminListUnknownItems`, `tenantAdminLinkUnknownItem`, `tenantAdminCreateProductFromUnknownItem`, `tenantAdminDismissUnknownItem`.
  - **Runtime/deployment**: none.

### 3.2 Triggered Review Gates

- [x] **DB read/write → RLS / tenant-context strategy required.**
      Pointer: 005 reads/writes are gated by 003's existing RLS policies (post-0010). New integration tests under `apps/api/test/catalog/unknown-items/**` (planned) extend 003's isolation harness pattern for the new operations. Strategy: every service call uses `runWithTenantContext(...)` from 001's helpers; no raw pool access. See [data-model.md §3 RLS posture](./data-model.md).
- [x] **OpenAPI / API contract change → contract validation and codegen impact required.**
      Pointer: contract YAML(s) added under `packages/contracts/openapi/catalog/` (path TBD by contract slice). Conformance tests under `packages/contracts/__tests__/`. This contract change is `[GATED]` and lands on its own slice — see §8.3.
- [x] **Queue / job publish or consume → producer / consumer contract tests required.**
      Pointer: 005 produces audit events for capture/resolve/dismiss/conflict transitions (FR-080–FR-083). Producer-side tests under `apps/api/test/catalog/unknown-items/audit/**`. Consumer side already exists (audit-fanout worker, tested in `apps/worker/test/audit/**`); 005 verifies the audit-fanout still consumes 005's emitted events under the existing fanout contract — no new consumer test path.
- [ ] **Auth / session / token change → threat review, generic refusal, and audit / redaction review required.**
      Pointer: _not triggered_ — 005 consumes 001 + 002 auth/session/token surface unchanged. No new principal type, no new role, no new session shape.
- [ ] **Package dependency change → explicit approval required.**
      Pointer: _not triggered_ — 005 introduces no new runtime dependency. All work uses existing dependencies (NestJS 11, Drizzle, Zod, BullMQ, pino).
- [ ] **Cross-package or cross-app import → boundary justification required.**
      Pointer: _not triggered_ — 005 stays within `apps/api/src/catalog/`, consuming `packages/db/src/schema/catalog/` and `packages/db/src/helpers/` (both already on the import allow-list for `apps/api`).
- [x] **External provider integration → verification, outage, and failure-mode plan required.**
      Pointer: _intentionally checked_ for the POS-Pulse seam, even though POS-Pulse is "external" only in the topological sense (separate repo, owned by us). The seam contract is governed by 002. Failure modes — POS submission while POS-Pulse is offline, retry storm, malformed payload (FR-070, FR-071), expired idempotency token (FR-021b) — are addressed in [research.md §R2 Failure modes](./research.md).

### 3.3 Required dimensions

| Dimension | Impact |
|---|---|
| Affected modules / packages | `apps/api/src/catalog/` (new module: capture controller, reconciliation service, unknown-item service); `packages/contracts/openapi/catalog/` (new contract YAML — gated, lands on separate slice); `apps/api/test/catalog/unknown-items/` (new integration tests). |
| DB tables read | `tenant_products`, `product_aliases`, `unknown_items` (all 003-owned); `memberships`, `stores`, `tenants` (001-owned, for principal resolution). |
| DB tables written | `unknown_items` (INSERT, UPDATE); `product_aliases` (INSERT, UPDATE for reactivation); `tenant_products` (INSERT — only in the create-new reconciliation path); `audit_events` (existing append-only via interceptor); `outbox_events` (existing append-only via AuditEmitter). |
| APIs / OpenAPI contracts changed | New `operationId`s anticipated: `posCaptureItem`, `tenantAdminListUnknownItems`, `tenantAdminLinkUnknownItem`, `tenantAdminCreateProductFromUnknownItem`, `tenantAdminDismissUnknownItem`. Exact YAML paths and operationIds are decided on the contract slice (gated). |
| Events / jobs published | Audit events with subjects: `unknown_item.captured`, `unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.dismissed`, `unknown_item.reconciliation_conflict_rejected`, `unknown_item.idempotency_mismatch_rejected`. All ride on the existing audit-fanout queue. |
| Events / jobs consumed | None new. The existing audit-fanout worker continues to consume `audit_events`; 005 verifies its events round-trip through that worker without a new consumer. |
| Files likely to require edits | New: `apps/api/src/catalog/unknown-items/**`, `apps/api/src/catalog/reconciliation/**`, `apps/api/test/catalog/unknown-items/**`, `packages/contracts/openapi/catalog/unknown-items.yaml` (gated slice). Modified: none in 003 paths (003 is read-only for 005). Modified: `apps/api/src/catalog/catalog.module.ts` (wire new providers). |
| Risky dependencies / boundary concerns | None new. The most boundary-adjacent concern is the new POS capture endpoint living next to existing POS-Pulse contract surface — addressed by the gated contract slice (§8.3). |
| Regression test areas | (a) **RLS bypass probe** (`apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts`) — must remain GREEN after 005's reads/writes are wired; (b) **cross-tenant read** (T341) — must remain GREEN; (c) **cross-store read** (T342) — must remain GREEN; (d) **alias uniqueness** (T383 RED suite when it lands) — must remain GREEN; (e) **idempotency replay** (existing 001 idempotency tests) — must remain GREEN; (f) **audit-event emission** (existing audit-fanout tests) — must remain GREEN. |

### 3.4 New observability signals introduced by 005

005 introduces **one** new metric name beyond 003 §9's pre-named signals:

- `idempotency_token_mismatch_total` — counter, incremented on every FR-021c rejection (token reused within TTL with a different payload). Labels: `tenant_id` (low-cardinality bucket if needed), `endpoint`. **Note**: this metric does NOT contradict FR-081 (signal names conform to 003 §9) because it is an idempotency-axis signal, not a catalog-axis signal — 003 §9 names catalog signals only. The idempotency signal is a 005-owned name with no parallel in 003.

All other 005 metrics are pre-named in 003 §9:
- `unknown_item_captured_total`, `unknown_item_resolved_total{action="linked|created|dismissed"}`, `duplicate_alias_conflict_total` — all 003-named.

---

## 4. 003 Dependency Readiness

The 005 spec was written assuming "003's spec is clarified but not yet implemented at runtime" (spec §9 Assumptions). That assumption is **stale**. As of `origin/main` at `ec37815` (2026-05-23), substantial portions of 003 are merged. This section documents what 005 can safely depend on now versus what remains a prerequisite.

### 4.1 003 — merged and usable

The following 003 deliverables are on `main` and are safe inputs to 005:

| Component | Location | Closed-out by | Status |
|---|---|---|---|
| **Catalog schema modules** (Drizzle) | `packages/db/src/schema/catalog/` — 7 files: `tenant-products.ts`, `tenant-product-categories.ts`, `product-aliases.ts`, `store-product-overrides.ts`, `global-products.ts`, `price-history.ts`, **`unknown-items.ts`** | T320 | merged |
| **Catalog migration 0007** (schema + RLS policies) | `packages/db/drizzle/0007_catalog.sql` | T330 | merged |
| **0008 store-read isolation fix** | `packages/db/drizzle/0008_catalog_store_read_isolation.sql` | RLS_CROSS_STORE_FIX | PR #254 @ `483aae4` |
| **0009 store-GUC empty-string CASE guard** | `packages/db/drizzle/0009_catalog_store_empty_guc_fix.sql` | 0009_STORE_GUC_FIX | PR #279 @ `e33fd0e` |
| **0010 tenant-GUC empty-string CASE guard** | `packages/db/drizzle/0010_catalog_tenant_empty_guc_fix.sql` | 0010_CATALOG_TENANT_GUC_CAST_FIX | PR #292 @ `6adf6df` |
| **`withTenant` helper coverage** for catalog tables | `packages/db/__tests__/helpers/with-tenant-catalog.spec.ts` | T335 | PR #260 @ `5801369` |
| **Catalog isolation test harness** | `apps/api/test/catalog/__support__/isolation-harness.ts` | T340 (+ HARNESS_FIX) | PR #264 @ `02cdf75`, fixed in PR #279 |
| **Cross-tenant read isolation tests** (31 assertions) | `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts` | T341 | PR #268 @ `263492a` |
| **Cross-store read isolation tests** | `apps/api/test/catalog/isolation/cross-store-read.spec.ts` | T342 | PR #285 @ `fd18598` (4 it.todo deferred — see §4.4) |
| **RLS bypass probe** | `apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts` | T343 | PR #285 @ `fd18598` (35 passed / 4 todo after PR #292) |
| **Malicious body-override sweep** | `apps/api/test/catalog/isolation/malicious-override.spec.ts` | T344 | PR #285 @ `fd18598` (no deferred coverage) |

**Net**: 005's **data layer dependency is satisfied**. The tables exist on disk and in `main`'s migration set with the alias-uniqueness rules and lifecycle states the 005 spec consumes. The `unknown_items.sale_context jsonb` field that FR-006a points at is confirmed in `packages/db/src/schema/catalog/unknown-items.ts:45`.

### 4.2 003 — service layer NOT YET on main (the actual 005 implementability gate)

005's reconciliation FRs (FR-050 link, FR-060 create-new, FR-040–FR-043 alias uniqueness as service behavior) depend on 003's **service layer**, not just its data layer. The service layer is currently `proposed` in `execution-map.yaml` as `PHASE3_RED_WAVE` and is not yet merged:

| 003 slice | Proposed test surface | What it provides 005 |
|---|---|---|
| `T350_TENANT_CATALOG_CREATE_RED` | `apps/api/test/catalog/tenant-catalog.service.create.spec.ts` | The `TenantCatalogService.create()` surface 005's FR-060 / FR-061 consume to create a tenant product from an unknown item. |
| `T360_GLOBAL_CATALOG_LIST_RED` | `apps/api/test/catalog/global-catalog.service.list.spec.ts` | Not directly consumed by 005 (Global Product Index is reference-only); listed for completeness. |
| `T372_STORE_OVERRIDE_CREATE_RED` | `apps/api/test/catalog/store-override.service.create.spec.ts` | Not directly consumed by 005 in the MVP (005 does not adjust store overrides); listed for completeness. |
| `T383_PRODUCT_ALIASES_UNIQUENESS_RED` | `apps/api/test/catalog/product-aliases.service.spec.ts` | The `ProductAliasesService` surface 005's FR-040 / FR-041 / FR-050 / FR-061 consume to write aliases under the uniqueness rules. **Hard prerequisite for every 005 reconciliation FR.** |

**Net**: `PHASE3_RED_WAVE` is **`proposed: true` — not yet endorsed** per [`wave-status.md` line 137-149](../003-catalog-foundation/wave-status.md). 005's reconciliation implementation **must wait for** T350 + T383 (at minimum) to land on `main`. T360 + T372 can land in parallel or after; they are not on 005's critical path.

**Sequencing implication for §8 phasing**: 005's capture path (US1, FR-001 through FR-032) can be designed and contract-stubbed **now** because it only needs `unknown_items` (which is live). 005's reconciliation paths (US2, FR-050–FR-063) cannot land until T350 + T383 are merged.

### 4.3 PR #292 / 0010 tenant-GUC CASE guard — direct impact on 005

PR #292 (`6adf6df`) merged 2026-05-23, adding a `CASE` guard around the tenant-GUC cast in 13 RLS policy bodies across 5 catalog tables, including `unknown_items` INSERT/UPDATE policies and the combined SELECT policy. This unblocks 5 of T343's previously-deferred `it.todo` assertions on the tenant-unset read path.

**What this means for 005**:

- The tenant-GUC unset path is now **fail-closed by NULL match** (returns 0 rows) instead of throwing `SQLSTATE 22P02`. 005's capture and reconciliation operations all run inside `runWithTenantContext`, so they explicitly set `app.current_tenant` — this defect was never on 005's hot path. The impact is **defense-in-depth only**: if a 005 code path were ever to forget to set the tenant GUC, the policy now fails closed instead of throwing. 005 still MUST always set the tenant GUC; the CASE guard is not an excuse to omit it.
- 005's planned integration tests should include an assertion that `unknown_items` cross-tenant reads return 0 rows under tenant-set-but-wrong-tenant (already covered by T341's pattern) **and** under tenant-unset (now executable per PR #292). Both belong in 005's new `apps/api/test/catalog/unknown-items/isolation/` suites.

**No 005 plan adjustment** required beyond inheriting the post-0010 RLS posture.

### 4.4 Remaining 003 deferred work — store-axis fail-closed on absent GUC

Active finding `RLS_STORE_ABSENT_READ_LEAK` (`execution-map.yaml` finding entry, `wave-status.md` "Active findings") tracks 4 `it.todo` assertions in T342/T343 for the §4.6 / §7.6 store-axis path: tenant-set, `app.current_store` GUC absent. The matrix prescribes 0 rows; PG returns `''` not NULL on never-set GUC, and 0009's CASE guard carves out `''` as a tenant-owner empty-string match. The store-absent path is therefore not currently fail-closed; it returns visible rows under a never-set store GUC.

**Resolution path** per `wave-status.md` line 156-161: a new gated SQL slice `0011_CATALOG_STORE_CARVEOUT_SENTINEL` distinguishing "GUC explicitly empty (tenant-owner carve-out)" from "GUC never set (fail-closed)" via a dedicated sentinel value. **0011 is not yet authored, not yet approved, not on main.**

**What this means for 005**:

- 005's normal hot paths always set both `app.current_tenant` and `app.current_store` via `runWithTenantContext` (capture is store-scoped per FR-010, FR-011). The store-axis absent-GUC defect is on a code path 005 **never exercises in production**.
- 005's planned cross-store isolation tests for `unknown_items` will inherit the same 4 `it.todo` deferrals that T342/T343 already carry. This is **acceptable** for 005 because the matrix already documents it as a 003-owned deferred finding; 005 does not weaken the existing posture.
- **005 does NOT gate on 0011 merging.** If 0011 lands during 005 implementation, 005's new integration tests can flip their corresponding `it.todo`s to executable assertions as a follow-up. If 0011 has not landed by the time 005 ships, 005 ships with the matching it.todo placeholders.

**Recommendation**: track 0011 as an independent 003 slice. Do not make 005 wait for it.

### 4.5 `MISSING_WITHSTORE_HELPER` — not on 005's critical path

Active finding `MISSING_WITHSTORE_HELPER` (low severity) blocks only T336 (a 003 test). The helper file `packages/db/src/helpers/with-store.ts` is referenced by 003's `rls-test-matrix.md:464-465` and 003's `plan.md:210` but does not exist on disk.

**What this means for 005**:

- 005's planned implementation reuses **001's `runWithTenantContext` helper** (already used throughout 003's harness). 005 does not need a separate `withStore` helper; the tenant context + store GUC are set together inside one transactional context. This pattern matches T335_TENANT_HELPER_COVERAGE's resolution.
- **No 005 dependency on this finding.** It can stay open and 005 can still ship.

### 4.6 `pos_supplied_label` — confirmed NOT a gated 003 prerequisite

Per FR-006 and FR-006a (revised 2026-05-23 — see [spec.md `## Clarifications` session 2026-05-23](./spec.md#clarifications)), 005 **does not require any new column on `unknown_items`**. Optional POS-supplied descriptive metadata travels inside the existing `unknown_items.sale_context jsonb` field, which:

- exists on disk: `packages/db/src/schema/catalog/unknown-items.ts:45` — `saleContext: jsonb("sale_context")`.
- is documented as opaque + redaction-flowed in 003's schema header: `unknown-items.ts:10-12`.
- has the redaction posture mandated by 003 §8 and Constitution §XIV — 005 does not weaken or extend this.

**Net**: there is **no gated 003 prerequisite for `pos_supplied_label`**. The hypothetical dedicated typed column lives only in spec.md's non-normative Appendix B as forward-looking guidance for a possible future feature.

### 4.7 005 implementability gate — TL;DR

| 005 user story / FR cluster | 003 dependency | Status | Can implement now? |
|---|---|---|---|
| **US1 capture** (FR-001–FR-005, FR-010–FR-015, FR-020–FR-022, FR-030–FR-032, FR-070–FR-072) | `unknown_items` table + RLS + isolation harness | Merged | ✅ Yes |
| **US3 alias conflicts** (FR-040–FR-043) | `ProductAliasesService` from T383 | Proposed, not merged | ❌ Blocked on T383 |
| **US2 link reconciliation** (FR-050–FR-053) | `ProductAliasesService` (T383) + `TenantProductsService.findActive()` (T350-area read) | Proposed, not merged | ❌ Blocked on T350 + T383 |
| **US2 create-new reconciliation** (FR-060–FR-063) | `TenantCatalogService.create()` from T350 + `ProductAliasesService` from T383 | Proposed, not merged | ❌ Blocked on T350 + T383 |
| **US4 idempotency** (FR-021, FR-021a, FR-021b, FR-021c) | 001's idempotency interceptor + idempotency_keys table | Merged (001 closed) | ✅ Yes — see [research.md §R1](./research.md) |
| **US5 audit & observability** (FR-080–FR-083) | 001's AuditEmitter + audit-fanout + 003's signal naming | Merged + named | ✅ Yes |

**Effective gate**: 005's reconciliation path (US2, US3) is **blocked on PHASE3_RED_WAVE endorsement** (specifically T350 + T383). 005's capture path (US1, US4, US5) is **unblocked** — it can land on its own. **Recommend** that the 005 implementation be sequenced in two waves: **wave 1** capture + idempotency + audit, **wave 2** reconciliation (after T350 + T383 merge). See §8.

---

## 5. Project Structure

### 5.1 Documentation (this feature)

```text
specs/005-pos-catalog-sync-reconciliation/
├── spec.md                 # source spec (canonical on main, 9d835eb)
├── plan.md                 # this file (/speckit-plan output)
├── research.md             # Phase 0 output (/speckit-plan output)
├── data-model.md           # Phase 1 output (/speckit-plan output)
├── quickstart.md           # Phase 1 output (/speckit-plan output)
├── contracts/
│   └── README.md           # placeholder only — final OpenAPI contracts deferred to a gated slice (§8.3)
├── checklists/
│   └── requirements.md     # spec quality checklist (from /speckit-specify + /speckit-clarify)
└── tasks.md                # Phase 2 output (/speckit-tasks command — NOT created by this plan)
```

### 5.2 Source code (repository root) — additive only

005 **adds** to the workspace established in 001 + 003; it does **not** restructure. Concrete new paths (proposed only; actual scaffolding belongs to `/speckit-tasks`):

```text
apps/api/src/
└── catalog/
    ├── unknown-items/             # NEW (005-owned)
    │   ├── unknown-items.controller.ts        # POS capture endpoint + tenant-admin list/dismiss
    │   ├── unknown-items.service.ts           # capture / list / dismiss; consumes 003 schema
    │   └── unknown-items.module.ts
    ├── reconciliation/            # NEW (005-owned)
    │   ├── reconciliation.controller.ts       # tenant-admin link / create-new
    │   ├── reconciliation.service.ts          # consumes T350 + T383 services (003-owned, future)
    │   └── reconciliation.module.ts
    └── catalog.module.ts          # MODIFIED (wire 005 sub-modules)

apps/api/test/
└── catalog/
    └── unknown-items/             # NEW (005-owned)
        ├── capture/
        │   ├── capture.spec.ts                    # FR-001-005, FR-010-015, FR-030-032
        │   ├── idempotency.spec.ts                # FR-020-022, FR-021a-c
        │   └── validation.spec.ts                 # FR-070-072
        ├── reconciliation/
        │   ├── link.spec.ts                       # FR-050-053
        │   ├── create-new.spec.ts                 # FR-060-063
        │   ├── conflict.spec.ts                   # FR-040-043 + US3 races
        │   └── dismiss.spec.ts                    # FR-003 dismiss + FR-005 resubmit
        ├── audit/
        │   └── emission.spec.ts                   # FR-080-083
        └── isolation/
            ├── cross-tenant.spec.ts               # SI-001, FR-013 (extends T341 pattern)
            ├── cross-store.spec.ts                # SI-002, FR-014 (extends T342 pattern)
            └── non-disclosing-errors.spec.ts      # SI-004, FR-092

packages/contracts/openapi/catalog/
└── unknown-items.yaml             # NEW — GATED slice (§8.3); not authored by /speckit-plan
```

**Structure Decision**: NestJS monorepo with `apps/api` (HTTP surface) + `apps/worker` (BullMQ consumers) + `packages/db` (Drizzle schema + helpers) + `packages/contracts` (OpenAPI). 005 lives entirely under `apps/api/src/catalog/` and `apps/api/test/catalog/`, with one gated contract YAML under `packages/contracts/openapi/catalog/`. No `apps/worker/`, no other `apps/*/`, and no other `packages/*/` paths are touched.

---

## 6. Phase 0 outputs

See [research.md](./research.md) for full Phase 0 outputs. Summary of resolved questions:

- **R1** — Idempotency primitive: reuse 001's `idempotency_keys` infrastructure with key tuple `(tenant_id, device_id, token)`; TTL ≥24h enforced at the lookup path; payload-fingerprint comparison for FR-021c mismatch detection.
- **R2** — Failure modes (POS-Pulse offline, retry storm, expired token, malformed payload): documented response taxonomy mapping each failure to FR-091 category.
- **R3** — Performance budget validation: SC-008 (p95 ≤ 500 ms, p99 ≤ 1 s) achievability against the planned implementation (Drizzle prepared statements, single transaction per capture, alias-lookup index `idx_unknown_items_lookup_value`).

---

## 7. Phase 1 outputs

### 7.1 Data model

See [data-model.md](./data-model.md). Summary: 005 introduces **zero new entities**. Maps 005 FRs to 003 entities/columns: `unknown_items.{tenant_id, store_id, identifier_type, value, source_system, sale_context, resolution_status, resolved_at, resolved_by, resolution_action, resolved_product_id, correlation_id, encountered_at}` and `product_aliases.{tenant_id, store_id?, product_id, identifier_type, value, source_system?, retired_at}` and `tenant_products.{tenant_id, status, ...}`.

### 7.2 Quickstart

See [quickstart.md](./quickstart.md). A tenant-admin reconciliation walkthrough: a POS captures an unknown barcode → tenant admin sees it in the review queue → links it to an existing product → alias is created → next POS submission for the same barcode resolves to the linked product.

### 7.3 Contracts

See [contracts/README.md](./contracts/README.md). Final OpenAPI YAML is **deferred to a gated slice** (§8.3). The README documents the contract obligations the eventual YAML must satisfy.

### 7.4 Agent context update

Per the plan-template's Phase 1 step, the plan reference in `CLAUDE.md` (between SPECKIT markers) should be updated to point at this file. **CLAUDE.md has no `<!-- SPECKIT START -->` / `<!-- SPECKIT END -->` markers on this repo** (verified by inspection), so this step is a no-op. The repo's CLAUDE.md uses a different convention (Agent OS standing-rules + per-feature memory files); no Spec Kit marker swap is required.

---

## 8. Implementation Phasing (advisory — `/speckit-tasks` is the next command)

005 implementation is **gated behind 003 service-layer readiness** (see §4.7). The recommended phasing splits 005 into two waves so the unblocked capture path can land independently. **This plan does NOT create `tasks.md`** — that is `/speckit-tasks`. The phasing below is advisory for the future tasks-author.

### 8.1 Wave 1 — Capture path (unblocked, can land today)

- Scope: US1 (capture), US4 (idempotency), US5 (audit) — FR-001–FR-005, FR-010–FR-032, FR-070–FR-083.
- 003 dependencies: data layer only (all merged). No service-layer dependency on T350/T383.
- Deliverables: `apps/api/src/catalog/unknown-items/` module; `apps/api/test/catalog/unknown-items/{capture,audit,isolation}/` test surfaces; new audit-event subjects (`unknown_item.captured`, `unknown_item.dismissed`); new metric `idempotency_token_mismatch_total`.
- Gated surfaces touched: `packages/contracts/openapi/catalog/unknown-items.yaml` for the `posCaptureItem` + `tenantAdminListUnknownItems` + `tenantAdminDismissUnknownItem` operationIds (§8.3 below).
- Estimated slice count: 4–6 RED-then-GREEN slices.

### 8.2 Wave 2 — Reconciliation path (blocked on PHASE3_RED_WAVE)

- Scope: US2 (link, create-new), US3 (alias conflicts) — FR-040–FR-063.
- 003 dependencies: T350_TENANT_CATALOG_CREATE merged + T383_PRODUCT_ALIASES_UNIQUENESS merged.
- Deliverables: `apps/api/src/catalog/reconciliation/` module; `apps/api/test/catalog/unknown-items/reconciliation/` test surfaces; new audit-event subjects (`unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.reconciliation_conflict_rejected`).
- Gated surfaces touched: `packages/contracts/openapi/catalog/unknown-items.yaml` extended for `tenantAdminLinkUnknownItem` + `tenantAdminCreateProductFromUnknownItem` operationIds.
- Estimated slice count: 3–5 RED-then-GREEN slices.

### 8.3 Gated contract slice — separate, lands before either wave's implementation

The OpenAPI contract YAML under `packages/contracts/openapi/catalog/` is a `[GATED]` surface per Constitution §VIII and Standing Rules §3. It lands as its own dedicated slice **before** either wave's implementation slices, so the implementation slices have a stable contract to test conformance against.

- Scope: contract YAML + conformance tests under `packages/contracts/__tests__/`.
- Approval: requires explicit `[GATED]` approval at slice-dispatch time per Standing Rules §3 + Constitution §VIII.
- Sequencing: contract slice → Wave 1 capture slices → Wave 2 reconciliation slices (after T350 + T383 merge).

### 8.4 What this plan does NOT schedule

- No SQL migrations (none needed — see §1.1, §4).
- No 003 amendments (003 schema and migrations are read-only for 005 — see §3.3, §4.6).
- No POS app code (separate repo).
- No dashboard UI (out of scope — spec §3 Non-Goals).
- No analytics, reports, dbt, ClickHouse, Dagster, billing, or observability dashboard work (out of scope — spec §3).
- No `tasks.md` (that is `/speckit-tasks`).

---

## 9. Out of Scope (Reaffirmed)

Re-stated from spec §3 + §12 for the eventual tasks-author:

- No code in this PR. No `tasks.md`. No commit, no push, no PR open (per the user's planning brief).
- No edits to `specs/003-catalog-foundation/**` — 003 is read-only for 005.
- No SQL migrations of 005's own.
- No edits to `packages/db/src/schema/**` for 005 (additive or otherwise).
- No edits to `packages/contracts/openapi/**` in this planning PR — the contract slice is a separate gated dispatch (§8.3).
- No `.github/**`, `package.json`, `pnpm-lock.yaml`, or CI changes.
- No edits under `apps/api/src/**` or `apps/worker/**` in this planning PR — implementation lands in §8 waves.
- No POS app, no dashboard, no billing, no analytics, no reports.

---

## 10. Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified.**

**No Constitution violations** — §2.1 and §2.2 both verdict ✅ across all 14 principles. Complexity Tracking is therefore intentionally empty for 005.

---

## Appendix — Files inspected during planning

Read-only inputs to this plan (all on `origin/main` at `ec37815` unless noted):

| Path | Why read |
|---|---|
| `.specify/memory/constitution.md` | Constitution v3.0.1 — gate evaluation in §2. |
| `.specify/memory/architecture-impact.md` | Architecture Impact Map rule (Working Agreement appendix) — drives §3. |
| `.specify/feature.json` | Confirm `feature_directory: specs/005-pos-catalog-sync-reconciliation`. |
| `.specify/templates/plan-template.md` | Template (copied by `setup-plan.ps1`); structure adapted to monorepo style established by 003. |
| `docs/agent-os/standing-rules.md` | Branch hygiene, forbidden surfaces, slice discipline, gate rules. |
| `docs/agent-os/maestro-playbook.md` | Slice dispatch shape — informs §8 phasing structure. |
| `specs/003-catalog-foundation/spec.md` | 003 spec — entity contracts inherited. |
| `specs/003-catalog-foundation/plan.md` | 003 plan style reference. |
| `specs/003-catalog-foundation/tasks.md` | 003 task conventions (T### numbering, `[P]`, `[GATED]`, `[TC]` markers). |
| `specs/003-catalog-foundation/execution-map.yaml` | Authoritative state of 003 slices and findings — drives §4. |
| `specs/003-catalog-foundation/wave-status.md` | Human-readable 003 status — cross-validated §4 against this. |
| `specs/005-pos-catalog-sync-reconciliation/spec.md` | The spec this plan implements. |
| `specs/005-pos-catalog-sync-reconciliation/checklists/requirements.md` | Confirm spec is clarify-complete (zero NEEDS CLARIFICATION). |
| `packages/db/drizzle/*.sql` (listing only) | Confirm 0007–0010 present on disk. |
| `packages/db/src/schema/catalog/*.ts` (listing only) | Confirm 7 catalog schema files present on disk. |
| `packages/db/src/schema/catalog/unknown-items.ts` | Confirm `sale_context jsonb` column exists (FR-006a). |
| `apps/api/test/catalog/__support__/` (listing only) | Confirm isolation harness present on disk. |
| `apps/api/test/catalog/isolation/*.spec.ts` (listing only) | Confirm T341/T342/T343/T344 specs present on disk. |
