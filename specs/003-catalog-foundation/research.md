# Research Decisions: Catalog Foundation

**Feature ID**: 003
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Tasks**: [tasks.md](./tasks.md) — tasks T300, T301
**Constitution**: v3.0.0
**Status**: Decisions locked — no TBD markers
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban

> These decisions resolve the five research items from plan §4 (R-1..R-5)
> and the six plan-level open questions from plan §9 (PQ-1..PQ-6). Each
> decision is binding for the future implementation feature. No application
> code, schema, migrations, or OpenAPI YAML are authored here.

---

## R-1 — Effective-interval enforcement for price_history

**Research question**: How should the `price_history` table enforce
non-overlapping effective intervals (`effective_from` / `effective_to`) per
product (and per store for store-override prices)? Two sub-questions:
(a) Should `effective_to` for the current price be `NULL` or `'infinity'`?
(b) Should overlap prevention use a PostgreSQL exclusion constraint or
application-level serializable isolation?

### Decision

**`effective_to` representation**: Use `NULL` for the open (current) price
interval. A `NULL` `effective_to` means "this price is currently active."

**Overlap enforcement**: Use a **partial unique index** on
`(tenant_id, product_id, effective_to) WHERE effective_to IS NULL`
(and a matching index for store-override price history scoped to
`(tenant_id, product_id, store_id, effective_to) WHERE effective_to IS NULL`)
to enforce "at most one open interval per product (× store)" at the database
level. Non-overlapping intervals for closed rows are enforced by application
code under **read-committed isolation + optimistic check**: the price-write path
reads the current open interval, closes it (`effective_to = now()`), and inserts
the new row in a single serialized service call. The exclusion-constraint
approach (using `tstzrange` + `EXCLUDE USING gist`) is deferred unless T403
concurrency tests reveal collisions under realistic load.

### Rationale

- `NULL` open intervals are idiomatic in PostgreSQL for "active record"
  semantics and align with the soft-delete pattern (`retired_at IS NULL`) used
  throughout this feature (R-3). `'infinity'` adds no correctness benefit and
  produces surprising behavior in `BETWEEN` range queries.
- A partial unique index on `effective_to IS NULL` is lightweight, human-readable
  in `\d` output, and enforces the one-open-interval invariant without requiring
  the `btree_gist` extension or range-type columns. It is sufficient for v1 write
  patterns, which are low-frequency catalog price edits rather than high-frequency
  transactional writes.
- A full `tstzrange` exclusion constraint adds implementation complexity
  (extension dependency, range-type column, Drizzle support gaps) with limited
  benefit at this catalog write volume. The plan §8 risk register already names
  the overlap risk and gates the concurrency test (T403) as the trip-wire.

### Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `effective_to = 'infinity'` for current price | No query correctness benefit; range queries behave unexpectedly with `infinity`; `IS NULL` check is more readable and consistent with soft-delete pattern. |
| `EXCLUDE USING gist (tstzrange(...) WITH &&)` constraint | Requires `btree_gist` extension; `tstzrange` column not present in the base design; significant Drizzle migration complexity. Revisit in T490 if T403 reveals failures. |
| Full event-sourcing (append-only, no `effective_to` close) | Heavier query model; current price requires a MAX(`effective_from`) aggregation rather than a simple `WHERE effective_to IS NULL` filter. Adds ongoing query complexity for no v1 benefit. Per plan §8, this is explicitly deferred. |

---

## R-2 — Tenant default currency storage

**Research question**: Should the tenant default currency be stored as a
dedicated column on the `tenants` table or as a row in a `tenant_settings`
key-value table? Spec Q2 requires every monetary record to carry an explicit
`currency_code`; the tenant default is used only as the pre-fill when creating
new catalog rows.

### Decision

**A dedicated column `default_currency_code char(3) NOT NULL DEFAULT 'USD'`
on the `tenants` table.**

### Rationale

