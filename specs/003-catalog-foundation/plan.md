# Implementation Plan: Catalog Foundation

**Feature ID**: 003
**Spec**: [spec.md](./spec.md) (clarified 2026-05-15; uncommitted at plan time — to be referenced by commit hash on PR)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: `claude/catalog-foundation`
**Status**: Draft (Phase 2 planning complete — no code generated)
**Created**: 2026-05-15
**Owner**: Ahmed Shaaban

> **Scope guardrail**: This plan covers ONLY the catalog source-of-truth
> layers and cross-cutting concepts described in spec §5–§6. It does **not**
> plan inventory, orders, carts, sales, payments, refunds, invoices,
> SaleLine Snapshot implementation, POS sync endpoints, dashboard UI, tax
> engines, promotions/discounts, suppliers, dbt, ClickHouse, Dagster,
> analytics, reporting, or billing. POS-related work is limited to the
> **read-model seam** (snapshot + delta direction recorded per spec
> §6.4 / Q12) — no POS endpoint is designed here.
>
> Per owner sign-off: no `tasks.md`, no application code, no DB schema, no
> migrations, no OpenAPI YAML beyond a reservation README, no `package.json` /
> `pnpm-lock.yaml` / CI / generated-file changes.

---

## 1. Technical Context

### 1.1 Stack inheritance from Feature 001

Catalog Foundation inherits the full TypeScript-first stack chosen in 001
([../001-foundation-auth-tenant-store/plan.md §1.1](../001-foundation-auth-tenant-store/plan.md)).
Nothing in spec 003 motivates a stack change. Re-stated only where the
decision is **load-bearing for catalog work**:

| Concern | Inherited decision | Why it binds catalog work |
|---|---|---|
| Database | PostgreSQL 16+ | Constitution §3; RLS enforces tenant + store isolation across the four catalog layers in spec §5. |
| ORM | Drizzle ORM (TypeScript) | Drizzle tenant-scoped helpers (`withTenant`, `withStore`) from 001 are the only sanctioned read/write path for catalog tables. |
| Migrations | Drizzle Kit → explicit SQL files | Required by Constitution §8 and by the spec §3 non-goal forbidding silent schema mutation. |
| API framework | NestJS 11 | Reuses 001's `TenantContextGuard`, `RolesGuard`, `RequestId` / `Logging` / `AuditEmitter` interceptors with **zero modification** — they are already catalog-aware via tenant/store context. |
| Validation | Zod 3.x with `.strict()` at every boundary | Required for spec §10 "body-supplied tenant_id / store_id / role / status / audit fields are never trusted." |
| ID strategy | UUIDv7 (v4 fallback) | Spec §6.1 alias resolution must not depend on enumerable IDs; UUIDv7's time-locality is fine for catalog growth patterns. |
| Money | Exact-decimal **only**; floating-point money forbidden everywhere | Constitution §3 and spec Q1 (`numeric(19,4)`). Re-affirmed here because catalog is the first feature that *introduces* money rows. |
| Observability | pino + OpenTelemetry + Prometheus exporter | New signals (§9 of spec) plug into the existing exporter; no new infra. |
| Audit | `audit_events` table + `AuditEmitter` interceptor + `audit-fanout` worker (from 001) | Catalog audit events in spec §8 are emitted through the same pipe — no new audit subsystem. |
| ID for aliases / external POS IDs | `sourceSystem + externalId` per Constitution §11 | Required by spec §6.1 / Q4. |

### 1.2 Inputs from the spec

- **7 required scenarios** (spec §7, S1–S7).
- **4 source-of-truth layers** (spec §5): Global Product Index, Tenant
  Catalog, Store Override, SaleLine Snapshot (future).
- **4 cross-cutting concepts** (spec §6): Product Aliases, Price History,
  Unknown Item Workflow, Resolved Catalog View.
- **12 resolved clarifications** (spec §16: Q1–Q12). Treated as binding
  constraints in this plan — see §2.1.
