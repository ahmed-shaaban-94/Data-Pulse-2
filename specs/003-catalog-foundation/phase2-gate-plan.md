# 003 Catalog Foundation — Phase 2 Gate Plan

**Ref**: 003-catalog-foundation Phase 2 gate plan
**Status**: Draft — planning artifact; NO implementation in this PR
**Constitution**: v3.0.0
**Date**: 2026-05-16
**Author**: Lane A (Phase 2 gate-plan preparation)
**Cross-references**:
- [spec.md](./spec.md)
- [plan.md](./plan.md)
- [research.md](./research.md)
- [data-model.md](./data-model.md)
- [rls-test-matrix.md](./rls-test-matrix.md)
- [redaction-matrix.md](./redaction-matrix.md)
- [quickstart.md](./quickstart.md)
- [pos-read-model-direction.md](./pos-read-model-direction.md)
- [tasks.md](./tasks.md)

---

## 1. Purpose

This document is the **gate-clearing reference** for the four gated Phase 2
tasks in `tasks.md`: **T315**, **T320**, **T331**, and **T330**.

It exists so that:

- Reviewers consult one document — not the full spec/plan/data-model/tasks
  set — when approving the per-task implementation PRs that follow.
- Each gated task can be evaluated against an exact, auditable checklist of
  files-touched, constraints-honored, and forbidden-paths-not-touched.
- The gating contract from Constitution §VIII (Reproducible & Versioned
  Releases) and the per-task `[GATED]` markers in `tasks.md §2` cannot be
  bypassed by an implementation PR that bundles forbidden changes under a
  superficially scoped title.

This plan **is not** an implementation. It does not author Drizzle TypeScript,
SQL DDL, or test code. It is an approval-ready checklist describing what the
future implementation PRs must contain — and what they must NOT contain.

---

## 2. Scope summary

| Task | Type | Files (future) | Approval gate |
|---|---|---|---|
| T315 | Conditional `package.json` change | `packages/db/package.json` (only if Drizzle Kit version actually bumps) | Explicit owner approval; expected no-op |
| T320 | New Drizzle schema source | `packages/db/src/schema/catalog/{global_products,tenant_products,tenant_product_categories,store_product_overrides,product_aliases,price_history,unknown_items}.ts` | Explicit owner approval |
| T331 | Barrel re-exports | `packages/db/src/schema/index.ts` (extend) and `packages/db/src/schema/catalog/index.ts` (new sub-barrel) | Explicit owner approval |
| T330 | SQL migration + rollback | `packages/db/drizzle/0006_catalog_foundation.sql` and `packages/db/drizzle/0006_catalog_foundation.down.sql` | Explicit owner approval |

> **Numbering correction (binding finding)**: the task brief that produced this
> document referenced `0005_catalog_foundation.sql`. On the current `main` /
> worktree state, `packages/db/drizzle/` already contains
> `0005_audit_retention_privileges.sql` (and `.down.sql`) — `0005` is taken.
> The latest existing migration is `0005_audit_retention_privileges`; the next
> available slot is **`0006_catalog_foundation`**. The remainder of this plan
> uses `0006` exclusively. `tasks.md §5.3` text mentioning `0001_catalog.sql`
> is the legacy numeric placeholder from when 003 was first drafted; the
> actual filename at gate time MUST be `0006_catalog_foundation.sql` /
> `0006_catalog_foundation.down.sql` to follow the established numbering
> pattern (`0000` → `0005` are all sequential, no gaps).

---

## 3. T315 — Drizzle Kit version guard

### Expected outcome

**No change to `packages/db/package.json`.** Phase 2 catalog work does NOT
require a Drizzle Kit version bump. The current `packages/db/package.json`
pins:

- `drizzle-orm` at `0.45.2` (runtime)
- (No `drizzle-kit` devDependency is currently listed — migrations are
  hand-curated SQL per Constitution §VIII, so the generator package is not
  installed in `packages/db`.)

The migration in T330 is **hand-curated SQL**, not generated. T320's schema
files are authored by hand against the pinned `drizzle-orm@0.45.2` table API.
Neither path needs a Drizzle Kit version bump.

### Risk if a bump becomes necessary

Any version bump to `drizzle-orm`, an addition of `drizzle-kit`, or any peer-
dep change MUST be a **separate PR** with explicit owner approval per
Constitution §VIII. Bundling a version bump with catalog feature work is
forbidden. The reviewer rejects on sight.

### Check method

In the T320 / T331 / T330 PRs, the reviewer runs:

```
git diff -- packages/db/package.json
git diff -- pnpm-lock.yaml
```

Both diffs MUST return empty. If either is non-empty, the PR is bounced.

### Gate sequencing

If a bump IS somehow needed (e.g., a generated migration syntax requires a
newer Drizzle Kit, or `drizzle-orm@0.45.2` cannot express a partial unique
index pattern that T320 needs):

1. T315 opens FIRST as its own PR.
2. Approval is recorded explicitly.
3. Only after T315 lands on `main` does T320 proceed.

### Acceptance for the T315 PR (if any)