- The read path for a catalog write needs only to join `tenants` once to
  retrieve the pre-fill currency. A settings-table lookup requires a second
  query or a join that adds noise to every catalog write; it does not simplify
  any other concern in v1.
- The `tenants` table already carries per-tenant configuration (name, slug, plan,
  etc. from Feature 001). Adding one currency column is additive and matches the
  spirit of "settings that every tenant must have exactly one value of."
- `char(3)` is the ISO 4217 currency code width. A `NOT NULL DEFAULT 'USD'`
  constraint means existing tenants without an explicit currency stay functional
  without a backfill migration.
- The settings-table approach is appropriate when settings are sparse, optional,
  or unbounded in number. A mandatory default currency is none of those.
- **This decision does not conflict with spec Q2**: individual monetary records
  still carry their own `currency_code` column. The tenant default is a creation
  pre-fill only, not an override of stored values.

### Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `tenant_settings (tenant_id, key, value text)` key-value table | Adds a second table and join for a single mandatory value; schema-less key/value makes static analysis and type safety harder; no extensibility benefit is needed for v1. |
| `tenant_settings (tenant_id, default_currency_code)` dedicated-row settings table (typed) | Adds a one-row-per-tenant settings table; same join cost as the column approach with no benefit; re-introduces the null/missing-row case for new tenants. |
| Store `currency_code` only on monetary records; no tenant default | Requires every catalog write to supply a currency code explicitly; UX burden for admins; increases chance of implicit-currency bugs at the API boundary. Spec Q2 intends the tenant default as a convenience, not as a constraint to avoid. |

---

## R-3 — Soft-delete shape for catalog tables

**Research question**: Should catalog tables use `retired_at timestamptz NULL`
(timestamp-based soft-delete) or a `status` enum (`active / retired / suspended`
/ etc.) for retire flows? Constitution §14 requires soft-delete as the default.

### Decision

**`retired_at timestamptz NULL` on all catalog tables that support retirement.**
`retired_at IS NULL` means the row is active. `retired_at IS NOT NULL` means it
is retired.

Applies to: `tenant_products`, `tenant_product_categories`, `store_product_overrides`
(available/active status is a separate `is_active` boolean per Q8), `global_products`.

`product_aliases` use `retired_at` for deactivation (not deletion).
`price_history` rows are **immutable** and are never retired — this table has no
`retired_at` column (Q9; plan §3.4 binding).
`unknown_items` are resolved, not retired — they use a `resolved_at` column with a
`resolved_by` actor reference (no `retired_at`).

### Rationale

- Feature 001 established `retired_at` as the canonical soft-delete pattern for
  this codebase (invitations, sessions). Consistent soft-delete reduces the
  cognitive load of reading any query's WHERE clause.
- `retired_at IS NULL` is a simple, indexable filter. A partial index on
  `(tenant_id) WHERE retired_at IS NULL` efficiently supports the active-product
  read path.
- A `status` enum is appropriate when there are more than two meaningful states
  (e.g., `draft / pending_review / active / suspended / retired`). Catalog products
  in v1 are either active or retired; no intermediate states are specified in spec
  §5.2 or §5.3. If a `draft` status is needed in a future feature, it can be added
  as a separate nullable `published_at` column without replacing `retired_at`.
- `retired_at` records the exact time of retirement, which is an auditable fact.
  An enum flag without a timestamp requires a separate audit event to know when the
  status changed; `retired_at` combines both concerns.

### Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `status enum('active', 'retired')` | Two-state enum adds no information beyond `retired_at IS NULL / NOT NULL`; loses the timestamp of retirement without a second column; diverges from 001's established pattern. |
| `status enum('draft', 'active', 'retired')` | Draft status is not specified in this feature's scope (spec §3 Non-Goals); premature; can be added later as `published_at`. |
| Hard-delete | Forbidden by Constitution §14 and spec §6.2 (price history immutability). Cannot hard-delete a product that has price history or future SaleLine Snapshots. |
| `deleted_at` instead of `retired_at` | "Deleted" implies removal; "retired" is semantically accurate for catalog products that are discontinued but historically referenced. Naming follows spec §5.2 language. |