- **8 audit event classes** (spec §8) and **4 observability signals**
  (spec §9).
- **8 test obligations** (spec §13).

### 1.3 NEEDS CLARIFICATION

**None.** All twelve open questions from the spec are resolved (spec §16).

### 1.4 Suggested workspace footprint (additive only)

> Documentation only — actual scaffolding belongs to `/speckit.tasks`, which
> is out of scope per owner sign-off.

This feature **adds** to the workspace established in 001; it does **not**
restructure it.

```
packages/
├─ db/                     # 001 already owns this package
│  └─ schema/
│     └─ catalog/          # NEW (proposed) — catalog tables live here:
│                          #   global_products, tenant_products,
│                          #   store_product_overrides, product_aliases,
│                          #   price_history, unknown_items
└─ contracts/
   └─ openapi/
      └─ catalog/          # NEW (proposed) — reservation only in this feature;
                           #   no YAML schemas authored yet. See §5.2.
apps/
├─ api/
│  └─ src/modules/
│     └─ catalog/          # NEW (proposed) — module scaffolding only, no
│                          #   controllers/services authored in this feature.
└─ worker/
   └─ (no new workers in this feature)
```

No new app, no new package, no new tool, no new infra service.

---

## 2. Constitution Check (initial gate)

Against constitution v3.0.0. Catalog Foundation **exercises** principles §9
and §10 that were marked `n/a` in 001 — these are now load-bearing.

| Principle | Plan-level alignment | Status |
|---|---|---|
| I. Reference, Not Source of Truth | No legacy `Data-Pulse` schema or naming reused. Spec re-stated from constitutional first principles. | ✅ |
| II. Multi-Tenant SaaS by Default | Every Tenant Catalog row carries `tenant_id NOT NULL`; every Store Override carries `(tenant_id, store_id) NOT NULL`. RLS policies extend 001's pattern. Cross-tenant access returns safe non-disclosing 404. | ✅ |
| III. Backend Authority & Data Integrity (NON-NEGOTIABLE) | Money is `numeric(19,4)` with mandatory `currency_code`. DB CHECK constraints reject negative prices; partial unique indexes enforce alias uniqueness per Q4. Cache is never source of truth for catalog rows. POS-supplied totals (future) preserved as received per Q3. | ✅ |
| IV. Contract-First POS Integration | No POS endpoint authored in this feature. The future POS read model direction is recorded as **snapshot + delta** per Q12 in `packages/contracts/openapi/catalog/README.md`; no YAML schemas yet. | ✅ (seam only) |
| V. Async Work Belongs in Workers | No catalog-specific worker needed in v1. Future POS snapshot/delta generation is worker-bound — recorded but not implemented. | ✅ |
| VI. Test-First Quality | Plan defines red→green order; eight test obligations from spec §13 carried into Phase 2 (§6). Cross-tenant + cross-store sweep tests required per protected endpoint. | ✅ |
| VII. Observable Systems | Four new metrics named in spec §9 — unknown-item rate, duplicate-alias conflict rate, catalog lookup failure rate, reconciliation mismatch rate (last is named only; emits when POS sync lands). No PII in labels. | ✅ |
| VIII. Reproducible & Versioned Releases | All schema changes will land as explicit SQL migration files (in the future implementation feature). No migration generated in this plan PR. | ✅ |
| IX. Source-of-Truth Model | **Now load-bearing.** Plan preserves four distinct layers — Global Product Index = reference only; Tenant Catalog = customer truth; Store Override = branch truth; SaleLine Snapshot = future invoice truth. No layer is collapsed; no foreign-key relationship lets a platform-side edit silently mutate tenant data (enforced by spec Q5 copy-on-adopt). | ✅ |
| X. Retail Temporal Semantics | **Now load-bearing.** Plan distinguishes catalog timestamps (`created_at`, `updated_at`, `retired_at`) from price-history temporal fields (`effective_from`, `effective_to` per Q9) from future SaleLine Snapshot's `occurredAt` / `businessDate` (recorded as obligation in §3.4). Past sale facts are never rewritten by catalog edits. | ✅ |
| XI. Idempotency & External IDs | `product_aliases.identifier_type = 'external_pos_id'` uses `(tenant_id, source_system, value)` per spec §6.1 / Q4. Future POS catalog ingestion (out of scope here) inherits the same pair. | ✅ |
| XII. Authorization & Object Safety | Zod `.strict()` DTOs forbid body-supplied `tenant_id`, `store_id`, `created_by`, `effective_from`, audit fields; server-resolved tenant / store context only. `RolesGuard` with `denyAs: 404` for cross-tenant non-disclosure (inherited from 001). | ✅ |
| XIII. Auditability & Provenance | Eight audit event classes from spec §8 map onto existing `audit_events` table + `AuditEmitter` interceptor; insert-only at the application layer. Correlation id propagated through unknown-item resolution. | ✅ |
| XIV. PII & Data Lifecycle Discipline | Catalog rows are business class, not PII. Supplier codes and `external_pos_id` values are sensitive identifiers but not PII; logger-boundary redaction policy from 001 applies (no full alias values in logs at INFO+; redact at WARN/ERROR). Soft-delete is the default for retire flows. | ✅ |

