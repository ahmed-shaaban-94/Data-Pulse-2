# Implementation Tasks: Catalog Foundation

**Feature ID**: 003
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Status**: Draft (planning only — no code authored)
**Created**: 2026-05-15
**Owner**: Ahmed Shaaban

> **Reading order**: §1 conventions → §2 approval gates → §3+ phases.
>
> **Scope reminder** (from plan §6.3): no SaleLine Snapshot table, no sale
> capture, no real POS endpoint, no tax engine, no promotions, no supplier
> domain, no inventory, no dashboard frontend.

---

## 1. Conventions

| Marker / pattern | Meaning |
|---|---|
| `T###` | Task identifier — globally unique within this feature. Numbering starts at `T300` to avoid collision with 001's `T001–T399` range. |
| `[P]` | Parallel-safe — task touches **no file that another `[P]` task in the same group touches**. May run concurrently within a group. |
| `[GATED]` | Approval-gated — execution requires explicit owner approval per Constitution §8 (touches DB schema, migrations, OpenAPI YAML, package.json, pnpm-lock.yaml, or CI). Listed centrally in §2. |
| `[Q#]` | Anchors a task to a spec §16 clarification it must preserve. Multiple `[Q#]` markers mean the task carries multiple constraints. |
| `[S#]` | Anchors a task to a spec §7 required scenario. |
| `[TC]` | Requires Testcontainers-backed Postgres (real RLS / DDL). Constitution §6. |
| TDD pairing | Test task always precedes its implementation task. The implementation task lists the test task as its predecessor. |
| File paths | Exact target path on disk. Authoring belongs to the implementation task, not this planning document. |

**Each task lists**: ID · description · target file(s) · predecessors · constraints carried · acceptance criteria.

---

## 2. Approval-gated tasks (must request explicit approval before execution)

Per Constitution §8, the following tasks touch files that require explicit
owner approval before any code is written. They are listed here so the
approver can review the set in one place.

| Task | Reason for gating |
|---|---|
| `T315 [GATED]` — extend `packages/db` `package.json` `scripts` / `devDependencies` if Drizzle Kit version changes | `package.json` change |
| `T320 [GATED]` — author Drizzle schema files under `packages/db/src/schema/catalog/` | DB schema source (Drizzle) |
| `T330 [GATED]` — author explicit SQL migration `packages/db/drizzle/0001_catalog.sql` + rollback | SQL migration |
| `T331 [GATED]` — extend `packages/db/src/schema/index.ts` barrel to re-export catalog schemas | Schema barrel (counted as DB schema source) |
| `T370 [GATED]` — author OpenAPI YAML `packages/contracts/openapi/catalog/*.yaml` for dashboard-facing read-only endpoints | OpenAPI YAML |
| `T371 [GATED]` — author `packages/contracts/openapi/catalog/README.md` with reservation note for future POS read model | OpenAPI directory of record |
| `T420 [GATED]` — extend `apps/api/package.json` if new dependencies are required (none anticipated; gate exists as guard) | `package.json` change |
| `T490 [GATED]` — extend `packages/db/drizzle/0001_catalog.sql` with any post-implementation index revisions | SQL migration |

No CI changes are planned (`.github/workflows/*` untouched). No generated
file changes. No POS app changes (separate repo per CLAUDE.md).

---

## 3. User scenarios (derived from spec §7)

This feature is not user-story-shaped the way 001 was. The spec captures
seven required scenarios — they are not separately prioritized but they
are **separately verifiable**, which is what tasks need.

| ID | Scenario (spec §7) | Approval priority for scope-cuts |
|---|---|---|
| S1 | Tenant admin creates and manages a tenant-owned product. | Must |
| S2 | Tenant admin adopts a Global Product Index suggestion. | Must |
| S3 | Store manager creates a Store Override for price / availability / tax. | Must |
| S4 | Staff / POS lookup resolves a barcode/SKU to the correct catalog view. | Must |
| S5 | POS records an unknown item. | Must |
| S6 | Price change preserves history and does not mutate past sale facts. | Must |
| S7 | Cross-tenant / cross-store access is safely rejected. | Must (Constitution §2/§12) |

If a scope cut is later requested, S7 cannot be removed. Everything else
is in scope per spec §3.

---

## 4. Phase 1 — Research, decisions & design artifacts (no code)

Phase 1 produces design documents that the future implementation phases
read but do not modify. None of these tasks touch app source, schema,
migrations, or contracts.

### 4.1 Research decisions (plan §4 R-1 through R-5)

- [ ] `T300` Author `specs/003-catalog-foundation/research.md` with the
  five research items from plan §4 (R-1 effective-interval enforcement,
  R-2 tenant default currency storage, R-3 soft-delete shape, R-4
  resolved-view query strategy, R-5 tax category value space). Each item:
  Decision / Rationale / Alternatives. Predecessors: none.
  Acceptance: every R-1..R-5 has a Decision line and no `TBD` markers.
- [ ] `T301` [P] Append PQ-1..PQ-6 (plan §9) to `research.md` with default
  resolutions noted. Predecessors: T300. Acceptance: all six PQs have a
  default resolution.

### 4.2 Data model (design only — no SQL, no Drizzle)