---

## R-4 — Resolved-view query strategy

**Research question**: When computing `Resolved(store) = Tenant Catalog ⊕ Store Override`,
which query pattern should be used: inline CTE, lateral join, or a
PostgreSQL view / materialized view? This affects the read-path performance and
the complexity of future changes to overrideable fields (per Q8).

### Decision

**Inline CTE in the Drizzle query layer**, expressed as a TypeScript helper
function `buildResolvedCatalogQuery(tenantId, storeId)` that returns a Drizzle
SQL fragment. No database view object is created in v1.

The CTE pattern:

```sql
WITH store_overrides AS (
  SELECT product_id, price, currency_code, is_active, tax_category
  FROM store_product_overrides
  WHERE tenant_id = $tenantId AND store_id = $storeId
    AND retired_at IS NULL
)
SELECT
  p.id,
  p.name,
  p.category_id,
  COALESCE(so.price,         p.default_price)        AS price,
  COALESCE(so.currency_code, p.default_currency_code) AS currency_code,
  COALESCE(so.is_active,     p.is_active)             AS is_active,
  COALESCE(so.tax_category,  p.tax_category)          AS tax_category
FROM tenant_products p
LEFT JOIN store_overrides so ON so.product_id = p.id
WHERE p.tenant_id = $tenantId
  AND p.retired_at IS NULL
```

The field-level `COALESCE` implements the "Store Override wins where set, Tenant
Catalog is the fallback" rule from spec §6.4 in a single, readable pass.

### Rationale

- **Inline CTE is the simplest correct implementation** for v1 read patterns
  (dashboard lookups, alias resolution). The query is straightforward, reviewable
  in a git diff, and honors the overrideable-fields list from Q8 without a schema
  object that would need its own migration to change.
- A **database view** (`CREATE VIEW resolved_catalog AS ...`) would hide the query
  logic from code review and require a DDL migration every time Q8's overrideable
  fields expand. It is appropriate when the view is shared across many callers;
  in v1 the only consumer is `ResolvedCatalogView` in the API.
- A **lateral join** achieves the same result but is less readable for the
  overrideable-fields pattern; it provides no performance advantage over a
  LEFT JOIN + COALESCE for this access pattern.
- A **materialized view** adds cache-invalidation complexity (refresh on
  every price/override write) that is premature for v1 dashboard read latency.
  Plan §9 PQ-4 already names this as the fallback if latency benchmarks show
  a problem.
- The Drizzle helper function is the right abstraction boundary: the query
  logic lives in the service layer (versioned in code), not in the database
  schema (versioned as DDL), which avoids a gated migration to change a read
  query.

### Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `CREATE VIEW resolved_catalog` in migration | DDL migration needed for every field addition; view logic hidden from code review; adds schema object for a single API consumer. |
| `CREATE MATERIALIZED VIEW` | Cache-invalidation complexity; refresh on every override write; premature for v1 load. |
| Lateral join instead of CTE + LEFT JOIN | Equivalent correctness; less readable for the COALESCE/override pattern; no performance benefit at v1 scale. |
| Application-layer merge (load both rows, merge in TypeScript) | Two round trips; misses database-level RLS filtering on the override row; harder to paginate correctly. |

---

## R-5 — Tax category value space

**Research question**: Should `tax_category` be a free-form text field or a
tenant-scoped enum table? Spec Q11 resolved: minimal opaque label, no tax engine.
The research question is whether the label values should be validated against a
tenant-managed set.

### Decision

**Free-form text with a soft server-side validator** in v1:

- `tax_category text NOT NULL` on `tenant_products` and `store_product_overrides`.
- No `tenant_tax_categories` table in v1.
- The Zod DTO for catalog writes validates `tax_category` against a regex
  `^[a-z0-9_]{1,50}$` (lowercase alphanumeric + underscores, max 50 chars).
  This prevents garbage values without locking tenants into a fixed vocabulary.