**Result**: No initial gate violations.

### 2.1 Clarifications treated as binding constraints

Each spec §16 decision becomes a non-negotiable constraint for the future
implementation feature. Recorded here so `/speckit.tasks` cannot weaken any
of them.

| Q | Constraint inherited by the future implementation feature |
|---|---|
| Q1 | All catalog/unit price columns use `numeric(19,4)`. CHECK constraint `>= 0`. Floating-point columns are forbidden. |
| Q2 | Every monetary row (Tenant Catalog default price, Store Override price, Price History rows) carries a `currency_code char(3) NOT NULL`. A tenant default currency exists at the tenant level (column or settings table — TBD in data-model.md); records still store their own currency code. |
| Q3 | Catalog-derived display totals round line-level half-up. Sales/POS ingestion (future) must preserve received totals byte-exact; the platform must not re-round POS-supplied invoice totals. |
| Q4 | `product_aliases (tenant_id, identifier_type, value)` unique for `barcode` / `sku`. `(tenant_id, source_system, value)` unique for `external_pos_id`. `(tenant_id, store_id, identifier_type, value)` unique for explicitly store-scoped aliases (flagged column). |
| Q5 | Adoption inserts a fresh Tenant Catalog row with `source_global_product_id` provenance. No application or DB trigger propagates Global Product Index changes to adopted tenant products. |
| Q6 | Variants deferred. The Tenant Catalog table must reserve nullable hook columns or otherwise leave the future variant-group / parent-product relation possible without breaking aliases, price history, or store overrides. |
| Q7 | Categories are flat — `tenant_product_categories (id, tenant_id, name)` with `tenant_products.category_id` FK. No `parent_id` column in v1. |
| Q8 | Store Override columns in v1: `price`, `currency_code`, `is_active`, `tax_category`. No `name` or `category_id` columns on the Store Override table. |
| Q9 | `price_history (effective_from timestamptz NOT NULL, effective_to timestamptz NULL)`. Insert closes the prior row's `effective_to`; history rows are never updated or deleted by application code. |
| Q10 | Unknown items resolve only via explicit user action. No code path may convert an `unknown_items` row into a `tenant_products` row without an authenticated actor's resolution call. |
| Q11 | Tax stored as opaque string label (`tax_category text NOT NULL`) on Tenant Catalog and Store Override. No tax-rate, no jurisdiction, no calculation logic. |
| Q12 | Future POS read model = snapshot + delta. No online-only per-lookup endpoint is the primary path. This feature only records the seam — no YAML, no endpoint, no worker. |