- [ ] `T310` Author `specs/003-catalog-foundation/data-model.md` covering
  all seven catalog entities — `global_products`, `tenant_products`,
  `tenant_product_categories`, `store_product_overrides`,
  `product_aliases`, `price_history`, `unknown_items` — with columns,
  types, nullability, constraints, indexes, RLS policies, and a notes
  block per Q1–Q11 binding. Predecessors: T300.
  Acceptance:
  - Every monetary column is `numeric(19,4)` `[Q1]`.
  - Every monetary row has `currency_code char(3) NOT NULL` `[Q2]`.
  - Alias uniqueness expressed as three partial unique indexes `[Q4]`.
  - `tenant_products` has `source_global_product_id uuid NULL` provenance
    column with **no FK** (or FK without `ON UPDATE CASCADE / ON DELETE
    CASCADE`) `[Q5]`.
  - `tenant_product_categories` has no `parent_id` column `[Q7]`.
  - `store_product_overrides` columns limited to `price`, `currency_code`,
    `is_active`, `tax_category` `[Q8]`.
  - `price_history` columns include `effective_from timestamptz NOT NULL`
    and `effective_to timestamptz NULL`; partial unique index ensures "at
    most one open interval per (product[, store])" `[Q9]`.
  - `unknown_items` resolution column requires an actor user_id (no
    auto-resolve path) `[Q10]`.
  - `tax_category` is `text NOT NULL` opaque string `[Q11]`.
  - Variants forward-compatibility note documents how a future
    `parent_product_id` or `variant_group_id` can be added without
    rewriting aliases, price history, or overrides `[Q6]`.
- [ ] `T311` [P] Append RLS test matrix to
  `specs/003-catalog-foundation/rls-test-matrix.md` (template at
  `.specify/templates/rls-test-matrix-template.md`). Predecessors: T310.
  Acceptance: every catalog table has a row covering (a) same-tenant
  read, (b) cross-tenant read denied, (c) same-store override read, (d)
  cross-store override read denied, (e) raw-SQL probe behavior.
- [ ] `T312` [P] Append redaction matrix to
  `specs/003-catalog-foundation/redaction-matrix.md` (template at
  `.specify/templates/redaction-matrix-template.md`). Covers
  `product_aliases.value` and `external_pos_id` values at logger
  boundaries (INFO / WARN / ERROR levels per Constitution §14).
  Predecessors: T310.

### 4.3 Quickstart (behavior walkthrough)

- [ ] `T313` Author `specs/003-catalog-foundation/quickstart.md` —
  behavior-level verifier walkthrough for S1–S7 (no commands, no curl
  examples; describe the resolved-view algorithm, alias resolution
  order, unknown-item flow, price-history interval close). Predecessors:
  T310. Acceptance: each S1–S7 has its own subsection.

### 4.4 POS read-model seam document (no endpoint)

- [ ] `T314` Author `specs/003-catalog-foundation/pos-read-model-direction.md`
  — direction-only document recording snapshot + delta as the primary
  future POS path per `[Q12]`. Explicitly states **no endpoint is
  authored in this feature**. Cross-links from plan §3.4 and §5.1.
  Predecessors: none (independent of T310).
  Acceptance: no OpenAPI YAML referenced; no endpoint authored.

---

## 5. Phase 2 — Foundational (blocks all scenario phases)

> **Gate banner**: this phase contains `[GATED]` tasks (T315, T320, T331,
> T330). They require explicit owner approval per §2 before execution and
> must not be included in an ungated implementation slice. The
> non-gated tests (T316–T325, T326–T329, T335–T344) may run first under
> TDD — but the implementations they target stay blocked until the gate
> opens.

### 5.1 Drizzle Kit version check (gate guard)

- [ ] `T315` `[GATED]` If the catalog feature requires a Drizzle Kit
  version newer than 001 uses, request approval and update
  `packages/db/package.json` `devDependencies`. **Do not execute without
  approval.** Predecessors: T310.
  Acceptance: either (a) no change needed and the task is closed with
  "no-op confirmed", or (b) explicit approval recorded and the
  `package.json` diff is minimal.

### 5.2 Drizzle schema files (TDD — schema-shape tests first)

- [ ] `T316` [P] [TC] Test that the catalog Drizzle schema barrel
  exports all seven tables at `packages/db/__tests__/schema/catalog/barrel.spec.ts`.
  Predecessors: T310.
- [ ] `T317` [P] [TC] Test `global_products` Drizzle schema shape (cols
  + nullability + indexes) at
  `packages/db/__tests__/schema/catalog/global-products.spec.ts`.
  Predecessors: T310.
- [ ] `T318` [P] [TC] Test `tenant_products` Drizzle schema shape at
  `packages/db/__tests__/schema/catalog/tenant-products.spec.ts`.
  Predecessors: T310. Carries `[Q1]` `[Q2]` `[Q5]` `[Q6]` `[Q7]`.
- [ ] `T319` [P] [TC] Test `tenant_product_categories` shape at
  `packages/db/__tests__/schema/catalog/tenant-product-categories.spec.ts`.
  Predecessors: T310. Carries `[Q7]`.
- [ ] `T320` `[GATED]` Author Drizzle schema files for all seven catalog
  tables in `packages/db/src/schema/catalog/`:
  - `packages/db/src/schema/catalog/global-products.ts`
  - `packages/db/src/schema/catalog/tenant-products.ts`
  - `packages/db/src/schema/catalog/tenant-product-categories.ts`
  - `packages/db/src/schema/catalog/store-product-overrides.ts`
  - `packages/db/src/schema/catalog/product-aliases.ts`
  - `packages/db/src/schema/catalog/price-history.ts`
  - `packages/db/src/schema/catalog/unknown-items.ts`
  Predecessors: T316, T317, T318, T319, T321, T322, T323, T324, T325.
  Acceptance: tests T316–T325 pass; all `[Q*]` constraints honored.