- Diff is limited to `packages/db/package.json` and `pnpm-lock.yaml`.
- No `apps/**`, no `packages/contracts/**`, no `packages/db/src/**` change.
- No schema, no migration, no test file edit.
- Commit message: `chore(db): bump Drizzle for catalog foundation (003 T315)`.
- Approval is recorded in the PR review trail.

### Default disposition

**No-op confirmed.** Close T315 with a comment in the catalog PR sequence:
"T315 reviewed; no version bump required."

---

## 4. T320 — Drizzle schema source files

### Future files (exact paths)

- `packages/db/src/schema/catalog/global_products.ts`
- `packages/db/src/schema/catalog/tenant_products.ts`
- `packages/db/src/schema/catalog/tenant_product_categories.ts`
- `packages/db/src/schema/catalog/store_product_overrides.ts`
- `packages/db/src/schema/catalog/product_aliases.ts`
- `packages/db/src/schema/catalog/price_history.ts`
- `packages/db/src/schema/catalog/unknown_items.ts`

### Per-file deliverable

Each file MUST contain only:

- A Drizzle `pgTable(...)` definition that matches `data-model.md §2–§8` for
  the corresponding entity.
- Column types, nullability, defaults, and CHECK constraints expressed via
  the Drizzle API (or, where Drizzle cannot express a CHECK natively, a
  comment pointing to the SQL migration line in T330).
- Foreign keys with explicit `references(...)` + ON DELETE behavior matching
  §6 of this plan.
- Partial unique indexes where required (product_aliases — three of them;
  price_history — two of them; see §6).
- JSDoc / `//` comments referencing the `data-model.md` row, including Q-#
  citations for binding constraints.

### Q-binding constraints — every schema file must honor these

Each Q-# below maps to the data-model.md commitment of the same number.

- **Q1** — `tenant_id NOT NULL` on every tenant-scoped table; FK to
  `tenants.id`. Applies to `tenant_products`, `tenant_product_categories`,
  `store_product_overrides`, `product_aliases`, `price_history`,
  `unknown_items`. Does NOT apply to `global_products` (platform-scoped).
- **Q2** — `store_id` is NULLABLE on `product_aliases` and `price_history`
  (NULL = tenant-wide); NOT NULL on `store_product_overrides` and
  `unknown_items`. Where `store_id` is present, FK to `stores.id`. The
  cross-entity constraint that `stores.tenant_id` MUST equal the row's
  `tenant_id` is enforced in the SQL migration (T330), not in Drizzle.
- **Q3** — Source-of-truth layering: `global_products` is reference-only,
  `tenant_products` is customer truth, `store_product_overrides` is
  branch truth (Constitution §IX). No FK from `tenant_products` to
  `global_products` (see Q5). The Drizzle file for `tenant_products` MUST
  document `source_global_product_id` as a soft reference with NO FK.
- **Q4** — `product_aliases` declares **three** partial unique indexes:
  1. Tenant-wide identifiers (`barcode`, `sku`, and all non-`external_pos_id`
     types) when `store_id IS NULL`, filtered by `retired_at IS NULL`.
  2. `external_pos_id` aliases keyed by `(tenant_id, source_system, value)`,
     filtered by `retired_at IS NULL`.
  3. Store-scoped aliases keyed by `(tenant_id, store_id, identifier_type,
     value)` when `store_id IS NOT NULL`, filtered by `retired_at IS NULL`.
- **Q5** — `tenant_products.source_global_product_id` is `uuid NULL` with
  NO foreign-key declaration. Reviewer enforces this on T320: if a Drizzle
  `.references(globalProducts.id, ...)` is present, the PR is rejected.
  Adopted tenant rows MUST NOT be coupled to global lifecycle.
- **Q6** — Money columns are `numeric(19,4)`:
  - `global_products.default_price`
  - `tenant_products.default_price`
  - `store_product_overrides.price`
  - `price_history.price`
  Floats are forbidden. Drizzle's `numeric({ precision: 19, scale: 4 })` is
  the only acceptable type.
- **Q7** — `tenant_product_categories` has NO `parent_category_id` column.
  This is intentional per Q7 in `data-model.md §4`. (Plan brief originally
  described a self-referential FK; the binding data-model decision is FLAT
  categories in v1. **The T320 file MUST NOT add a `parent_id` column.**
  This contradicts the brief; the binding source is `spec.md §16.Q7` and
  `data-model.md §4`, which both lock the flat model.)
- **Q8** — `store_product_overrides` may override only:
  `price`, `currency_code`, `is_active`, `tax_category`. The SKU /
  identifier and product name are NEVER overrideable at the store level.
- **Q9** — `price_history` rows are insert-only at the application layer.
  The Drizzle file does not enforce immutability (RLS in T330 does). Use
  `effective_from` / `effective_to` with the two open-interval partial
  unique indexes described in §6.
- **Q10** — `unknown_items` carries `encountered_at` (occurredAt) plus
  resolution fields per data-model.md §8. The Drizzle file MUST NOT
  contain any column that holds PII beyond what POS supplied (no email,
  phone, customer name).