---

## 3. Architecture Overview

### 3.1 Where catalog lives in the 001 architecture

Catalog adds tables and a future module to the architecture established in
001. It does not introduce a new app, queue, or external service.

```
                  apps/api (NestJS)
                  └─ src/modules/
                     ├─ auth/        (001)
                     ├─ tenants/     (001)
                     ├─ stores/      (001)
                     ├─ memberships/ (001)
                     ├─ audit/       (001)
                     └─ catalog/     ◄─── proposed home for future catalog module
                                          (no controllers/services in this PR)

                  PostgreSQL 16+ (existing)
                  ├─ users, tenants, stores, memberships, ...   (001)
                  ├─ audit_events                                (001)
                  └─ NEW catalog tables (designed in data-model.md, NOT
                     migrated in this PR):
                     ├─ global_products              (platform-owned)
                     ├─ tenant_products              (tenant-owned, RLS)
                     ├─ tenant_product_categories    (tenant-owned, RLS)
                     ├─ store_product_overrides      (store-scoped, RLS)
                     ├─ product_aliases              (tenant-owned, RLS;
                     │                                 store flag for §6.1)
                     ├─ price_history                (tenant/store, RLS,
                     │                                 effective intervals)
                     └─ unknown_items                (tenant/store, RLS,
                                                      manual resolution)
```

### 3.2 Catalog lookup lifecycle (resolved view, future implementation)

Recorded here so the future implementation feature inherits the order and
the failure modes.

1. Caller (Store Staff via dashboard read, or future POS read) issues a
   lookup for an identifier within an authenticated `(tenant_id, store_id)`
   context. Tenant + store are resolved server-side via the
   `TenantContextGuard` from 001 — never from the request body.
2. The query resolves against `product_aliases` using the configured
   uniqueness scope from Q4. If `store_id` is in scope, the store-scoped
   matchers are checked first; otherwise tenant-wide.
3. If exactly one product matches → load Tenant Catalog row, overlay Store
   Override fields (price, `is_active`, `tax_category` per Q8) → return the
   resolved view.
4. If **zero** matches → emit `catalog_lookup_failure` metric (§9). The
   caller may choose to record an Unknown Item via the workflow in §6.3 of
   the spec; the lookup itself does **not** create one.
5. If **>1** matches → reject the write that produced the duplicate (alias
   create / update is the only path that can produce a duplicate) and emit
   `duplicate_alias_conflict` metric. Reads never silently pick a winner.
6. Cross-tenant or cross-store lookup attempts return a safe non-disclosing
   404 (Constitution §2, §12).

### 3.3 Source-of-truth defense in depth

| Layer | Mechanism | Failure mode if bypassed |
|---|---|---|
| Spec | Four distinct source-of-truth layers (§5). Collapse is a non-goal (spec §3, §14). | Spec review rejection. |
| Schema | Separate tables (`global_products`, `tenant_products`, `store_product_overrides`); no FK from `tenant_products` to `global_products` that would propagate edits. `source_global_product_id` is provenance metadata only. | Adopted tenant rows are immune to platform-side edits. |
| Drizzle | `withTenant(tx, tenantId)` and `withStore(tx, tenantId, storeId)` helpers (from 001). Direct unscoped queries on catalog tables forbidden in handlers (lint rule). | Cross-tenant query — caught at code review. |
| Postgres RLS | Row-level security on every tenant- and store-scoped catalog table; `app.current_tenant` / `app.current_store` GUCs from 001. | Even raw SQL cannot read other tenants/stores. |
| API contracts | Zod `.strict()` DTOs forbid `tenant_id` / `store_id` / `source_global_product_id` / audit fields in request bodies. | 400 on rejected fields; no silent mutation. |
| Tests | Cross-tenant + cross-store sweep over every catalog endpoint; alias conflict tests; price-history immutability test; SaleLine Snapshot non-rewrite fixture (when sales lands). | CI fails. |