- [ ] `T321` [P] [TC] Test `store_product_overrides` schema shape at
  `packages/db/__tests__/schema/catalog/store-product-overrides.spec.ts`.
  Carries `[Q1]` `[Q2]` `[Q8]` `[Q11]`. Predecessors: T310.
- [ ] `T322` [P] [TC] Test `product_aliases` schema shape (three partial
  unique indexes, store-scoped flag column) at
  `packages/db/__tests__/schema/catalog/product-aliases.spec.ts`.
  Carries `[Q4]`. Predecessors: T310.
- [ ] `T323` [P] [TC] Test `price_history` schema shape (`effective_from`,
  `effective_to`, partial unique index for at-most-one-open-interval) at
  `packages/db/__tests__/schema/catalog/price-history.spec.ts`. Carries
  `[Q1]` `[Q2]` `[Q9]`. Predecessors: T310.
- [ ] `T324` [P] [TC] Test `unknown_items` schema shape (resolution
  fields, no auto-resolve flag) at
  `packages/db/__tests__/schema/catalog/unknown-items.spec.ts`. Carries
  `[Q10]`. Predecessors: T310.
- [ ] `T325` [P] Schema barrel test that imports each new file at
  `packages/db/__tests__/schema/catalog/imports.spec.ts`. Predecessors:
  T310.

### 5.3 Explicit SQL migration (no auto-generation)

> **Intended order**: T320 (schema files) → T331 (barrel re-export so
> the migration tooling can resolve catalog schemas) → T326–T329
> (migration tests authored against the as-yet-unwritten migration) →
> T330 (author the actual SQL migration and its rollback). The DAG
> below matches that order.

- [ ] `T331` `[GATED]` Extend `packages/db/src/schema/index.ts` to
  re-export the catalog schemas. Required before the migration runner /
  tests can resolve the new catalog schema set. Predecessors: T320.
- [ ] `T326` [TC] Test that **no** catalog table exists on a clean Postgres
  before the migration runs and that all seven tables, indexes, RLS
  policies, CHECK constraints, and partial unique indexes exist after
  migration. Lives at `packages/db/__tests__/migration/0001-catalog.spec.ts`.
  Predecessors: T320, T331.
- [ ] `T327` [P] [TC] Test that rollback (`0001_catalog.down.sql`)
  removes everything T326 verified, leaving Postgres in the pre-migration
  state. Predecessors: T326.
- [ ] `T328` [P] [TC] Test that no foreign key from `tenant_products` to
  `global_products` has `ON UPDATE CASCADE` or `ON DELETE CASCADE`.
  Carries `[Q5]`. Predecessors: T326.
- [ ] `T329` [P] [TC] Test that every `numeric` column with money
  semantics is `numeric(19,4)` and has a `CHECK (... >= 0)` constraint.
  Carries `[Q1]`. Predecessors: T326.
- [ ] `T330` `[GATED]` Author explicit SQL migration
  `packages/db/drizzle/0001_catalog.sql` (creates tables in dependency
  order; partial unique indexes; CHECK constraints; RLS enable;
  policies; updated_at triggers) plus rollback at
  `packages/db/drizzle/0001_catalog.down.sql`. Predecessors: T320,
  T331, T326, T327, T328, T329.

### 5.4 Tenant + store helpers (reuse 001; verify only)

- [ ] `T335` [P] [TC] Test that the existing `withTenant(tx, tenantId)`
  helper from 001 (`packages/db/src/helpers/with-tenant.ts`) correctly
  scopes catalog queries. New test file at
  `packages/db/__tests__/helpers/with-tenant-catalog.spec.ts`. **Do not
  modify** the helper. Predecessors: T330.
- [ ] `T336` [P] [TC] Same for `withStore(tx, tenantId, storeId)` against
  `store_product_overrides`. Test at
  `packages/db/__tests__/helpers/with-store-catalog.spec.ts`.
  Predecessors: T330.

### 5.5 RLS isolation sweep harness (foundational test infra)

- [ ] `T340` [TC] Build catalog isolation test harness at
  `apps/api/test/catalog/__support__/isolation-harness.ts` that fixture-
  generates two tenants × two stores × representative catalog rows.
  Predecessors: T330.
- [ ] `T341` [TC] Test cross-tenant read returns safe 404
  non-disclosing response for every catalog table. Located at
  `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts`. Carries
  `[S7]`. Predecessors: T340.
- [ ] `T342` [P] [TC] Test cross-store override read returns safe 404 at
  `apps/api/test/catalog/isolation/cross-store-read.spec.ts`. Carries
  `[S7]`. Predecessors: T340.
- [ ] `T343` [P] [TC] Test RLS bypass probe: a raw-SQL query under the
  runtime DB role cannot read cross-tenant catalog rows even with
  application checks disabled. Located at
  `apps/api/test/catalog/isolation/rls-bypass-probe.spec.ts`.
  Predecessors: T340.