- Recommended starter values documented (not enforced): `standard`, `zero`,
  `exempt`, `reduced`. These are suggestions in API documentation, not DB
  constraints.

### Rationale

- **v1 tax category usage is lightweight**: the field is a classification label
  for future SaleLine Snapshot capture (spec §5.4 obligation). No calculation, no
  jurisdiction logic. The risk of a free-string in this context is a typo
  (`standart` vs `standard`), which the regex + length validator mitigates.
- A **tenant-scoped enum table** (`tenant_tax_categories`) requires: a CRUD API
  for managing categories, FK constraint on `tenant_products`, a migration for
  the junction, and a UI surface — all for a field that stores 3–4 values per
  tenant in v1. This is premature scope (spec §3 Non-Goals: no tax engine).
- A **soft validator at the Zod layer** catches malformed values at the API
  boundary without adding schema objects. A future migration to a proper enum
  table is non-breaking: the existing `text` values become the seed data for the
  new table, and the FK constraint is added in a separate migration.
- The regex constraint `^[a-z0-9_]{1,50}$` is conservative enough to prevent
  injection-style values while allowing multi-word categories (`reduced_food`,
  `zero_rated_exports`) that real retail tax treatment requires.

### Alternatives considered

| Alternative | Why not chosen |
|---|---|
| `tenant_tax_categories` enum table with FK | Requires CRUD API + UI surface + FK migration for 3–4 values per tenant; premature for v1; out of scope per spec §3. |
| Unconstrained `text` (no validator) | Allows garbage values that would be difficult to migrate to a structured enum later; typo risk at the API surface. |
| Platform-wide fixed enum (e.g. `CHECK (tax_category IN ('standard','zero','exempt'))`) | Forces all tenants onto a fixed vocabulary; different jurisdictions use different labels; not extensible without a DB migration. |
| `jsonb` metadata blob | Over-engineered; obscures the field from SQL queries and RLS auditing; not queryable without extraction. |

---

## PQ-1 — Tenant default currency: column on tenants vs tenant_settings table

**Default resolution**: **Column `default_currency_code char(3) NOT NULL DEFAULT 'USD'`
on the `tenants` table.**

**Why this is safe for v1**: The tenant default currency is a single mandatory
value that every tenant must have. A dedicated column provides a simple, indexed
join path for catalog writes that need the pre-fill currency. There is no v1
requirement for multi-key settings extensibility. This decision is consistent with
R-2 and with Feature 001's `tenants` table design.

**What would require revisiting**: If tenants need per-store default currencies, or
if the number of per-tenant settings grows beyond a handful of typed columns, a
`tenant_settings` table (or a dedicated `tenant_configuration` typed table) becomes
appropriate. The migration path is non-breaking: add the settings table, migrate the
column value into it, deprecate the column over a versioned window.

---

## PQ-2 — effective_to for current price: NULL or 'infinity'

**Default resolution**: **`effective_to timestamptz NULL`** — `NULL` represents the
open (current) interval.

**Why this is safe for v1**: `NULL` is the idiomatic PostgreSQL representation for
"no end date." A partial unique index `WHERE effective_to IS NULL` enforces the
at-most-one-open-interval invariant efficiently. Range queries for "what was the price
at time T?" use `WHERE effective_from <= T AND (effective_to IS NULL OR effective_to > T)`,
which is readable and correctly indexed. This is consistent with R-1.

**What would require revisiting**: If the price-history table is queried using
`tstzrange` operators (e.g., for overlap detection via `EXCLUDE USING gist`), switching
to `'infinity'` would simplify the range construction. Revisit at T490 if T403
concurrency tests reveal overlap failures under serializable isolation.

---

## PQ-3 — Tax category value space: free-string vs tenant-scoped enum table

**Default resolution**: **Free-form text with Zod soft validator
`^[a-z0-9_]{1,50}$`** in v1. No `tenant_tax_categories` table.