### 3.4 Future SaleLine Snapshot obligation (binding)

This plan records the obligation in **machine-readable form** so the future
sales feature cannot accidentally violate it:

- When a sale is captured (future feature), the SaleLine row MUST persist
  at least: tenant_id, store_id, product_id (the tenant_products row at
  sale time), product_name_at_sale, unit_price_at_sale, currency_code,
  tax_category_at_sale, alias_value_used_to_identify,
  alias_identifier_type, `occurredAt`, `businessDate`, `sourceClockAt`,
  `receivedAt`.
- Any later edit to `tenant_products`, `store_product_overrides`, or
  `price_history` must leave existing SaleLine Snapshot rows untouched.
- The future sales feature's plan MUST cite this section (§3.4).

---

## 4. Phase 0 — Outline & Research

Generated artifact: [`research.md`](./research.md) (not authored in this PR
— owner sign-off scopes this plan to `plan.md` only).

When authored, `research.md` resolves the cross-cutting technical questions
that the spec's Q1–Q12 leave to implementation choice. Candidate research
items:

- **R-1** — Postgres exclusion / partial unique index pattern for
  `price_history` effective intervals (Q9). Decide whether `effective_to`
  uses `NULL` (open) or `infinity`. Decide whether to enforce
  non-overlapping intervals via an exclusion constraint or in application
  code under serializable isolation.
- **R-2** — Tenant default currency storage: dedicated column on `tenants`
  vs row in a `tenant_settings` table (Q2). Tradeoffs: read-path simplicity
  vs settings-table extensibility for later.
- **R-3** — Soft-delete shape for catalog tables (Constitution §14):
  `retired_at timestamptz NULL` vs `status enum`. Implications for the
  resolved-view query.
- **R-4** — Drizzle pattern for the resolved-view query: CTE vs lateral
  join vs view. Pick one for read-path stability.
- **R-5** — `tax_category` value space (Q11): free-string vs
  tenant-scoped enum table. Free-string is simpler; enum table prevents
  typos. Decide based on whether tax categories are user-managed.

None of these block this plan PR. They are inputs to the future
implementation feature.

---

## 5. Phase 1 — Design & Contracts

### 5.1 Generated artifacts (NOT authored in this PR)

Per owner sign-off, this PR does not author any of the following — they are
listed only so the future implementation feature knows what the plan
expects:

- `data-model.md` — physical model (tables, columns, constraints,
  indexes, RLS policies, invariants) translating spec §5–§6 entities.
  Drizzle is the ORM; migration files are explicit SQL.
- `contracts/` — OpenAPI 3.1 schemas. **For this feature: a reservation
  README only** (see §5.2); no YAML endpoints authored. Per spec §10 and
  Q12, the POS-facing read model is recorded as direction, not as
  endpoint.
- `quickstart.md` — behavior-level walkthrough for verifiers.
- `pos-read-model-walkthrough.md` — direction-only document recording the
  snapshot + delta intent per Q12, as a future-feature seam description.

### 5.2 What is intentionally NOT in Phase 1 of this feature

- TypeScript source code, NestJS modules / services / controllers,
  Drizzle schema files, BullMQ job handler bodies.
- Concrete SQL migration files. Migration shape and order will be
  described in `data-model.md` when authored; actual `drizzle/0001_*.sql`
  generation is `/speckit.tasks` work.
- POS-facing endpoint contracts. The reserved namespace for the future
  catalog read model would be documented in
  `packages/contracts/openapi/catalog/README.md` (under §5.1) with no
  schemas inside it. This PR does not create that README either — listed
  for the future implementation feature.
- Any dashboard / web frontend work.
- Tax engine, jurisdiction tables, promotion / discount engine,
  supplier domain, inventory, orders, sales, payments — all out of scope
  per spec §3.
- SaleLine Snapshot table — recorded as obligation in §3.4, not
  implemented.