- [ ] `T344` [P] [TC] Test malicious body-override: requests with
  body-supplied `tenant_id` / `store_id` / `source_global_product_id` /
  `created_by` / `effective_from` are rejected with 400. Located at
  `apps/api/test/catalog/isolation/malicious-override.spec.ts`. Carries
  `[S7]`. Predecessors: T340.

---

## 6. Phase 3 — Scenario S1: Tenant Catalog CRUD

> Tenant admin creates / manages a tenant-owned product.
> Spec §5.2, §7.S1.

### 6.1 Service-layer TDD

- [ ] `T350` [TC] Test `TenantCatalogService.create` writes to
  `tenant_products` with tenant context, server-resolved `tenant_id`,
  rejects body-supplied `tenant_id`, emits audit event. Located at
  `apps/api/test/catalog/tenant-catalog.service.create.spec.ts`. Carries
  `[S1]` `[Q5]` `[Q6]` `[Q7]`. Predecessors: T330.
- [ ] `T351` Implement `TenantCatalogService.create` at
  `apps/api/src/modules/catalog/tenant-catalog.service.ts`.
  Predecessors: T350.
- [ ] `T352` [P] [TC] Test `TenantCatalogService.update` (canonical
  fields only; no name change emitted to overrides per `[Q8]`). Located
  at `apps/api/test/catalog/tenant-catalog.service.update.spec.ts`.
  Predecessors: T351.
- [ ] `T353` Implement `TenantCatalogService.update` in the same service
  file. Predecessors: T352.
- [ ] `T354` [P] [TC] Test `TenantCatalogService.retire` (soft-delete via
  `retired_at`; resolved view excludes retired). Located at
  `apps/api/test/catalog/tenant-catalog.service.retire.spec.ts`.
  Predecessors: T353.
- [ ] `T355` Implement `TenantCatalogService.retire`. Predecessors: T354.

### 6.2 Controller + Zod DTOs

- [ ] `T356` [TC] Test `TenantCatalogController` POST endpoint with Zod
  `.strict()` DTO rejecting body-supplied `tenant_id`,
  `source_global_product_id`, `created_by`. Located at
  `apps/api/test/catalog/tenant-catalog.controller.spec.ts`. Carries
  `[S7]` `[Q5]`. Predecessors: T355.
- [ ] `T357` Implement `TenantCatalogController` at
  `apps/api/src/modules/catalog/tenant-catalog.controller.ts` and Zod
  DTOs at `apps/api/src/modules/catalog/dto/tenant-catalog.dto.ts`.
  Predecessors: T356.

---

## 7. Phase 4 — Scenario S2: Adopt from Global Product Index

> Tenant admin adopts a global suggestion → copy-on-adopt snapshot.
> Spec §5.1, §7.S2, `[Q5]`.

- [ ] `T360` [TC] Test `GlobalCatalogService.list` is the only read path
  for Global Product Index from tenant-side actors (reference-only).
  Located at `apps/api/test/catalog/global-catalog.service.list.spec.ts`.
  Predecessors: T330.
- [ ] `T361` Implement `GlobalCatalogService.list` at
  `apps/api/src/modules/catalog/global-catalog.service.ts`.
  Predecessors: T360.
- [ ] `T362` [P] [TC] Test `AdoptionService.adopt(globalProductId)`
  creates a fresh `tenant_products` row with `source_global_product_id`
  set, copies the snapshot fields, **does not** propagate later Global
  Product Index edits (verified by mutating Global after adoption and
  asserting tenant row is unchanged). Located at
  `apps/api/test/catalog/adoption.service.spec.ts`. Carries `[S2]`
  `[Q5]`. Predecessors: T361.
- [ ] `T363` Implement `AdoptionService.adopt` at
  `apps/api/src/modules/catalog/adoption.service.ts`. Predecessors:
  T362.
- [ ] `T364` [P] [TC] Test platform-admin-only writes to
  `global_products` (Platform Admin role; tenant users get 404). Located
  at `apps/api/test/catalog/global-catalog.service.write.spec.ts`.
  Carries `[S7]`. Predecessors: T361.
- [ ] `T365` Implement `GlobalCatalogService.create / update / retire`
  (Platform Admin write paths) in the same service file. Predecessors:
  T364.

---

## 8. Phase 5 — Scenario S3: Store Override

> Store manager creates / edits / removes a Store Override (price,
> availability, tax category only).
> Spec §5.3, §7.S3, `[Q8]` `[Q11]`.
>
> **Gate banner**: this phase contains `[GATED]` tasks (T370, T371 —
> OpenAPI YAML for the dashboard read API). They require explicit owner
> approval per §2 before execution and must not be included in an
> ungated implementation slice. The non-gated service/controller tests
> (T372–T376) may run first under TDD — but the OpenAPI authoring stays
> blocked until the gate opens.

- [ ] `T370` `[GATED]` Author OpenAPI YAML for dashboard-facing
  read-only catalog endpoints (no POS endpoints) at
  `packages/contracts/openapi/catalog/dashboard-catalog.yaml`. Endpoint
  set restricted to read operations needed by the dashboard feature:
  list tenant products, get tenant product, list store overrides for a
  store. Predecessors: T310. **Approval required.**
- [ ] `T371` `[GATED]` Author `packages/contracts/openapi/catalog/README.md`
  noting (a) the dashboard YAML above is the current scope, (b) the POS
  read model is reserved as snapshot + delta per `[Q12]` and NOT
  authored in this feature. Predecessors: T370. **Approval required.**