**Why this is safe for v1**: Tax category is a classification label only (Q11;
spec §5.3). The regex prevents garbage values while allowing the full vocabulary
of real-world tax treatment labels (`standard`, `zero`, `exempt`, `reduced_food`,
etc.) without a platform-level fixed enum. This is consistent with R-5.

**What would require revisiting**: When tenants need to manage their tax category
vocabulary explicitly (e.g., multi-jurisdiction tax rules, tax category display
names in the dashboard, or FK-enforced consistency between product and SaleLine
Snapshot fields), a `tenant_tax_categories` table becomes appropriate. The migration
is non-breaking: seed the table from the distinct existing `tax_category` values,
add the FK with a deferred constraint while validating existing data.

---

## PQ-4 — Resolved-view query strategy: CTE inline, lateral join, or view

**Default resolution**: **Inline CTE expressed as a TypeScript helper
`buildResolvedCatalogQuery(tenantId, storeId)`** in the Drizzle service layer.
No database view object created. This is consistent with R-4.

**Why this is safe for v1**: The resolved catalog view is consumed by a single
API consumer (`ResolvedCatalogView`). An inline CTE is reviewable in code diffs,
carries no DDL migration overhead when overrideable fields change (per Q8 evolution),
and is correct under the LEFT JOIN + COALESCE merge semantics. Dashboard read latency
at v1 catalog sizes (hundreds to low-thousands of products per tenant) does not
require materialization.

**What would require revisiting**: If dashboard read latency benchmarks (load-test
phase per Feature 004) show the resolved view query as a bottleneck under multi-store,
high-product-count tenants, a materialized view with an invalidation trigger on
`store_product_overrides` writes is the appropriate next step. This would be a
separate gated task (plan §8 / T490) and would not require changing the API
contract.

---

## PQ-5 — Soft-delete model: retired_at or status enum

**Default resolution**: **`retired_at timestamptz NULL`** on all catalog tables
that support retirement. `retired_at IS NULL` = active. This is consistent with R-3
and with Feature 001's soft-delete pattern.

**Why this is safe for v1**: All retirement flows in the v1 spec are two-state:
active or retired. `retired_at` captures the retirement timestamp as an auditable
fact without requiring a second audit query. Partial indexes on
`(tenant_id, ...) WHERE retired_at IS NULL` keep active-record reads efficient.
The pattern is already established by Feature 001 and is consistently readable
across the codebase.

**What would require revisiting**: If catalog products need a `draft` (unpublished)
state, a `suspended` state (temporarily unavailable, not retired), or multi-step
approval workflows, a `status` enum becomes appropriate. The migration is additive:
introduce a `status` column, populate existing rows as `active` where `retired_at IS NULL`
and `retired` otherwise, then deprecate the `retired_at` column in a later feature's
migration. Do not add the `status` column preemptively.

---

## PQ-6 — Future POS snapshot signing / integrity: HMAC vs signature vs none

**Default resolution**: **Deferred to the future POS sync feature.** No signing
or integrity mechanism is designed or reserved in the catalog foundation. This
decision does not bind the future POS sync feature.

**Why this is safe for v1**: The catalog foundation spec (§3 Non-Goals) explicitly
excludes POS sync, real POS endpoints, and SaleLine Snapshot implementation. No
POS snapshot is authored in this feature. Designing a signing scheme now would be
speculative — the snapshot format, transport, and trust model are all undefined
until the POS sync feature is specified.

**What would require revisiting**: When the POS sync feature is specified (the
feature that implements Q12's snapshot + delta model), the snapshot integrity
question must be answered as part of that feature's spec and plan. At that point
the relevant tradeoffs are: HMAC (symmetric, simple, requires shared secret
management), detached signature (asymmetric, auditable by POS without a shared
secret, higher implementation complexity), and none (rely on transport-layer TLS +
audit log for integrity). The decision depends on the threat model and operational
security requirements of the POS deployment environment.