### 5.3 Spec → Phase 1 artifact map (for the future implementation feature)

| Spec section | Future Phase 1 artifact |
|---|---|
| §5.1 Global Product Index | `data-model.md` → `global_products` table + RLS exemption (platform-only writes) |
| §5.2 Tenant Catalog | `data-model.md` → `tenant_products`, `tenant_product_categories` + RLS |
| §5.3 Store Override | `data-model.md` → `store_product_overrides` + RLS, fields per Q8 |
| §5.4 SaleLine Snapshot | Obligation in §3.4 of this plan; no artifact |
| §6.1 Product Aliases | `data-model.md` → `product_aliases` with the three uniqueness indexes from §2.1 Q4 |
| §6.2 Price History | `data-model.md` → `price_history` with effective intervals (Q9) |
| §6.3 Unknown Item Workflow | `data-model.md` → `unknown_items` + resolution audit hook |
| §6.4 Resolved Catalog View | `quickstart.md` → resolution algorithm + R-4 decision applied |
| §7 Scenarios | `quickstart.md` → S1–S7 behavior verification |
| §8 Audit | `audit_events` event types extended (no schema change) |
| §9 Observability | Prometheus metric names registered in `packages/shared` |
| §12 / §16 Clarifications | Locked into `data-model.md` as DDL + comments |

---

## 6. Phase 2 — Task Decomposition Strategy

> Per owner sign-off, **`tasks.md` is NOT generated in this PR**. This
> section records the decomposition strategy so `/speckit.tasks` (later)
> produces a deterministic task list.

### 6.1 Decomposition principles