- [ ] `T372` [TC] Test `StoreOverrideService.create` rejects non-Q8
  fields (`name`, `category_id` in body → 400). Located at
  `apps/api/test/catalog/store-override.service.create.spec.ts`. Carries
  `[S3]` `[Q8]`. Predecessors: T330.
- [ ] `T373` Implement `StoreOverrideService.create` at
  `apps/api/src/modules/catalog/store-override.service.ts`.
  Predecessors: T372.
- [ ] `T374` [P] [TC] Test `StoreOverrideService.update` and `.remove`
  (price / availability / tax_category only). Located at
  `apps/api/test/catalog/store-override.service.update-remove.spec.ts`.
  Predecessors: T373.
- [ ] `T375` Implement `update` and `remove` in the same service file.
  Predecessors: T374.
- [ ] `T376` [P] [TC] Test `StoreOverrideController` with Zod `.strict()`
  rejecting `name` / `category_id` / `tenant_id` / `store_id` body
  fields. Located at
  `apps/api/test/catalog/store-override.controller.spec.ts`. Carries
  `[S3]` `[S7]` `[Q8]`. Predecessors: T375.
- [ ] `T377` Implement `StoreOverrideController` at
  `apps/api/src/modules/catalog/store-override.controller.ts` and Zod
  DTO at `apps/api/src/modules/catalog/dto/store-override.dto.ts`.
  Predecessors: T376.

---

## 9. Phase 6 — Scenario S4: Resolved view + alias lookup

> Staff / future POS lookup resolves an identifier to the correct
> catalog view. Resolved(store) = Tenant Catalog ⊕ Store Override.
> Spec §6.1, §6.4, §7.S4, `[Q4]` `[Q8]`.

- [ ] `T380` [TC] Test `ResolvedCatalogView.findByAlias(tenantId,
  storeId, identifierType, value)` returns the resolved product when
  exactly one match exists in the correct uniqueness scope per `[Q4]`.
  Located at
  `apps/api/test/catalog/resolved-catalog-view.find-by-alias.spec.ts`.
  Carries `[S4]`. Predecessors: T377.
- [ ] `T381` Implement `ResolvedCatalogView` read-model at
  `apps/api/src/modules/catalog/resolved-catalog-view.ts`. Choice of CTE
  vs lateral join vs view comes from `research.md` R-4. Predecessors:
  T380.
- [ ] `T382` [P] [TC] Test zero-match path emits the
  `catalog_lookup_failure` metric (no Unknown Item is created by the
  read path). Located at
  `apps/api/test/catalog/resolved-catalog-view.zero-match.spec.ts`.
  Predecessors: T381.
- [ ] `T383` [P] [TC] Test alias uniqueness scopes from `[Q4]`:
  `barcode` and `sku` collisions within a tenant are rejected at write
  time; `external_pos_id` requires `sourceSystem`; store-scoped aliases
  only collide within their store. Located at
  `apps/api/test/catalog/product-aliases.service.uniqueness.spec.ts`.
  Carries `[S4]` `[Q4]`. Predecessors: T330.
- [ ] `T384` Implement `ProductAliasesService.create / update / remove`
  at `apps/api/src/modules/catalog/product-aliases.service.ts`.
  Predecessors: T383.
- [ ] `T385` [P] [TC] Test that resolved-view display totals derived
  from catalog price × quantity apply **line-level half-up rounding**
  per `[Q3]`. Verifies the catalog-side rounding policy in isolation
  (POS ingestion does not yet exist in this feature). Located at
  `apps/api/test/catalog/resolved-catalog-view.line-rounding.spec.ts`.
  Carries `[Q3]`. Predecessors: T381.
  Acceptance:
  - Display total = round_half_up(unit_price × quantity, 2 decimals)
    where `unit_price` is `numeric(19,4)` per `[Q1]` and the displayed
    total is rounded once at the line level, not at sub-step
    multiplication.
  - Test fixtures include at least one case where naive truncation and
    half-up rounding diverge (e.g., `1.005 × 1`).
  - The test documents that **POS-supplied totals preserved-as-received**
    (the other half of `[Q3]`) is **deferred to the future sales / POS
    ingestion feature** and is explicitly out of scope here. No POS
    ingestion path is exercised.

---

## 10. Phase 7 — Scenario S5: Unknown Item Workflow

> Unknown POS / lookup identifier is recorded for tenant review.
> Manual resolution only.
> Spec §6.3, §7.S5, `[Q10]`.

- [ ] `T390` [TC] Test `UnknownItemsService.record` creates exactly one
  row capturing identifier, identifier_type, store context, actor,
  correlation_id; does **not** create a `tenant_products` row. Located
  at `apps/api/test/catalog/unknown-items.service.record.spec.ts`.
  Carries `[S5]` `[Q10]`. Predecessors: T330.
- [ ] `T391` Implement `UnknownItemsService.record` at
  `apps/api/src/modules/catalog/unknown-items.service.ts`.
  Predecessors: T390.
- [ ] `T392` [P] [TC] Test `UnknownItemsService.resolve` with three
  paths: link to existing product (creates alias), create new tenant
  product, dismiss as invalid. Verifies no auto-create exists by
  asserting no code path on this service short-circuits to
  `TenantCatalogService.create` without an authenticated actor's
  explicit choice. Located at
  `apps/api/test/catalog/unknown-items.service.resolve.spec.ts`.
  Carries `[Q10]`. Predecessors: T391.