- **Q11** — Cross-entity invariant `store_product_overrides.tenant_id ==
  tenant_products.tenant_id` is enforced at the SQL layer in T330 via a
  CHECK + denormalized column OR a composite FK. Drizzle does not enforce
  this; the schema file flags it via comment pointing at the migration
  line.

### Forbidden in T320

- NO SQL migration text (that's T330).
- NO barrel re-export edits to `packages/db/src/schema/index.ts` (that's
  T331).
- NO test files in `packages/db/__tests__/schema/catalog/` (Lane B drafts
  those separately).
- NO `apps/**` change.
- NO `package.json` / `pnpm-lock.yaml` change.
- NO OpenAPI YAML.
- NO CI workflow change.

### Acceptance for the T320 PR

- Diff limited to the seven new files in `packages/db/src/schema/catalog/`.
- Each Q-binding is verifiable by reading the file.
- Lane B schema-shape tests (T316–T325), if bundled, are RED before T320
  lands and GREEN after T320 + T331 land.
- Commit message: `feat(db): add catalog schema source files (003 T320)`.

---

## 5. T331 — Schema index barrel export

### Future files

- `packages/db/src/schema/index.ts` — **extend** the existing barrel:

  Current state (read-only here, for reference):
  ```
  export * from "./users";
  export * from "./tenants";
  export * from "./stores";
  export * from "./roles";
  export * from "./permissions";
  export * from "./memberships";
  export * from "./store_access";
  export * from "./sessions";
  export * from "./devices";
  export * from "./auth_tokens";
  export * from "./invitations";
  export * from "./audit_events";
  export * from "./idempotency_keys";
  export * from "./shifts";
  ```

  Add **one** new line:
  ```
  export * from "./catalog";
  ```

- `packages/db/src/schema/catalog/index.ts` — **new** sub-barrel that
  re-exports the seven catalog schema files:

  ```
  export * from "./global_products";
  export * from "./tenant_products";
  export * from "./tenant_product_categories";
  export * from "./store_product_overrides";
  export * from "./product_aliases";
  export * from "./price_history";
  export * from "./unknown_items";
  ```

### Required exports (verified by Lane B's T316 barrel test)

- `globalProducts`
- `tenantProducts`
- `tenantProductCategories`
- `storeProductOverrides`
- `productAliases`
- `priceHistory`
- `unknownItems`

The exact identifier casing is `camelCase` (Drizzle convention used by the
existing barrel files such as `shifts`, `auditEvents`).

### Forbidden in T331

- NO re-export from any other layer (no module-level side effects, no app
  imports leaking through the barrel).
- NO type aliases that conflict with existing tables (none expected; catalog
  table names are unique within the workspace).
- NO export of helpers, services, or migration artifacts via this barrel.
- NO SQL migration edit (that's T330).
- NO schema source edit (that's T320).

### Acceptance for the T331 PR

- Diff limited to the two files above.
- The barrel diff in `index.ts` adds exactly ONE line (`export * from
  "./catalog";`).
- The new `catalog/index.ts` file is created with the seven sub-exports.
- Commit message: `feat(db): re-export catalog schema from index barrel (003 T331)`.

### Bundling note

T320 + T331 MAY bundle into a single PR if both diffs stay small. The
reviewer accepts a combined PR titled `feat(db): add catalog schema source
files and barrel re-export (003 T320 + T331)`. T331 alone is meaningless
without T320 in the same merged state — the import targets would not exist.

---

## 6. T330 — SQL migration + rollback

### Future files (exact paths)

- `packages/db/drizzle/0006_catalog_foundation.sql` (forward)
- `packages/db/drizzle/0006_catalog_foundation.down.sql` (rollback)

> Numbering: `0006` (NOT `0005`). The existing migration `0005_audit_retention_privileges.sql`
> already occupies slot `0005`. See §2 binding finding.

### Migration ordering — forward `.sql`

Tables are created in dependency order. Each table is created together with
its non-deferrable constraints (PK, NOT NULL, CHECK, FK), then its indexes,
then its RLS policies. Triggers and `updated_at` plumbing follow.

1. `global_products` (no FK to other catalog tables; depends only on
   `users.id` for `created_by`).
2. `tenant_product_categories` (FK to `tenants.id`; no self-referential
   parent FK per Q7).
3. `tenant_products` (FK to `tenants.id`, `tenant_product_categories.id`;
   soft reference to `global_products.id` with NO FK).
4. `store_product_overrides` (FK to `tenant_products.id`, `tenants.id`,
   `stores.id`; plus the Q11 cross-tenant invariant CHECK).
5. `product_aliases` (FK to `tenant_products.id`, `tenants.id`, nullable FK
   to `stores.id`).
6. `price_history` (FK to `tenant_products.id`, `tenants.id`, nullable FK
   to `stores.id`; INSERT-only via RLS).
7. `unknown_items` (FK to `tenants.id`, `stores.id`, nullable FK to
   `tenant_products.id` for resolution).

All indexes, CHECK constraints, partial unique indexes, and RLS policies are
created in the **same** migration. Splitting into multiple migrations is
forbidden — the catalog foundation is atomic.

### Index inventory (forward migration MUST create)

| Index | Table | Columns | Predicate / type | Source |
|---|---|---|---|---|
| `idx_global_products_active` | `global_products` | `(id)` | `WHERE retired_at IS NULL` | data-model §2 |
| `idx_global_products_suggested_category` | `global_products` | `(suggested_category)` | `WHERE retired_at IS NULL` | data-model §2 |
| `idx_tenant_products_tenant_active` | `tenant_products` | `(tenant_id, id)` | `WHERE retired_at IS NULL` | data-model §3 |
| `idx_tenant_products_tenant_category` | `tenant_products` | `(tenant_id, category_id)` | `WHERE retired_at IS NULL` | data-model §3 |
| `idx_tenant_products_source_global` | `tenant_products` | `(source_global_product_id)` | `WHERE source_global_product_id IS NOT NULL` | data-model §3 |
| `idx_tenant_product_categories_tenant_active` | `tenant_product_categories` | `(tenant_id)` | `WHERE retired_at IS NULL` | data-model §4 |
| `UQ_idx_tenant_product_categories_tenant_name` | `tenant_product_categories` | `(tenant_id, name)` | partial UQ `WHERE retired_at IS NULL` | data-model §4 |
| `idx_store_product_overrides_store_active` | `store_product_overrides` | `(tenant_id, store_id)` | `WHERE retired_at IS NULL` | data-model §5 |
| `idx_store_product_overrides_product` | `store_product_overrides` | `(tenant_id, product_id)` | `WHERE retired_at IS NULL` | data-model §5 |
| `UQ_idx_store_product_overrides_product_store` | `store_product_overrides` | `(tenant_id, store_id, product_id)` | partial UQ `WHERE retired_at IS NULL` | data-model §5 |
| `UQ_idx_product_aliases_tenant_wide` | `product_aliases` | `(tenant_id, identifier_type, value)` | partial UQ `WHERE store_id IS NULL AND identifier_type <> 'external_pos_id' AND retired_at IS NULL` | data-model §6 / Q4 |
| `UQ_idx_product_aliases_external_pos_id` | `product_aliases` | `(tenant_id, source_system, value)` | partial UQ `WHERE identifier_type = 'external_pos_id' AND retired_at IS NULL` | data-model §6 / Q4 / Constitution §XI |
| `UQ_idx_product_aliases_store_scoped` | `product_aliases` | `(tenant_id, store_id, identifier_type, value)` | partial UQ `WHERE store_id IS NOT NULL AND retired_at IS NULL` | data-model §6 / Q4 |
| `idx_product_aliases_lookup` | `product_aliases` | `(tenant_id, identifier_type, value)` | `WHERE retired_at IS NULL` | data-model §6 |
| `idx_product_aliases_product` | `product_aliases` | `(tenant_id, product_id)` | `WHERE retired_at IS NULL` | data-model §6 |
| `UQ_idx_price_history_tenant_open` | `price_history` | `(tenant_id, product_id)` | partial UQ `WHERE store_id IS NULL AND effective_to IS NULL` | data-model §7 / Q9 |
| `UQ_idx_price_history_store_open` | `price_history` | `(tenant_id, product_id, store_id)` | partial UQ `WHERE store_id IS NOT NULL AND effective_to IS NULL` | data-model §7 / Q9 |
| `idx_price_history_product_timeline` | `price_history` | `(tenant_id, product_id, effective_from DESC)` | — | data-model §7 |
| `idx_price_history_store_timeline` | `price_history` | `(tenant_id, product_id, store_id, effective_from DESC)` | `WHERE store_id IS NOT NULL` | data-model §7 |
| `idx_unknown_items_pending` | `unknown_items` | `(tenant_id, store_id)` | `WHERE resolution_status = 'pending'` | data-model §8 |
| `idx_unknown_items_lookup_value` | `unknown_items` | `(tenant_id, identifier_type, value)` | `WHERE resolution_status = 'pending'` | data-model §8 |
| `idx_unknown_items_encountered_at` | `unknown_items` | `(tenant_id, encountered_at DESC)` | — | data-model §8 |

### CHECK-constraint inventory (forward migration MUST create)

Per data-model.md §2–§8, the forward migration creates (non-exhaustive list of
the **high-leverage** checks; the migration MUST include all checks declared
in data-model.md for each table):

- `CHK global_products_currency_paired`: `default_price` and
  `default_currency_code` are both NULL or both NOT NULL.
- `CHK tenant_products_currency_paired`: same pairing rule.
- `CHK tenant_products_name_length`: 1..500 chars.
- `CHK tenant_products_tax_category_length`: 1..50 chars.
- `CHK store_product_overrides_currency_paired`: same pairing rule.
- `CHK store_product_overrides_at_least_one_override`: NOT all of `price`,
  `is_active`, `tax_category` may be NULL — an override row with no override
  fields is meaningless.
- `CHK store_product_overrides_tenant_invariant` (Q11): the
  `store_product_overrides.tenant_id` equals the corresponding
  `tenant_products.tenant_id` AND the `stores.tenant_id`. Implementation
  choices:
  1. Composite FK `(tenant_id, product_id)` → `tenant_products(tenant_id, id)`
     with a matching composite unique on `tenant_products(tenant_id, id)`.
     Combined with a composite FK `(tenant_id, store_id)` →
     `stores(tenant_id, id)`.
  2. Or denormalized + CHECK + trigger.
  Plan recommendation: composite FK (option 1) — DB-level, no trigger, no
  drift risk. The reviewer enforces this in the T330 PR.
- `CHK product_aliases_identifier_type_valid`: enumerated allow-list.
- `CHK product_aliases_source_system_required`: `source_system` is required
  iff `identifier_type = 'external_pos_id'`.
- `CHK product_aliases_store_scope_consistency`: `store_id IS NULL OR
  identifier_type <> 'external_pos_id'`.
- `CHK price_history_interval_order`: `effective_to IS NULL OR effective_to
  > effective_from`.
- `CHK price_history_price_positive`: `price >= 0`.
- `CHK unknown_items_identifier_type_valid`.
- `CHK unknown_items_resolved_fields_consistent`: all-or-none on
  `resolution_status / resolved_at / resolved_by / resolution_action`.
- `CHK unknown_items_linked_product_present`: `resolution_action` ∈
  `{linked, created}` implies `resolved_product_id IS NOT NULL`;
  `dismissed` implies NULL.
- `CHK unknown_items_source_system_required`: `source_system` is required
  iff `identifier_type = 'external_pos_id'`.

> Money non-negativity is enforced for catalog prices via the same pattern.
> The data-model.md does not currently spell out a `CHECK (default_price >=
> 0)` on `global_products` / `tenant_products` / `store_product_overrides`,
> but plan.md §2.1 Q1 requires `CHECK >= 0` on all money columns. **The T330
> migration MUST add `CHECK (default_price IS NULL OR default_price >= 0)`
> on `global_products` and `tenant_products`, and `CHECK (price IS NULL OR
> price >= 0)` on `store_product_overrides`.** This is a binding constraint
> the reviewer enforces.

### RLS policy inventory (forward migration MUST create)

Per data-model.md §10. Every catalog table has RLS enabled. The runtime DB
role MUST NOT carry `BYPASSRLS` (Constitution §II).

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `global_products` | TRUE (any authenticated session) | `app.current_role = 'platform_admin'` | `app.current_role = 'platform_admin'` | `app.current_role = 'platform_admin'` |
| `tenant_products` | tenant match | tenant match | tenant match | tenant match |
| `tenant_product_categories` | tenant match | tenant match | tenant match | tenant match |
| `store_product_overrides` | tenant + (store match OR `app.current_store = ''`) | tenant + store match | tenant + store match | tenant + store match |
| `product_aliases` | tenant match | tenant match | tenant match | tenant match |
| `price_history` | tenant match | tenant match | **FALSE** (no UPDATE) | **FALSE** (no DELETE) |
| `unknown_items` | tenant + (store match OR `app.current_store = ''`) | tenant match | tenant match | (typically not granted) |

Policy names follow the existing repo convention used by `audit_events`,
`sessions`, and `shifts` policies (snake_case `<table>_<verb>_<scope>`).
The reviewer checks that the policy names declared in the migration match
data-model.md §2–§8 exactly.

Cross-tenant access returns a safe 404 (Constitution §XII). The migration
itself enforces the RLS policy; the API layer maps the empty result set to
the uniform 404 envelope.

### Rollback expectations — `.down.sql`

- Drops tables in **reverse dependency order**:
  1. `unknown_items`
  2. `price_history`
  3. `product_aliases`
  4. `store_product_overrides`
  5. `tenant_products`
  6. `tenant_product_categories`
  7. `global_products`
- Each drop is `DROP TABLE IF EXISTS <name> CASCADE;` (idempotent).
- RLS policies and indexes drop with the tables — no separate `DROP POLICY`
  / `DROP INDEX` statements needed because `DROP TABLE` cascades them.
- Any helper functions or triggers created in the forward migration
  (`updated_at` trigger function, for instance) are also dropped here if
  they are catalog-specific. If a generic `set_updated_at()` function was
  reused from an earlier migration, the down migration MUST NOT drop it.
- Rollback MUST be tested in a Testcontainers harness — covered by Lane C's
  migration-test plan (tasks T326, T327) which lives outside T330's
  responsibilities. T330's `.down.sql` is responsible for being CORRECT;
  T327 proves it.

### Forbidden in T330

- NO schema source edits (that's T320).
- NO barrel edit (that's T331).
- NO Drizzle Kit version bump (that's T315, conditional).
- NO `apps/**` change.
- NO `packages/contracts/openapi/**` change.
- NO addition of `_sales`, `_orders`, `_invoices`, `_inventory`,
  `_promotions`, `_suppliers`, or `_pos_*` tables — out-of-scope per
  `tasks.md §18` and enforced by Lane C T455.
- NO use of `drizzle-kit generate` to produce the migration. Generated SQL
  is reference only; the committed `0006_catalog_foundation.sql` is
  **hand-curated** per Constitution §VIII and `plan.md §1.1` ("Migrations:
  Drizzle Kit → explicit SQL files").

### Acceptance for the T330 PR

- Diff limited to the two SQL files in `packages/db/drizzle/`.
- Lane C migration tests (T326–T329), if bundled, are RED before T330 lands
  and GREEN after.
- Numbering is `0006` (not `0005`).
- Commit message: `feat(db): add catalog foundation SQL migration 0006 (003 T330)`.

---

## 7. Constraint cross-reference table

Each Q-# maps to:
- The T320 schema file that implements it.
- The T330 migration assertion that enforces it.
- The Lane B schema-shape test (`packages/db/__tests__/schema/catalog/`)
  that asserts it pre-migration.
- The Lane C migration test (`packages/db/__tests__/migration/`) that
  asserts it post-migration.

| Q | Constraint | T320 schema file | T330 migration assertion | Lane B test (T###) | Lane C test (T###) |
|---|---|---|---|---|---|
| Q1 | `tenant_id NOT NULL` on tenant-scoped tables | all six tenant-scoped files | `NOT NULL` + FK to `tenants.id` | T318/T319/T321/T322/T323/T324 | T326 |
| Q2 | `store_id` nullability per table | `product_aliases`, `price_history`, `store_product_overrides`, `unknown_items` | `NOT NULL` on overrides/unknown; `NULL` on aliases/history | T321/T322/T323/T324 | T326 |
| Q3 | Source-of-truth layering | all seven files; `tenant_products` documents soft ref | no FK from `tenant_products` to `global_products`; verified by T328 | T318 | T326, T328 |
| Q4 | Three partial unique indexes on `product_aliases` | `product_aliases.ts` | three partial unique indexes from §6 inventory | T322 | T326 |
| Q5 | `source_global_product_id` has NO FK | `tenant_products.ts` | no FK constraint in migration | T318 | T328 |
| Q6 | `numeric(19,4)` for all money columns | `global_products`, `tenant_products`, `store_product_overrides`, `price_history` | `numeric(19,4)` + `CHECK >= 0` | T317/T318/T321/T323 | T329 |
| Q7 | No `parent_category_id` on categories | `tenant_product_categories.ts` | no self-referential FK | T319 | T326 |
| Q8 | Overrideable fields limited to price/availability/tax_category | `store_product_overrides.ts` | only those columns + ID/scope columns | T321 | T326 |
| Q9 | Insert-only price history; effective intervals | `price_history.ts` | RLS UPDATE/DELETE = FALSE; partial UQ on open intervals; `CHECK interval_order` | T323 | T326 (immutability assertion) |
| Q10 | Unknown items have resolution fields, no PII | `unknown_items.ts` | `CHECK resolved_fields_consistent`; `CHECK linked_product_present` | T324 | T326 |
| Q11 | `store_product_overrides.tenant_id == tenant_products.tenant_id` | `store_product_overrides.ts` (comment pointing at SQL) | composite FK OR CHECK + trigger | T321 | T326 |

> SaleLine Snapshot obligation (`plan.md §3.4`) is enforced not in T320/T330
> but in **Lane B's T404 fixture** (Testcontainers-only stub table). This
> plan records the obligation; T330 MUST NOT create a sale-line table.

---

## 8. Testcontainers validation strategy

Two layers of TDD work surround the four gated tasks:

### Layer 1 — Drizzle TypeScript schema-shape tests (Lane B, T316–T325)

- Live under `packages/db/__tests__/schema/catalog/`.
- Run against the Drizzle TypeScript model WITHOUT a database.
- Fast unit tests; no Testcontainers; no Postgres.
- Validate column types, nullability, indexes, and barrel exports declared
  by T320 / T331.
- TDD direction: tests are written first, RED until T320 + T331 land,
  GREEN after.

### Layer 2 — Migration / RLS / FK / CHECK tests (Lane C, T326–T329)

- Live under `packages/db/__tests__/migration/`.
- Run against a real Postgres in Testcontainers (already present in
  `@testcontainers/postgresql@11.14.0` per `packages/db/package.json`).
- Verify:
  - Forward migration creates all seven tables, indexes, RLS policies,
    CHECK constraints, partial unique indexes (T326).
  - Rollback removes everything T326 verified (T327).
  - Non-cascade FK behavior — Q5 (T328).
  - Money columns are `numeric(19,4)` and have `CHECK >= 0` — Q6 (T329).
- TDD direction: tests are written first, RED until T330 lands, GREEN after.

### Both layers are TDD

The schema-shape tests (Lane B) MAY be bundled with the T320+T331 PR to keep
`main` from showing a red state. The migration tests (Lane C) MAY be bundled
with the T330 PR for the same reason. See §10 for the recommended PR-by-PR
slicing.

---

## 9. Explicit owner approval checklist

Reviewer MUST verify **every box** before approving any of T315 / T320 /
T331 / T330:

- [ ] The PR title matches the recommended title in §10 for that task.
- [ ] The PR diff is limited to the exact paths listed in §3 / §4 / §5 / §6
      for that task.
- [ ] No `apps/**` change.
- [ ] No `package.json` change (except for T315, which MUST be its own PR
      if needed).
- [ ] No `pnpm-lock.yaml` change (except for T315).
- [ ] No `packages/contracts/openapi/**` change.
- [ ] No `.github/workflows/**` change.
- [ ] No `loadtests/**` change.
- [ ] No `.specify/**` change.
- [ ] No `specs/004-platform-production-readiness/**` change.
- [ ] No catalog-implementation PR (controllers, services, DTOs in
      `apps/api/src/modules/catalog/**`) landed under cover of a different
      task.
- [ ] No SaleLine Snapshot / `_sales` / `_orders` / `_invoices` /
      `_inventory` / `_promotions` / `_suppliers` / `_pos_*` table added
      to the schema or migration.
- [ ] Migration number is `0006` (not `0005`).
- [ ] For T320: each Q1–Q11 binding is visible in the schema file or
      pointed at by an in-file comment referencing the migration line.
- [ ] For T330: every CHECK / RLS / partial UQ from §6 is present.
- [ ] For T330: composite-FK or CHECK enforcement of Q11 cross-tenant
      invariant is present.
- [ ] For T330: RLS UPDATE/DELETE on `price_history` is `FALSE`.
- [ ] For T330: rollback `.down.sql` drops tables in reverse dependency
      order with `IF EXISTS CASCADE`.
- [ ] Lane B's schema-shape tests are landed (or paired in the T320 PR per
      §10).
- [ ] Lane C's migration tests are landed (or paired in the T330 PR per
      §10).

---

## 10. Recommended thin implementation slices

The recommended PR-by-PR rollout order is below. The reviewer MAY accept
small bundles (noted) but MUST reject large ones.

| # | Slice | Tasks | Recommended PR title |
|---|---|---|---|
| 1 | T316–T325 schema-shape tests (Lane B output, RED until paired) | T316–T325 | DRAFT branch — bundle into Slice 3 per the recommendation below |
| 2 | T315 Drizzle Kit version guard (conditional — only if a bump is required) | T315 | `chore(db): bump Drizzle Kit for catalog foundation (003 T315)` |
| 3 | T320 schema source files + T331 barrel re-exports + Lane B tests | T316–T325, T320, T331 | `feat(db): add catalog schema sources, barrel, and shape tests (003 T320 + T331 + T316-T325)` |
| 4 | T330 SQL migration + rollback + Lane C migration tests | T326–T329, T330 | `feat(db): add catalog foundation SQL migration 0006 with Testcontainers tests (003 T330 + T326-T329)` |
| 5 | (Future) T335+ — helpers, services, controllers | T335–T431 | Separate per-phase PRs per `tasks.md` |

### Bundling recommendations (subject to owner discretion)

- **T320 + T331 SHOULD bundle** with Lane B's schema-shape tests (T316–T325).
  Reasoning: T331 alone has nothing to re-export; T320 alone leaves the
  barrel untouched and the Lane B tests RED on `main`. Bundling avoids a
  multi-PR red state. The combined diff is small (seven Drizzle files,
  two barrel edits, ~ten test files).
- **T330 SHOULD bundle** with Lane C's executable migration tests
  (T326–T329). Reasoning: the tests would otherwise be RED on `main` for
  the duration of the PR sequence. Bundling preserves green CI.
- **T315 MUST NOT bundle** with anything else. Version bumps are always
  isolated per Constitution §VIII.
- **Lane B schema-shape tests SHOULD bundle with T320 + T331**, since they
  validate exactly the source-of-truth those tasks add. Bundling avoids a
  multi-PR red-state on `main`.
- **No PR may bundle T320, T331, AND T330 together.** That would mix
  schema source + migration in one diff and defeat the per-task gating.
  The reviewer rejects.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Drizzle Kit minor version difference silently changes generated migration output. | T330 is hand-curated, NOT generated. T315 check is mandatory before any generation pipeline is used. |
| T330 migration drift between Drizzle-generated SQL and hand-curated SQL. | T330 is hand-curated; do NOT use `drizzle-kit generate` to write the migration. The generated output, if any, is reference only and discarded. |
| Q5 non-cascade FK is missed and a global-products row deletion silently cascades to `tenant_products`. | T320 declares `source_global_product_id` with NO `.references(...)` clause. Lane B T318 asserts no FK on this column. Lane C T328 attempts a `DELETE FROM global_products WHERE id = ...` and asserts the related `tenant_products` row is untouched. |
| Q11 CHECK enforced only at app layer; bypassed by a future direct write. | T330 implements Q11 via composite FK `(tenant_id, product_id) → tenant_products(tenant_id, id)` plus composite FK `(tenant_id, store_id) → stores(tenant_id, id)`. DB-level. Reviewer rejects any T330 PR that uses trigger-only enforcement without also providing the composite FK. |
| RLS policies forgotten on a new table. | Lane C T326 enumerates every catalog table and asserts at least one SELECT, INSERT, UPDATE, DELETE policy exists (with the specific FALSE policies on `price_history`'s UPDATE/DELETE). |
| Catalog scope creeps into the same PR as 004 production-readiness work. | `specs/004-platform-production-readiness/tasks.md` establishes the parallelism contract; reviewer enforces. T330 PR diff MUST NOT touch `specs/004-platform-production-readiness/**`. |
| Migration number collision — brief said `0005`, repo state says `0006`. | This plan §2 binding finding records the correction. The reviewer enforces `0006_catalog_foundation.sql` in T330. |
| `tasks.md §5.3` text legacy-references `0001_catalog.sql`. | The legacy `0001_catalog.sql` reference in `tasks.md` is the original draft numbering. The actual migration at gate time is `0006_catalog_foundation.sql`. Reviewer applies §2 of this plan when interpreting `tasks.md §5.3`. |
| Q7 brief contradiction — the brief listed a self-referential `parent_category_id`, but `spec.md §16.Q7` and `data-model.md §4` lock the flat model. | This plan §4 explicitly removes `parent_category_id`. Reviewer enforces NO `parent_id` column in `tenant_product_categories`. The brief text is overridden by the binding spec + data-model. |
| Composite FK approach for Q11 requires a composite unique constraint on `tenant_products(tenant_id, id)` — which is non-trivial since `id` is already PK. | The migration adds `UNIQUE (tenant_id, id)` on `tenant_products` (cheap, since `id` is already unique; the composite is "unique on a superset"). Same applies to `stores(tenant_id, id)` if not already present. The reviewer checks the migration for these companion unique constraints. |
| `unknown_items.sale_context jsonb` could leak PII to logs. | data-model §8 records the redaction obligation. T330 does NOT add column-level redaction (a future logger-boundary task does). Reviewer notes this is an obligation for the future logging-level guard test, not a T330 deliverable. |
| `tenants.default_currency_code` amendment from data-model §13 might be expected to land in T330. | This plan SCOPES T330 to the seven catalog tables. The `tenants` table amendment is a separate gated migration the reviewer assigns to a subsequent task — it MUST NOT be bundled into `0006_catalog_foundation.sql`. If the implementation feature needs the column, a `0007_tenant_default_currency.sql` migration is required as its own PR. The reviewer rejects any T330 PR that touches the `tenants` table. |

---

## 12. Out-of-scope (explicit non-goals)

The following are **NOT** part of T315 / T320 / T331 / T330 and MUST be
deferred to other features or other tasks:

- POS read-model implementation (see `pos-read-model-direction.md` —
  future feature).
- Catalog OpenAPI contract authoring (T370, T371 in `tasks.md §8` — gated
  but separate from this plan's four tasks).
- Catalog API controllers / services / DTOs in `apps/api/src/modules/catalog/**`
  (Phase 3+ in `tasks.md`).
- Inventory, sales, pricing-promotion, supplier, tax-engine features.
- SaleLine Snapshot table (binding obligation only — see `plan.md §3.4`,
  `data-model.md §12`).
- `tenants.default_currency_code` amendment (data-model §13) — separate
  gated migration.
- Helpers (`withTenant`, `withStore`) — these already exist from Feature
  001; no edit required. Tests against catalog (T335, T336) are
  post-T330 work.
- RLS isolation sweep harness (T340–T344) — post-T330 work.
- Anything in `specs/004-platform-production-readiness/**`.

---

## 13. Plan completion criteria

This planning artifact is "done" when:

- [x] Every gated task (T315, T320, T331, T330) has a concrete scope, file
      list, Q-binding map, forbidden-path list, and acceptance checklist.
- [x] The migration numbering correction (`0006`, not `0005`) is recorded
      and justified against the actual `packages/db/drizzle/` state.
- [x] The Q7 contradiction between the brief and the binding spec is
      recorded; the spec wins.
- [x] The Q11 composite-FK strategy is named and the companion unique
      constraint on `tenant_products(tenant_id, id)` is identified.
- [x] Every Q1–Q11 binding has a test-coverage row in §7.
- [x] PR-by-PR slicing is recommended in §10, with bundling rules explicit.
- [x] Risks beyond the brief are named in §11.
- [x] No code, schema, migration, OpenAPI YAML, package file, lockfile,
      CI config, generated file, or application source has been modified
      by this PR.

---

## 14. Approval

**Pending**: Owner approval of this plan.

**Next steps on approval**:

1. Lane B publishes T316–T325 schema-shape tests as a draft branch.
2. T315 gate is opened with a "no-op confirmed" note (or, rarely, a
   version-bump PR).
3. T320 + T331 + Lane B tests merge as Slice 3.
4. Lane C publishes T326–T329 migration tests as a draft branch.
5. T330 + Lane C tests merge as Slice 4.
6. Phase 3+ (`tasks.md §6+`) proceeds with services, controllers, and the
   isolation sweep harness — outside this plan.