- **Vertical slice per source-of-truth layer.** Layer 1 = Global Product
  Index (platform admin only). Layer 2 = Tenant Catalog. Layer 3 = Store
  Override. Layer 4 = SaleLine Snapshot obligation only (no
  implementation in this feature's tasks).
- **Within each layer, schema-first.** Migration + RLS + Drizzle schema
  before any service / controller. Then sweep tests immediately after
  schema lands.
- **Cross-cutting features depend on Layers 1–3.** Aliases, Price History,
  Unknown Items, Resolved View come after the three layers exist.
- **Tests come first per slice (TDD).** Constitution §6 + spec §13.
- **No task may bundle a schema change with an OpenAPI contract change with
  a controller change.** Schema, contract, code each get their own task to
  preserve reviewability.

### 6.2 Task families (preview — to be expanded by `/speckit.tasks`)

| Family | Spec anchor | Constraint inheritance |
|---|---|---|
| **F-CAT-SCHEMA** — DDL for `global_products`, `tenant_products`, `tenant_product_categories`, `store_product_overrides`, `product_aliases`, `price_history`, `unknown_items`; RLS policies; partial unique indexes. | §5, §6 | Q1, Q4, Q7, Q8, Q9 |
| **F-CAT-ISOLATION** — Cross-tenant + cross-store sweep tests; RLS bypass probe; raw-SQL probe. | §7 S7; §13 | §2.1 (all Qs) |
| **F-CAT-GLOBAL** — Platform-admin read/write API on `global_products` (reference only). | §5.1 | Q5 |
| **F-CAT-TENANT** — Tenant Catalog CRUD: create, update (canonical fields), retire (soft-delete), adopt from Global. | §5.2; §7 S1, S2 | Q5, Q6, Q7 |
| **F-CAT-STORE-OVERRIDE** — Store Override CRUD restricted to fields per Q8. | §5.3; §7 S3 | Q8, Q11 |
| **F-CAT-ALIAS** — Alias CRUD with type-scoped uniqueness; duplicate-alias conflict metric emission. | §6.1; §7 S4 | Q4 |
| **F-CAT-PRICE-HIST** — Price-write path emits effective-interval history; immutability tests; cross-tenant sweep. | §6.2; §7 S6; §13 | Q1, Q2, Q3, Q9 |
| **F-CAT-UNKNOWN** — Unknown Item record + manual resolution flow; no auto-create path. | §6.3; §7 S5 | Q10 |
| **F-CAT-RESOLVED-VIEW** — Read-only resolved view (Tenant ⊕ Store Override) for dashboard reads. | §6.4 | Q8 |
| **F-CAT-AUDIT** — Audit event types (8 classes from spec §8) wired to existing AuditEmitter. | §8 | inherits 001 audit pipe |
| **F-CAT-METRICS** — Four Prometheus metrics registered. | §9 | no PII labels |
| **F-CAT-POS-SEAM** — POS read-model direction document (snapshot + delta); contract reservation README. **No endpoint.** | §6.4; Q12 | Constitution §4 |
| **F-CAT-OBLIGATION** — Documentation-only task: the SaleLine Snapshot non-rewrite obligation (this plan §3.4) is cross-linked from `data-model.md`. | §5.4 | Constitution §10 |

### 6.3 Out of Phase 2 scope explicitly

- SaleLine Snapshot table creation.
- Sale capture, refund, invoice generation.
- Real POS endpoint authoring.
- Tax engine, promotions, supplier domain, inventory.
- Dashboard frontend.

---

## 7. Constitution Check (post-design re-evaluation)

Re-checked after Phase 1 + Phase 2 decomposition strategy.

| Principle | Post-design status | Notes |
|---|---|---|
| II. Multi-Tenant SaaS by Default | ✅ | Every catalog table is tenant- or tenant+store-scoped. RLS extends 001's policy generator with zero schema-pattern divergence. |
| III. Backend Authority & Data Integrity | ✅ | `numeric(19,4)` + `currency_code` mandatory; CHECK `>= 0`; alias uniqueness via partial unique indexes; cache is not source of truth. |
| IV. Contract-First POS Integration | ✅ (seam only) | No POS endpoint authored. Snapshot + delta direction recorded per Q12. |
| VI. Test-First Quality | ✅ | F-CAT-ISOLATION lands before any handler is implemented in the future feature. All 8 spec §13 test obligations have a home in §6.2. |
| IX. Source-of-Truth Model | ✅ | Four layers preserved; no FK propagation; copy-on-adopt enforced by §2.1 Q5; SaleLine Snapshot obligation locked in §3.4. |
| X. Retail Temporal Semantics | ✅ | Catalog timestamps, price-history intervals, and future SaleLine Snapshot temporal fields are kept distinct. Past sale facts immune to catalog edits. |
| XI. Idempotency & External IDs | ✅ | `external_pos_id` carries `sourceSystem`; future ingestion idempotent on `(tenant_id, source_system, value)`. |
| XII. Authorization & Object Safety | ✅ | Body-supplied tenant/store/role/status/audit fields rejected. Cross-tenant 404-safe. |
| XIII. Auditability & Provenance | ✅ | Eight audit event classes mapped onto existing `audit_events`. Insert-only at the application layer. |
| XIV. PII & Data Lifecycle Discipline | ✅ | Soft-delete via `retired_at`; logger-boundary redaction for alias values at WARN/ERROR. |

**Result**: No post-design gate violations. Plan is internally consistent
with the constitution and the resolved clarifications.

---

## 8. Risks & Mitigations (plan-level)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Implementation feature silently collapses Tenant + Store Override into a single row "for performance." | Medium | High — violates Constitution §9. | §2.1 Q8 + §3.3 explicitly forbid; isolation tests fail if collapse happens. |
| Price-history effective intervals develop overlaps under concurrent writes. | Medium | Medium — broken historical reads. | R-1 (research) picks exclusion-constraint vs serializable-isolation approach before any code. |
| Adopted Tenant Catalog rows accidentally pick up Global Product Index edits via a FK + `ON UPDATE CASCADE`. | Low | High — silent tenant data mutation. | §2.1 Q5: `source_global_product_id` is metadata, **no FK with CASCADE**. Schema task acceptance criteria check this. |
| Future sales feature forgets to snapshot catalog state at sale time. | Medium | Critical — past sale facts get rewritten by later catalog edits. | §3.4 obligation; future sales plan MUST cite §3.4; isolation test fixture introduced by F-CAT-OBLIGATION. |
| Alias uniqueness Q4 implemented as a single tenant-wide unique index across all identifier types, breaking the type-specific intent. | Medium | High — legitimate distinct types collide. | §2.1 Q4 enumerates the three separate partial unique indexes; schema review rejects single-index shortcuts. |
| POS read-model implemented as an online-only per-lookup endpoint despite Q12. | Low | Medium — POS offline-correctness broken later. | §2.1 Q12 + §6.2 F-CAT-POS-SEAM record direction as snapshot + delta with per-lookup as fallback only. |
| Tax category field grows into an ad-hoc tax engine. | Medium | Medium — scope creep, Constitution §3 risk. | §2.1 Q11: opaque label only; no rate / jurisdiction fields. Spec §3 reaffirms. |

---

## 9. Open Questions (plan-level — beyond spec Q1–Q12)

Listed for the future implementation feature; none block this plan PR.

- **PQ-1** — Tenant default currency: column on `tenants` vs row in
  `tenant_settings`? (Research item R-2.) Default: column on `tenants` for
  read-path simplicity.
- **PQ-2** — `effective_to` for current price: `NULL` or `'infinity'`?
  (R-1.) Default: `NULL`, with a partial unique index ensuring "at most one
  open interval per product (× store)."
- **PQ-3** — Tax category value space: free-string vs tenant-scoped enum
  table? (R-5.) Default: free-string in v1, with a soft validator (regex
  + length) so a future enum migration is non-breaking.
- **PQ-4** — Resolved-view query strategy: CTE inline, lateral join, or
  materialized view? (R-4.) Default: CTE inline; revisit if dashboard read
  latency suffers under load.
- **PQ-5** — Soft-delete model: `retired_at timestamptz NULL` vs `status`
  enum? (R-3.) Default: `retired_at` for consistency with 001's
  soft-delete patterns; resolved-view query filters
  `retired_at IS NULL`.
- **PQ-6** — Future POS snapshot signing / integrity: HMAC vs detached
  signature vs none? Deferred to the future POS-sync feature; not a
  decision for this implementation feature.

None of these change the constitutional gates or the §16 clarifications.

---

## 10. Definition of Done (this plan)

- ✅ All twelve clarifications (Q1–Q12) are encoded as binding constraints
  in §2.1.
- ✅ Initial Constitution Check (§2) passes.
- ✅ Post-design Constitution Check (§7) passes.
- ✅ Phase 2 decomposition strategy (§6) is enumerated as task families,
  each anchored to a spec section and the constraints it inherits.
- ✅ Risks (§8) and plan-level open questions (§9) are recorded.
- ✅ SaleLine Snapshot obligation (§3.4) is documented in machine-readable
  form for the future sales feature to inherit.
- ✅ No code, schema, migration, OpenAPI YAML, package file, lockfile,
  CI config, generated file, or application source has been modified by
  this PR.
- ✅ `tasks.md` is **not** generated (per owner sign-off).

---

## 11. Approvals & Next Step

**Pending**: Owner approval of this plan.

**Next step on approval**: Run `/speckit.tasks` to expand §6 task families
into a numbered `tasks.md`. That run is a separate PR; the present plan PR
stops here.

---

## 12. Post-implementation Constitution Check

Not applicable yet — implementation has not begun. This section will be
re-checked at the close of the future implementation feature, against the
post-implementation evidence (passing isolation sweep, RLS bypass probe,
price-history immutability test, SaleLine non-rewrite fixture under a
sales-feature stub, alias conflict tests, and the four observability
signals visible in a dev environment).