- [ ] `T393` Implement `UnknownItemsService.resolve`. Predecessors:
  T392.

---

## 11. Phase 8 — Scenario S6: Price History + immutability

> Price change preserves history. Past sale facts cannot be silently
> rewritten by catalog edits.
> Spec §6.2, §7.S6, §3.4 plan, `[Q1]` `[Q2]` `[Q3]` `[Q9]`.

- [ ] `T400` [TC] Test `PriceHistoryService` on price change (tenant or
  override): closes prior interval's `effective_to`, opens new interval
  with `effective_from = now()`, carries currency_code, emits audit
  event. Located at
  `apps/api/test/catalog/price-history.service.spec.ts`. Carries `[S6]`
  `[Q1]` `[Q2]` `[Q9]`. Predecessors: T330.
- [ ] `T401` Implement `PriceHistoryService.recordChange` at
  `apps/api/src/modules/catalog/price-history.service.ts`.
  Predecessors: T400.
- [ ] `T402` [P] [TC] Test that `price_history` rows cannot be edited or
  deleted via Drizzle/repository APIs (attempts fail; audit immutability
  per Constitution §13). Located at
  `apps/api/test/catalog/price-history.service.immutability.spec.ts`.
  Carries `[Q9]`. Predecessors: T401.
- [ ] `T403` [P] [TC] Test that overlapping intervals cannot be created
  under concurrent writes — driven by the R-1 decision (either exclusion
  constraint or serializable retry). Located at
  `apps/api/test/catalog/price-history.service.concurrency.spec.ts`.
  Carries `[Q9]`. Predecessors: T401.
- [ ] `T404` [P] [TC] **SaleLine Snapshot obligation fixture** — a stub
  table `__test_salelines` is created in-test (Testcontainers-only,
  never in the real migration) with the columns plan §3.4 requires.
  Insert sample rows. Mutate `tenant_products`, `store_product_overrides`,
  and `price_history` afterwards. Assert the `__test_salelines` rows are
  unchanged. Carries `[S6]` and plan §3.4 obligation. Predecessors:
  T401. **Note**: this is a test fixture only; the real SaleLine
  Snapshot table is created by a future sales feature.
  **The SaleLine Snapshot table exists only as this Testcontainers-only
  stub in this feature.** T455 enforces that no production
  `_salelines` (or equivalent) column or table is added to
  `0001_catalog.sql` or `packages/db/src/schema/catalog/`. The
  fixture's purpose is to make the future-sales-feature obligation
  testable *today* without creating production schema.
- [ ] `T405` Implement immutability hook in
  `PriceHistoryService` (DB triggers per `0001_catalog.sql` + repository
  guard). Predecessors: T402, T403, T404.

---

## 12. Phase 9 — Scenario S7: Cross-tenant + cross-store sweep (final)

> Already partially covered by T341–T344 in Phase 2. Phase 9 closes the
> loop by sweeping every implemented controller and service.

- [ ] `T410` [TC] Full sweep test: every catalog controller (Tenant
  Catalog, Store Override, Product Aliases, Unknown Items) returns safe
  404 cross-tenant. Located at
  `apps/api/test/catalog/isolation/full-sweep-cross-tenant.spec.ts`.
  Carries `[S7]`. Predecessors: T357, T377, T384, T391.
- [ ] `T411` [P] [TC] Full sweep test: every catalog controller that is
  store-scoped returns safe 404 cross-store. Located at
  `apps/api/test/catalog/isolation/full-sweep-cross-store.spec.ts`.
  Carries `[S7]`. Predecessors: T410.
- [ ] `T412` [P] [TC] Default-deny: a principal without explicit
  permission cannot read or write any catalog layer. Located at
  `apps/api/test/catalog/isolation/default-deny.spec.ts`. Carries `[S7]`.
  Predecessors: T410.

---

## 13. Phase 10 — Audit, observability, module wiring

> **Gate banner**: this phase contains `[GATED]` task (T420 — `apps/api`
> dependency guard, expected no-op). It requires explicit owner approval
> per §2 before execution if any new dependency is actually needed; if
> the guard confirms no-op, the task closes without an approval round.
> Do not include T420 in an ungated implementation slice.

### 13.1 Audit events (eight classes from spec §8)

- [ ] `T420` `[GATED]` If catalog audit emission requires any new
  dependency in `apps/api/package.json`, request approval. (None
  anticipated; gate exists as guard.) Predecessors: T410.
- [ ] `T421` [TC] Test that `AuditEmitter` interceptor (inherited from
  001) emits the eight catalog audit event classes from spec §8 with
  correct actor / tenant / store / operation / target / timestamp /
  `correlationId` / outcome. Located at
  `apps/api/test/catalog/audit/audit-events.spec.ts`. Predecessors: T410.
- [ ] `T422` Wire catalog services to the existing `AuditEmitter`
  decorator. Files touched: each catalog service. No new audit subsystem
  authored. Predecessors: T421.

### 13.2 Observability metrics (four from spec §9)

- [ ] `T423` [P] [TC] Test that the four catalog metrics are registered
  in `packages/shared/src/observability/metrics.ts` (or its catalog
  extension): `catalog_unknown_item_total`,
  `catalog_duplicate_alias_conflict_total`,
  `catalog_lookup_failure_total`, `catalog_reconciliation_mismatch_total`.
  No values, names, or PII in labels. Located at
  `packages/shared/__tests__/observability/catalog-metrics.spec.ts`.
  Predecessors: T410.
- [ ] `T424` Implement metric registrations in
  `packages/shared/src/observability/catalog-metrics.ts` and export from
  the package index. Predecessors: T423. (Reconciliation mismatch metric
  is registered but only emitted by the future POS sync feature — this
  feature wires the registration only.)
- [ ] `T425` [P] [TC] Test metric emission from
  `ResolvedCatalogView.findByAlias` zero-match path
  (`catalog_lookup_failure_total`), alias write-conflict path
  (`catalog_duplicate_alias_conflict_total`), and `UnknownItemsService.record`
  (`catalog_unknown_item_total`). Located at
  `apps/api/test/catalog/observability/metric-emission.spec.ts`.
  Predecessors: T424.

### 13.3 NestJS module wiring

- [ ] `T430` [TC] Test `CatalogModule` boots inside `AppModule` with all
  controllers + services registered and exports nothing the API
  shouldn't expose. Located at `apps/api/test/catalog/catalog.module.spec.ts`.
  Predecessors: T425.
- [ ] `T431` Author `apps/api/src/modules/catalog/catalog.module.ts`
  registering controllers + services. Wire into `AppModule`.
  Predecessors: T430.

---

## 14. Phase 11 — POS read-model seam (no endpoint)

> Direction-only artifacts per `[Q12]`. No POS endpoint, no worker, no
> sync logic.

- [ ] `T440` Verify `specs/003-catalog-foundation/pos-read-model-direction.md`
  (authored in T314) is cross-linked from the contracts README at
  `packages/contracts/openapi/catalog/README.md`. If not, add the link
  in T371 (already gated). Predecessors: T371, T314.
- [ ] `T441` [P] Add a smoke check in
  `apps/api/test/catalog/pos-seam.smoke.spec.ts` asserting that **no
  POS-namespaced catalog route** is registered in the API at startup
  (negative test guarding accidental drift). The assertion matches
  generically — any registered route whose path contains both a
  `pos` segment (e.g. `/api/pos/...`, `/api/.../pos/...`,
  `/api/pos/v1/...`, or any future POS namespace) **and** a `catalog`
  segment must fail the test. The future POS catalog namespace is not
  yet decided per `[Q12]`; this guard catches it regardless of the
  eventual prefix. Predecessors: T431.
  Acceptance:
  - At least one positive control (a non-POS catalog route from this
    feature) is found, proving the matcher works.
  - At least one negative control (a synthetic dummy
    `/api/pos/v1/foo/catalog/bar` registered in the test fixture only)
    is detected and asserted to fail — proving the matcher would catch
    a real drift.
  - No POS endpoint is added to the real application source by this
    test.

---

## 15. Phase 12 — Polish & cross-cutting

> **Gate banner**: this phase contains `[GATED]` task (T490 —
> post-implementation index/constraint refinement on
> `0001_catalog.sql`, expected no-op). It requires explicit owner
> approval per §2 before execution and must not be included in an
> ungated polish slice. T490 should only fire if coverage / sweep
> results in T450–T455 reveal a missing constraint.

- [ ] `T450` [P] [TC] Coverage check: catalog module ≥80% statement +
  branch coverage (Constitution §6). Located in CI report; task
  closure requires the coverage line item to read green.
  Predecessors: T411, T412, T425, T430, T440, T441.
- [ ] `T451` [P] [TC] Coverage check: `packages/db/src/schema/catalog/`
  and `packages/db/__tests__/schema/catalog/` ≥80%. Predecessors: T331.
- [ ] `T452` [P] [TC] Coverage check: `packages/db/__tests__/migration/0001-catalog.spec.ts`
  is part of the migration test suite that runs in CI.
  Predecessors: T330.
- [ ] `T453` [P] Add a `specs/003-catalog-foundation/sc-verification.md`
  documenting per-scenario evidence (which tests anchor S1–S7).
  Predecessors: T410, T411, T412.
- [ ] `T454` [P] Update `CLAUDE.md` "Active artifacts" entry for
  003-catalog-foundation to add links to `research.md`, `data-model.md`,
  `quickstart.md`, `rls-test-matrix.md`, `redaction-matrix.md`,
  `pos-read-model-direction.md`, and `sc-verification.md` once they
  exist. Predecessors: T300, T310, T311, T312, T313, T314, T453.
  **Safety constraints (mandatory — avoid repeating the prior `specify
  init` rewrite incident)**:
  - Edit only the existing 003-catalog-foundation block in
    `CLAUDE.md` under `## Active artifacts`. Append new bullet links
    under the existing `Spec:` / `Plan:` entries.
  - Do **not** rewrite or remove the `<!-- SPECKIT START -->` /
    `<!-- SPECKIT END -->` block belonging to feature 001.
  - Do **not** remove or alter the 001 or 002 navigation entries.
  - Do **not** touch the `## Constitution at a glance (v3.0.0)`,
    `## What this repo does NOT own`, or `## Stack defaults (per
    current plan)` sections.
  - Diff must be a clean additive change — `git diff -- CLAUDE.md`
    should show only new lines under the 003 block, with no
    deletions elsewhere.
- [ ] `T455` [P] [TC] Out-of-scope guard test: assert that no `_sales`,
  `_orders`, `_invoices`, `_inventory`, `_promotions`, `_suppliers`, or
  `_pos_*` table exists after `0001_catalog.sql` runs. Located at
  `packages/db/__tests__/migration/0001-catalog.out-of-scope.spec.ts`.
  Predecessors: T330.
- [ ] `T490` `[GATED]` Post-implementation index/constraint refinement
  pass on `packages/db/drizzle/0001_catalog.sql`. Predecessors: T450,
  T455. **Approval required**; expected no-op unless coverage / sweep
  results reveal a missing constraint.

---

## 16. Dependency graph (high-level)

```
Phase 1 (T300–T314) — design docs
        │
        ▼
Phase 2 (T315–T344) — schema, migration, helpers, isolation harness
        │
        ▼
Phase 3 (T350–T357) — S1 Tenant Catalog
        │
        ├──► Phase 4 (T360–T365) — S2 Adopt from Global
        │
        ├──► Phase 5 (T370–T377) — S3 Store Override
        │
        ├──► Phase 6 (T380–T385) — S4 Resolved view + aliases +
        │            line-level half-up rounding (`[Q3]`)
        │            (depends on T377)
        │
        ├──► Phase 7 (T390–T393) — S5 Unknown Items
        │
        └──► Phase 8 (T400–T405) — S6 Price History + immutability
                     │
                     ▼
              Phase 9 (T410–T412) — S7 final sweep
                     │
                     ▼
              Phase 10 (T420–T431) — audit, observability, wiring
                     │
                     ▼
              Phase 11 (T440–T441) — POS seam
                     │
                     ▼
              Phase 12 (T450–T490) — polish + final gate
```

Phases 4 through 8 are **parallelizable across themselves** once Phase 2
lands. They share `tenant_products` and `store_product_overrides` writes
through services, not through schema edits, so the only synchronization
point is the migration in T330.

---

## 17. Parallel execution opportunities

| Group | Tasks runnable in parallel | Why safe |
|---|---|---|
| Phase 1 design docs | T301, T311, T312, T314 | Different markdown files, no shared dependency once T310 is in. |
| Phase 2 schema-shape tests | T316, T317, T318, T319, T321, T322, T323, T324, T325 | Each tests a different file under `packages/db/__tests__/schema/catalog/`. |
| Phase 2 migration tests | T327, T328, T329 (post-T326) | Different `.spec.ts` files, all read the same migrated DB. |
| Phase 2 helper tests | T335, T336 | Different files, different helpers. |
| Phase 2 isolation harness | T342, T343, T344 (post-T341) | Different `.spec.ts` files; same harness fixtures. |
| Phase 6 alias work | T383 | Independent of T380–T382's view work; shares only the migration. |
| Phase 6 rounding test | T385 | Different `.spec.ts` from T380–T384; depends only on T381's resolved-view implementation. |
| Phase 8 price-history tests | T402, T403, T404 | Different concerns (immutability / concurrency / fixture). |
| Phase 10 observability | T423 ∥ T425 (post-T424) | Different test files, different concerns. |
| Phase 12 polish | T450, T451, T452, T453, T454, T455 | All read-only or doc tasks; different artifacts. |

---

## 18. Out-of-scope guard (verification at end of feature)

These conditions must hold after Phase 12 completes. If any fail, the
feature is **not** ready for implementation closure.

- [ ] No SaleLine Snapshot table in `packages/db/src/schema/catalog/` or
      in `0001_catalog.sql`. (T455 enforces.)
- [ ] No inventory / orders / sales / payments / refunds / invoices
      tables. (T455 enforces.)
- [ ] No POS endpoint under `/api/pos/v1/catalog/*`. (T441 enforces.)
- [ ] No tax engine code (rate tables, jurisdiction logic). (Code
      review.)
- [ ] No promotions / discount engine code. (Code review.)
- [ ] No supplier domain code. (Code review.)
- [ ] No legacy Data-Pulse code copied into `packages/db/src/schema/catalog/`
      or `apps/api/src/modules/catalog/`. (Constitution §1 — code
      review.)
- [ ] No collapse of Global / Tenant / Store Override / SaleLine
      Snapshot. (T328 + T404 + code review.)
- [ ] No dashboard frontend code. (Code review; no `apps/web` change.)

---

## 19. Format check

- [x] Every task has an ID (`T###`), description, target file(s), and
      predecessors.
- [x] Every `[P]` task verified independent of other `[P]` tasks in its
      group.
- [x] Every implementation task is preceded by its test task (TDD).
- [x] Every `[GATED]` task is listed in §2.
- [x] Every spec §7 scenario (S1–S7) is anchored to at least one task.
- [x] Every spec §16 clarification (Q1–Q12) is anchored to at least one
      task. (Q3 anchored at task level by T385; Q3's POS-supplied-totals
      half is explicitly deferred to a future sales/POS ingestion feature
      per T385's acceptance criteria.)
- [x] Every spec §8 audit event class lands under Phase 10.
- [x] Every spec §9 observability metric lands under Phase 10.
- [x] No task authors OpenAPI YAML outside the two gated tasks (T370,
      T371).
- [x] No task authors Drizzle schema or SQL migration outside the gated
      tasks (T320, T330, T331, T490).
- [x] No task modifies `package.json` / `pnpm-lock.yaml` outside the
      gated guards (T315, T420).
- [x] No CI config tasks.
- [x] No generated-file tasks.
- [x] No POS app / dashboard UI / billing / analytics / reports / dbt /
      ClickHouse / Dagster tasks.
