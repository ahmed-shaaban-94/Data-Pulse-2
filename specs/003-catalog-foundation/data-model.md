# Data Model Design: Catalog Foundation

**Feature ID**: 003
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Research**: [research.md](./research.md)
**Tasks**: [tasks.md](./tasks.md) — task T310
**Constitution**: v3.0.0
**Status**: Design only — no SQL, no Drizzle schema, no migrations
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban

> This document is **design-only**. It defines the physical data model for the
> seven catalog entities. No application code, NestJS modules, Drizzle schema
> files, SQL migrations, or OpenAPI YAML are authored here. Implementation lands
> in a subsequent gated feature after this design is reviewed.
>
> All Q1–Q11 bindings from `spec.md §16` are applied. All R-1..R-5 and
> PQ-1..PQ-6 decisions from `research.md` are applied. References to Q#, R-#,
> and PQ-# are to those documents.

---

## Contents

1. [Overview and Conventions](#1-overview-and-conventions)
2. [Entity: global_products](#2-entity-global_products)
3. [Entity: tenant_products](#3-entity-tenant_products)
4. [Entity: tenant_product_categories](#4-entity-tenant_product_categories)
5. [Entity: store_product_overrides](#5-entity-store_product_overrides)
6. [Entity: product_aliases](#6-entity-product_aliases)
7. [Entity: price_history](#7-entity-price_history)
8. [Entity: unknown_items](#8-entity-unknown_items)
9. [Cross-entity Constraints and Relationships](#9-cross-entity-constraints-and-relationships)
10. [RLS Policy Summary](#10-rls-policy-summary)
11. [Variants Forward-Compatibility Note](#11-variants-forward-compatibility-note)
12. [SaleLine Snapshot Obligation](#12-saleline-snapshot-obligation)
13. [tenants Table Amendment](#13-tenants-table-amendment)

---

## 1. Overview and Conventions

### Source-of-truth authority

| Entity | Layer | Authority |
|---|---|---|
| `global_products` | Global Product Index | Reference only — never authoritative for any tenant |
| `tenant_products` | Tenant Catalog | Authoritative for tenant-owned products |
| `tenant_product_categories` | Tenant Catalog | Authoritative for tenant's category taxonomy |
| `store_product_overrides` | Store Override | Authoritative for branch-level field deviations |
| `product_aliases` | Tenant Catalog | Authoritative alias registry for a tenant |
| `price_history` | Tenant Catalog / Store Override | Immutable audit trail of price changes |
| `unknown_items` | Workflow | Capture-only; not a product record |

### Notation

- **PK**: primary key column(s).
- **FK**: foreign key reference.
- **UQ**: unique constraint or unique index.
- **CHK**: check constraint.
- **IDX**: non-unique index for query support.
- **RLS**: row-level security policy description.
- `[Q#]`: binding from spec open questions (spec §16).
- `[R-#]`: binding from research decisions (research.md).
- `[PQ-#]`: binding from plan-level defaults (research.md PQ section).

### Universal type conventions

| Concern | Type | Binding |
|---|---|---|
| Primary key | `uuid NOT NULL DEFAULT gen_random_uuid()` | UUIDv7 preferred; UUIDv4 fallback |
| Monetary amount | `numeric(19,4) NOT NULL` | Q1 — no floating-point money |
| Currency code | `char(3) NOT NULL` | Q2 — every row that stores a monetary value carries an explicit currency. Store overrides use `char(3) NULL` where `NULL` means no price override exists (not a missing currency on an actual amount). |
| Timestamps | `timestamptz NOT NULL DEFAULT now()` | UTC storage; Constitution §10 |
| Soft-delete | `retired_at timestamptz NULL` | R-3 / PQ-5 — `NULL` = active |
| Tenant scope | `tenant_id uuid NOT NULL` | Constitution §2 — all tenant-owned rows |
| Store scope | `store_id uuid NOT NULL` | Constitution §2 — all store-scoped rows |
| Tax category | `text NOT NULL` on `tenant_products`; `text NULL` on `store_product_overrides` | Q11 / R-5 — `tenant_products.tax_category` is always required. `store_product_overrides.tax_category` is `NULL` when no override exists (inherit tenant value). |
| Correlation ID | `correlation_id uuid NULL` | Constitution §13 — linked to audit event |

### Soft-delete semantics (R-3 / PQ-5)

`retired_at IS NULL` = active record.
`retired_at IS NOT NULL` = retired; timestamp records when retirement occurred.
Application code filters active records with `WHERE retired_at IS NULL`. Partial
indexes on `(tenant_id, ...) WHERE retired_at IS NULL` support this filter
efficiently.

### RLS context variables (from Feature 001)

All RLS policies for tenant-scoped tables use the GUC variables established by
Feature 001:

- `app.current_tenant` (`uuid`) — set by the API's tenant-context middleware.
- `app.current_store` (`uuid`) — set by the API's store-context middleware.

The runtime DB role must not have the `BYPASSRLS` attribute (Constitution §2).

---

## 2. Entity: `global_products`

### Purpose and source-of-truth role

The Global Product Index. Contains platform-curated product suggestions that
tenants **may** adopt into their Tenant Catalog. This table is **reference
only** — it is never the authoritative record for any tenant's product. A
Platform Admin is the sole writer. Tenant users have read-only access to active
records for the purpose of browsing suggestions.

Adoption is **copy-on-adopt snapshot** (Q5 / spec §5.1): when a tenant adopts a
global product, a new `tenant_products` record is created and the global record
is not referenced by FK from any tenant table in a way that would let a
platform-side edit propagate into tenant data.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. UUIDv7 preferred. |
| `name` | `text` | NOT NULL | — | Canonical product name. Max 500 chars enforced by CHK. |
| `description` | `text` | NULL | `NULL` | Optional product description. |
| `suggested_category` | `text` | NULL | `NULL` | Advisory category label. Not a FK; tenants map to their own categories. |
| `suggested_tax_category` | `text` | NULL | `NULL` | Advisory tax category; Zod-validated `^[a-z0-9_]{1,50}$` at write time. [Q11 / R-5] |
| `default_price` | `numeric(19,4)` | NULL | `NULL` | Suggested default price. NULL = no price suggestion. [Q1] |
| `default_currency_code` | `char(3)` | NULL | `NULL` | ISO 4217 currency for `default_price`. NULL only when `default_price` is NULL. [Q2] |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete timestamp. NULL = active. [R-3 / PQ-5] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | Row creation time (UTC). |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Last update time; updated by application on every write. |
| `created_by` | `uuid` | NOT NULL | — | Actor (Platform Admin user ID). Never body-supplied; always resolved from authenticated principal. [Constitution §12 / §13] |

### Constraints

**PK**
- `(id)`

**Check constraints**
- `CHK global_products_name_length`: `length(name) BETWEEN 1 AND 500`
- `CHK global_products_currency_paired`: `(default_price IS NULL AND default_currency_code IS NULL) OR (default_price IS NOT NULL AND default_currency_code IS NOT NULL)` — price and currency are always paired. [Q2]
- `CHK global_products_suggested_tax_category_format`: `suggested_tax_category IS NULL OR (length(suggested_tax_category) BETWEEN 1 AND 50)` — length guard; regex enforced at Zod layer. [Q11 / R-5]

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `idx_global_products_active` | `(id)` | `WHERE retired_at IS NULL` | Fast lookup of active suggestions. |
| `idx_global_products_suggested_category` | `(suggested_category)` | `WHERE retired_at IS NULL` | Browse suggestions by category. |

### RLS policies

Global products are platform-scoped, not tenant-scoped. RLS on this table
enforces the Platform Admin write restriction and read-only access for all
authenticated tenant users.

| Policy | Command | Using | Check |
|---|---|---|---|
| `global_products_read` | `SELECT` | `TRUE` (any authenticated session) | — |
| `global_products_platform_write` | `INSERT, UPDATE, DELETE` | `current_setting('app.current_role') = 'platform_admin'` | `current_setting('app.current_role') = 'platform_admin'` |

> Implementation note: `app.current_role` is an additional GUC set by the API
> middleware for platform-admin operations. Tenant sessions will not have this
> GUC set to `'platform_admin'` and will be denied writes by default-deny.

### Audit / provenance notes

Auditable events (Constitution §13): create, update, retire of global product.
Every event carries `created_by` (Platform Admin actor ID) and a `correlation_id`
passed from the request context. Corrections to global products are new events,
not edits to existing audit records.

---

## 3. Entity: `tenant_products`

### Purpose and source-of-truth role

The Tenant Catalog. Authoritative record for a tenant's owned products. Every
tenant-facing product lives here. A record may have been adopted from the Global
Product Index (provenance preserved via `source_global_product_id`) or created
directly by a Tenant Admin.

The canonical fields (name, default price, default tax category, default
availability, category, default aliases) that define a tenant's product are
owned by this table. Store Overrides reference this table but do not modify it.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. UUIDv7 preferred. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. Never body-supplied. [Constitution §2 / §12] |
| `name` | `text` | NOT NULL | — | Tenant's product name. Max 500 chars. |
| `description` | `text` | NULL | `NULL` | Optional product description. |
| `category_id` | `uuid` | NULL | `NULL` | **FK → tenant_product_categories.id**. NULL = uncategorized. [Q7] |
| `default_price` | `numeric(19,4)` | NULL | `NULL` | Default unit price. NULL = price-on-request / POS manual entry. [Q1] |
| `default_currency_code` | `char(3)` | NULL | `NULL` | ISO 4217 currency. NULL only when `default_price` is NULL. [Q2] |
| `is_active` | `boolean` | NOT NULL | `TRUE` | Availability flag at the tenant level. [Q8] |
| `tax_category` | `text` | NOT NULL | — | Opaque tax classification label. `^[a-z0-9_]{1,50}$` validated at Zod layer. [Q11 / R-5] |
| `source_global_product_id` | `uuid` | NULL | `NULL` | Soft provenance reference to `global_products.id`. **No FK constraint**. NULL = created directly. [Q5] |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete. NULL = active. [R-3 / PQ-5] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Updated on every write. |
| `created_by` | `uuid` | NOT NULL | — | Actor user ID. Never body-supplied. [Constitution §12 / §13] |
| `updated_by` | `uuid` | NOT NULL | — | Last editor user ID. Never body-supplied. |
| `correlation_id` | `uuid` | NULL | `NULL` | Linked to the audit event that created or last modified this row. [Constitution §13] |

### Why `source_global_product_id` has no FK (Q5)

`source_global_product_id` is a provenance reference only. It records "this
product was adopted from global product X" so adoption is auditable. No FK is
declared because a FK (even without `ON DELETE CASCADE`) would create a hard
dependency between platform-side global product lifecycle and tenant data. A
Platform Admin retiring or deleting a global product must not cascade into or
constrain tenant records. This is the **copy-on-adopt snapshot** guarantee from
Q5 and spec §5.1.

The value may reference a `global_products.id` that no longer exists (if the
global product is later hard-deleted by platform ops). The application treats
this gracefully: the provenance reference is informational, not load-bearing.

### Constraints

**PK**
- `(id)`

**Foreign keys**
- `FK tenant_products_tenant_id → tenants(id)` — no `ON DELETE CASCADE`; use soft-delete.
- `FK tenant_products_category_id → tenant_product_categories(id)` — `ON DELETE SET NULL` (retiring a category does not retire its products).

**Check constraints**
- `CHK tenant_products_name_length`: `length(name) BETWEEN 1 AND 500`
- `CHK tenant_products_currency_paired`: `(default_price IS NULL AND default_currency_code IS NULL) OR (default_price IS NOT NULL AND default_currency_code IS NOT NULL)` [Q2]
- `CHK tenant_products_tax_category_length`: `length(tax_category) BETWEEN 1 AND 50` [Q11 / R-5]

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `idx_tenant_products_tenant_active` | `(tenant_id, id)` | `WHERE retired_at IS NULL` | Primary active-product list per tenant. |
| `idx_tenant_products_tenant_category` | `(tenant_id, category_id)` | `WHERE retired_at IS NULL` | Browse by category. |
| `idx_tenant_products_source_global` | `(source_global_product_id)` | `WHERE source_global_product_id IS NOT NULL` | Provenance audit — which tenants adopted a global product. |

### RLS policies

| Policy | Command | Using | Check |
|---|---|---|---|
| `tenant_products_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `tenant_products_tenant_write` | `INSERT, UPDATE, DELETE` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |

Cross-tenant access returns a safe non-disclosing response (Constitution §2).
A cross-tenant read must return the same response as a 404 — not a permission
error that would reveal whether the product exists.

### Audit / provenance notes

Auditable events: create, update, retire. Price changes produce a `price_history`
record (§7) in addition to updating `default_price` here. Adoption from global
catalog is its own auditable event. `correlation_id` links the row change to the
audit log entry.

---

## 4. Entity: `tenant_product_categories`

### Purpose and source-of-truth role

Flat (non-hierarchical) category taxonomy owned by a tenant (Q7 resolved).
Categories are a tenant-owned organizational concept for their Tenant Catalog.
There is **no `parent_id` column** — tree categories are deferred from v1 (Q7).
A tenant admin creates and manages their category list. Products reference
categories via `tenant_products.category_id`.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. Never body-supplied. [Constitution §2 / §12] |
| `name` | `text` | NOT NULL | — | Category display name. Max 200 chars. |
| `description` | `text` | NULL | `NULL` | Optional description. |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete. NULL = active. [R-3 / PQ-5] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Updated on every write. |
| `created_by` | `uuid` | NOT NULL | — | Actor user ID. Never body-supplied. [Constitution §12 / §13] |

### Why there is no `parent_id` (Q7)

Q7 (spec §16.Q7) resolved to flat categories in v1. A hierarchical tree (with
`parent_id uuid NULL REFERENCES tenant_product_categories(id)`) is deferred. A
`parent_id` column must not be added until the tree-categories feature is
specified and gated. Its absence is intentional — not an oversight.

### Constraints

**PK**
- `(id)`

**Unique constraint**
- `UQ tenant_product_categories_tenant_name`: `(tenant_id, name) WHERE retired_at IS NULL` — category names are unique within a tenant's active categories.

**Foreign keys**
- `FK tenant_product_categories_tenant_id → tenants(id)`

**Check constraint**
- `CHK tenant_product_categories_name_length`: `length(name) BETWEEN 1 AND 200`

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `idx_tenant_product_categories_tenant_active` | `(tenant_id)` | `WHERE retired_at IS NULL` | List active categories per tenant. |
| `UQ_idx_tenant_product_categories_tenant_name` | `(tenant_id, name)` | `WHERE retired_at IS NULL` | Enforces unique active names (see UQ above). |

### RLS policies

| Policy | Command | Using | Check |
|---|---|---|---|
| `tenant_product_categories_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `tenant_product_categories_tenant_write` | `INSERT, UPDATE, DELETE` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |

### Audit / provenance notes

Auditable events: create, update, retire of a category. When a category is
retired, products referencing it via `category_id` are unaffected (FK is
`ON DELETE SET NULL`); they become uncategorized.

---

## 5. Entity: `store_product_overrides`

### Purpose and source-of-truth role

Store Override layer. Authoritative for branch-level deviations from the Tenant
Catalog. Every record is scoped to both `tenant_id` and `store_id`. A Store
Override cannot exist without a corresponding `tenant_products` record.

**Overrideable fields in v1 (Q8 resolved / spec §5.3)**:

- `price` and `currency_code` — store-level price
- `is_active` — store-level availability
- `tax_category` — store-level tax treatment

Product name and category are **not** overrideable at store level in v1.
Product identity remains tenant-level truth. Only the four fields above may
be present in this table.

The resolved store catalog is: `Tenant Catalog ⊕ Store Override(store)` where
`⊕` applies store overrides field-by-field (R-4 / PQ-4, via
`buildResolvedCatalogQuery`).

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. Never body-supplied. [Constitution §2 / §12] |
| `store_id` | `uuid` | NOT NULL | — | **FK → stores.id**. Never body-supplied. [Constitution §2 / §12] |
| `product_id` | `uuid` | NOT NULL | — | **FK → tenant_products.id**. The product being overridden. |
| `price` | `numeric(19,4)` | NULL | `NULL` | Store-level price override. NULL = inherit tenant default. [Q1] |
| `currency_code` | `char(3)` | NULL | `NULL` | ISO 4217 currency. NULL only when `price` is NULL. [Q2] |
| `is_active` | `boolean` | NULL | `NULL` | Store availability override. NULL = inherit tenant default. [Q8] |
| `tax_category` | `text` | NULL | `NULL` | Store-level tax category override. NULL = inherit tenant default. `^[a-z0-9_]{1,50}$` at Zod layer. [Q8 / Q11 / R-5] |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete of this override (removes the override; does not retire the product). [R-3 / PQ-5] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Updated on every write. |
| `created_by` | `uuid` | NOT NULL | — | Actor user ID. Never body-supplied. [Constitution §12 / §13] |
| `updated_by` | `uuid` | NOT NULL | — | Last editor user ID. |
| `correlation_id` | `uuid` | NULL | `NULL` | Linked to audit event. [Constitution §13] |

### Constraints

**PK**
- `(id)`

**Unique constraint**
- `UQ store_product_overrides_product_store`: `(tenant_id, store_id, product_id) WHERE retired_at IS NULL` — at most one active override per product per store.

**Foreign keys**
- `FK store_product_overrides_tenant_id → tenants(id)`
- `FK store_product_overrides_store_id → stores(id)`
- `FK store_product_overrides_product_id → tenant_products(id)` — a Store Override requires a Tenant Catalog product to exist.

**Check constraints**
- `CHK store_product_overrides_currency_paired`: `(price IS NULL AND currency_code IS NULL) OR (price IS NOT NULL AND currency_code IS NOT NULL)` [Q2]
- `CHK store_product_overrides_tax_category_length`: `tax_category IS NULL OR (length(tax_category) BETWEEN 1 AND 50)` [Q11 / R-5]
- `CHK store_product_overrides_at_least_one_override`: `NOT (price IS NULL AND is_active IS NULL AND tax_category IS NULL)` — an override row with no overridden fields is meaningless.

### Nullable override field semantics and Q2 preservation

Store override fields are nullable to represent "no override for this field" (inherit the tenant catalog value). This applies to `price`, `currency_code`, `is_active`, and `tax_category`.

**Price and currency pairing** — four and only four states are valid:

| `price` | `currency_code` | Meaning |
|---|---|---|
| `NULL` | `NULL` | No store price override. Resolved catalog inherits `tenant_products.default_price`. |
| `NOT NULL` | `NOT NULL` | Store price override active. This store charges this price in this currency. |
| `NOT NULL` | `NULL` | **Invalid.** A monetary amount without a currency is forbidden (Constitution §3). Rejected by `CHK store_product_overrides_currency_paired`. |
| `NULL` | `NOT NULL` | **Invalid.** A currency code with no amount is meaningless. Rejected by `CHK store_product_overrides_currency_paired`. |

**Q2 is preserved** even though `currency_code` is nullable here: Q2 requires that every row *storing a monetary amount* carries an explicit `currency_code`. When `price IS NULL` no monetary amount is stored, so `currency_code IS NULL` is correct and not a Q2 violation. When `price IS NOT NULL` the check constraint enforces `currency_code IS NOT NULL`, which satisfies Q2. `price_history` rows (which record actual price values) always have `currency_code NOT NULL` — there is no exception there.

**Tax category inheritance** — `tax_category NULL` means this store does not override the product's tax treatment; the resolved catalog returns `tenant_products.tax_category`. A non-null `tax_category` value in this table overrides the tenant default for this store. `tenant_products.tax_category` remains `text NOT NULL` and is the fallback; `store_product_overrides.tax_category` is `text NULL` only in the sense that no override has been set.

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `idx_store_product_overrides_store_active` | `(tenant_id, store_id)` | `WHERE retired_at IS NULL` | Load all active overrides for a store (resolved catalog query). |
| `idx_store_product_overrides_product` | `(tenant_id, product_id)` | `WHERE retired_at IS NULL` | Look up override for a specific product. |
| `UQ_idx_store_product_overrides_product_store` | `(tenant_id, store_id, product_id)` | `WHERE retired_at IS NULL` | Enforces UQ above. |

### RLS policies

Store overrides require both tenant isolation and store isolation.

| Policy | Command | Using | Check |
|---|---|---|---|
| `store_product_overrides_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `store_product_overrides_store_read` | `SELECT` | `store_id = current_setting('app.current_store')::uuid OR current_setting('app.current_store') = ''` | — |
| `store_product_overrides_tenant_write` | `INSERT, UPDATE, DELETE` | `tenant_id = current_setting('app.current_tenant')::uuid AND store_id = current_setting('app.current_store')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid AND store_id = current_setting('app.current_store')::uuid` |

> `app.current_store = ''` in the `SELECT` policy allows Tenant Owner / Tenant
> Admin (who may have cross-store read access) to read overrides for all their
> stores. The write policy always scopes to the current store.

Cross-store write outside the principal's store-access set is rejected with the
same safe non-disclosing response as cross-tenant access (Constitution §2, §12).

### Audit / provenance notes

Auditable events: create, update, retire of a store override. Price overrides
produce a `price_history` record (§7) scoped to `(tenant_id, product_id,
store_id)` in addition to updating `price` here.

---

## 6. Entity: `product_aliases`

### Purpose and source-of-truth role

Alias registry for barcodes, SKUs, PLUs, supplier codes, and external POS IDs
attached to `tenant_products` records. Aliases are the mechanism by which
external systems and humans identify a product.

Every alias carries an `identifier_type` (e.g. `barcode`, `sku`, `plu`,
`supplier_code`, `external_pos_id`) and a `value`. Uniqueness rules are
**identifier-type-specific** (Q4 / spec §6.1).

`external_pos_id` aliases carry an additional `source_system` field per
Constitution §11's `sourceSystem + externalId` idempotency pattern.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. Never body-supplied. [Constitution §2 / §12] |
| `product_id` | `uuid` | NOT NULL | — | **FK → tenant_products.id**. The product this alias identifies. |
| `identifier_type` | `text` | NOT NULL | — | Type of identifier. Constrained by CHK below. |
| `value` | `text` | NOT NULL | — | The alias value (e.g., barcode number, SKU string). Max 200 chars. |
| `source_system` | `text` | NULL | `NULL` | Required when `identifier_type = 'external_pos_id'`. NULL for all other types. [Constitution §11 / Q4] |
| `store_id` | `uuid` | NULL | `NULL` | **FK → stores.id**. NULL = tenant-wide alias. Set only when alias is explicitly store-scoped. [Q4] |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-deactivation. NULL = active. [R-3 / PQ-5] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `created_by` | `uuid` | NOT NULL | — | Actor user ID. Never body-supplied. [Constitution §12 / §13] |
| `correlation_id` | `uuid` | NULL | `NULL` | Linked to audit event for this alias write. [Constitution §13] |

### Alias uniqueness — three partial unique indexes (Q4)

Uniqueness rules from spec §6.1 are expressed as three separate partial unique
indexes. Each index enforces one identifier-type scope.

**Index 1 — Tenant-wide identifiers** (`barcode`, `sku`, and all non-`external_pos_id` types not explicitly store-scoped):

```
UQ_idx_product_aliases_tenant_wide
  ON product_aliases (tenant_id, identifier_type, value)
  WHERE store_id IS NULL
    AND identifier_type <> 'external_pos_id'
    AND retired_at IS NULL
```

Ensures one product per `(tenant_id, identifier_type, value)` for tenant-wide
aliases. Prevents two products in the same tenant from sharing a barcode.

**Index 2 — External POS identifiers** (`external_pos_id`):

```
UQ_idx_product_aliases_external_pos_id
  ON product_aliases (tenant_id, source_system, value)
  WHERE identifier_type = 'external_pos_id'
    AND retired_at IS NULL
```

Ensures one product per `(tenant_id, source_system, value)` for external POS
ids per Constitution §11. `source_system` is mandatory for this type.

**Index 3 — Store-scoped aliases** (any type when `store_id IS NOT NULL`):

```
UQ_idx_product_aliases_store_scoped
  ON product_aliases (tenant_id, store_id, identifier_type, value)
  WHERE store_id IS NOT NULL
    AND retired_at IS NULL
```

Ensures one product per `(tenant_id, store_id, identifier_type, value)` for
store-scoped aliases. Store-scoped aliases are only created when explicitly
flagged; aliases default to tenant-wide.

### Constraints

**PK**
- `(id)`

**Foreign keys**
- `FK product_aliases_tenant_id → tenants(id)`
- `FK product_aliases_product_id → tenant_products(id)`
- `FK product_aliases_store_id → stores(id)` (nullable FK)

**Check constraints**
- `CHK product_aliases_identifier_type_valid`: `identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')` — known types; extended by migration when new types are added.
- `CHK product_aliases_value_length`: `length(value) BETWEEN 1 AND 200`
- `CHK product_aliases_source_system_required`: `(identifier_type = 'external_pos_id' AND source_system IS NOT NULL) OR (identifier_type <> 'external_pos_id' AND source_system IS NULL)` — `source_system` required for `external_pos_id`, forbidden for others.
- `CHK product_aliases_store_scope_consistency`: `store_id IS NULL OR identifier_type <> 'external_pos_id'` — external POS IDs are always tenant-wide (source_system scopes them); they cannot be store-scoped.

### Indexes

| Name | Type | Columns / Condition | Purpose |
|---|---|---|---|
| `UQ_idx_product_aliases_tenant_wide` | Partial UQ | `(tenant_id, identifier_type, value) WHERE store_id IS NULL AND identifier_type <> 'external_pos_id' AND retired_at IS NULL` | [Q4] Enforce tenant-wide uniqueness |
| `UQ_idx_product_aliases_external_pos_id` | Partial UQ | `(tenant_id, source_system, value) WHERE identifier_type = 'external_pos_id' AND retired_at IS NULL` | [Q4 / Constitution §11] Enforce POS id uniqueness |
| `UQ_idx_product_aliases_store_scoped` | Partial UQ | `(tenant_id, store_id, identifier_type, value) WHERE store_id IS NOT NULL AND retired_at IS NULL` | [Q4] Enforce store-scoped uniqueness |
| `idx_product_aliases_lookup` | IDX | `(tenant_id, identifier_type, value) WHERE retired_at IS NULL` | Fast alias-resolution scan (includes all types). |
| `idx_product_aliases_product` | IDX | `(tenant_id, product_id) WHERE retired_at IS NULL` | List active aliases for a product. |

### RLS policies

| Policy | Command | Using | Check |
|---|---|---|---|
| `product_aliases_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `product_aliases_tenant_write` | `INSERT, UPDATE, DELETE` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |

### Audit / provenance notes

Auditable events: alias create, retire. Duplicate-alias conflict on write is a
separate observability signal (spec §9) — an alias write that would violate a
partial unique index emits a `duplicate_alias_conflict` metric event before
returning an error. The `correlation_id` links the alias create/retire event to
the audit log.

---

## 7. Entity: `price_history`

### Purpose and source-of-truth role

Immutable audit trail of price changes to tenant products and store overrides.
Every price change (to `tenant_products.default_price` or to
`store_product_overrides.price`) writes a new row here. Rows are **never
edited or deleted** (Constitution §13 / spec §6.2). Corrections appear as
new rows.

Effective intervals track what the price was at any point in time (Q9 / R-1 /
PQ-2). Two price contexts exist: tenant-level (product price) and store-level
(override price), distinguished by the presence of `store_id`.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. [Constitution §2 / §12] |
| `product_id` | `uuid` | NOT NULL | — | **FK → tenant_products.id**. |
| `store_id` | `uuid` | NULL | `NULL` | **FK → stores.id**. NULL = tenant-level price history. Set = store-override price history. |
| `price` | `numeric(19,4)` | NOT NULL | — | The price value for this interval. [Q1] |
| `currency_code` | `char(3)` | NOT NULL | — | ISO 4217 currency. Always present. [Q2] |
| `effective_from` | `timestamptz` | NOT NULL | — | Interval start (UTC). When this price became active. [Q9 / R-1 / PQ-2] |
| `effective_to` | `timestamptz` | NULL | `NULL` | Interval end (UTC). NULL = this is the current active price. [Q9 / R-1 / PQ-2] |
| `changed_by` | `uuid` | NOT NULL | — | Actor user ID who caused this price change. Never body-supplied. [Constitution §12 / §13] |
| `correlation_id` | `uuid` | NOT NULL | — | Correlation ID from the request that triggered this change. [Constitution §13] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. Row insert time (= `effective_from` in most cases). |

### No `retired_at` column

`price_history` rows are immutable. There is **no `retired_at` column**. Rows
are never soft-deleted. The effective interval (`effective_from` / `effective_to`)
governs whether a price record is current or historical. This is consistent with
R-3 which exempts `price_history` from the soft-delete pattern precisely because
it is an append-only ledger.

### Effective interval semantics (Q9 / R-1 / PQ-2)

- `effective_to IS NULL` → this price is currently active.
- `effective_to IS NOT NULL` → this price was active from `effective_from` until
  `effective_to`.
- A price write path:
  1. Reads the current open interval (`WHERE effective_to IS NULL`).
  2. Closes it: `UPDATE price_history SET effective_to = now() WHERE id = <current>`.
  3. Inserts new row with `effective_from = now()` and `effective_to = NULL`.
  4. Steps 2 and 3 execute in a single serialized service call under
     read-committed isolation.
- Point-in-time lookup: `WHERE effective_from <= $t AND (effective_to IS NULL OR effective_to > $t)`.

### Constraints

**PK**
- `(id)`

**Partial unique indexes — open interval enforcement (Q9 / R-1)**

```
UQ_idx_price_history_tenant_open
  ON price_history (tenant_id, product_id)
  WHERE store_id IS NULL AND effective_to IS NULL
```
At most one open interval per product at the tenant level.

```
UQ_idx_price_history_store_open
  ON price_history (tenant_id, product_id, store_id)
  WHERE store_id IS NOT NULL AND effective_to IS NULL
```
At most one open interval per product at the store-override level.

**Foreign keys**
- `FK price_history_tenant_id → tenants(id)`
- `FK price_history_product_id → tenant_products(id)`
- `FK price_history_store_id → stores(id)` (nullable FK)

**Check constraints**
- `CHK price_history_interval_order`: `effective_to IS NULL OR effective_to > effective_from` — closed intervals must end after they start.
- `CHK price_history_price_positive`: `price >= 0` — prices are non-negative (zero is valid for free/promotional items).

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `UQ_idx_price_history_tenant_open` | `(tenant_id, product_id)` | `WHERE store_id IS NULL AND effective_to IS NULL` | [Q9 / R-1] One open tenant-level interval |
| `UQ_idx_price_history_store_open` | `(tenant_id, product_id, store_id)` | `WHERE store_id IS NOT NULL AND effective_to IS NULL` | [Q9 / R-1] One open store-level interval |
| `idx_price_history_product_timeline` | `(tenant_id, product_id, effective_from DESC)` | — | Historical price timeline for a product |
| `idx_price_history_store_timeline` | `(tenant_id, product_id, store_id, effective_from DESC)` | `WHERE store_id IS NOT NULL` | Historical price timeline for a store override |

### RLS policies

| Policy | Command | Using | Check |
|---|---|---|---|
| `price_history_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `price_history_tenant_insert` | `INSERT` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |
| `price_history_no_update_delete` | `UPDATE, DELETE` | `FALSE` | `FALSE` |

The `UPDATE` and `DELETE` policies are `FALSE` — no session may update or delete
price history rows. Enforcement at the RLS layer makes this invariant
database-level, not just application-level (Constitution §13).

### Audit / provenance notes

`price_history` is itself the audit trail for price changes. Each row is
immutable and carries `changed_by`, `correlation_id`, and the full before/after
pricing context via effective intervals. No separate audit event is needed for
price history rows; the rows are the events. Price changes to tenant products
and store overrides must reference the resulting `price_history.id` in their
own audit log entries for cross-reference.

---

## 8. Entity: `unknown_items`

### Purpose and source-of-truth role

Capture table for identifiers presented by a POS scan or import flow that do
not resolve to any product in the resolved store catalog (spec §6.3). This
table is a **workflow staging record** — not a product record. An unknown item
represents an unresolved lookup event that requires manual review.

**No auto-create path exists** (Q10 / spec §6.3): the system must not
silently create a `tenant_products` record from an unknown item. Resolution
requires a human actor. Possible resolution outcomes:
- Link to an existing product (creates a `product_aliases` record).
- Create a new `tenant_products` record (separate write, not auto-triggered).
- Dismiss as invalid.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id**. [Constitution §2 / §12] |
| `store_id` | `uuid` | NOT NULL | — | **FK → stores.id**. The store where the unknown item was encountered. |
| `identifier_type` | `text` | NOT NULL | — | Type of identifier that did not resolve. CHK below. |
| `value` | `text` | NOT NULL | — | The unresolved identifier value. Max 200 chars. |
| `source_system` | `text` | NULL | `NULL` | Present when `identifier_type = 'external_pos_id'`. [Constitution §11] |
| `encountered_at` | `timestamptz` | NOT NULL | `now()` | When the POS/import event occurred (UTC). [Constitution §10 — `occurredAt` semantics] |
| `sale_context` | `jsonb` | NULL | `NULL` | Opaque sale-line context snapshot from the POS event (future sale reference). Never logged. [Constitution §14] |
| `resolution_status` | `text` | NOT NULL | `'pending'` | Workflow state. CHK constrains values. |
| `resolved_at` | `timestamptz` | NULL | `NULL` | When resolution occurred. NULL = pending. |
| `resolved_by` | `uuid` | NULL | `NULL` | Actor user ID who resolved this item. NULL = not yet resolved. [Q10] |
| `resolution_action` | `text` | NULL | `NULL` | One of `'linked'`, `'created'`, `'dismissed'`. NULL until resolved. |
| `resolved_product_id` | `uuid` | NULL | `NULL` | FK → `tenant_products.id`. Set when `resolution_action = 'linked'` or `'created'`. |
| `correlation_id` | `uuid` | NOT NULL | — | Correlation ID from the original lookup request. [Constitution §13] |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. Row creation time. |

### Why `resolved_by` requires an actor (Q10)

Q10 (spec §6.3) resolved to **manual approval only in v1**. There is
deliberately **no auto-resolve path**. The `resolved_by uuid NULL` column
makes this explicit in the schema: a resolved unknown item must have a non-null
`resolved_by` referencing the human actor who approved the resolution. Any
code path that sets `resolved_at` without setting `resolved_by` is a bug.

This design prevents silent catalog contamination from POS scan errors or
supplier data issues.

### Constraints

**PK**
- `(id)`

**Foreign keys**
- `FK unknown_items_tenant_id → tenants(id)`
- `FK unknown_items_store_id → stores(id)`
- `FK unknown_items_resolved_product_id → tenant_products(id)` (nullable FK)

**Check constraints**
- `CHK unknown_items_identifier_type_valid`: `identifier_type IN ('barcode', 'sku', 'plu', 'supplier_code', 'external_pos_id')`
- `CHK unknown_items_value_length`: `length(value) BETWEEN 1 AND 200`
- `CHK unknown_items_resolution_status_valid`: `resolution_status IN ('pending', 'resolved', 'dismissed')`
- `CHK unknown_items_resolution_action_valid`: `resolution_action IS NULL OR resolution_action IN ('linked', 'created', 'dismissed')`
- `CHK unknown_items_resolved_fields_consistent`: `(resolution_status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_action IS NULL) OR (resolution_status <> 'pending' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_action IS NOT NULL)` — resolution fields must be fully set or fully null together. [Q10]
- `CHK unknown_items_linked_product_present`: `(resolution_action IN ('linked', 'created') AND resolved_product_id IS NOT NULL) OR (resolution_action = 'dismissed' AND resolved_product_id IS NULL) OR resolution_action IS NULL`
- `CHK unknown_items_source_system_required`: `(identifier_type = 'external_pos_id' AND source_system IS NOT NULL) OR (identifier_type <> 'external_pos_id' AND source_system IS NULL)` [Constitution §11]

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `idx_unknown_items_pending` | `(tenant_id, store_id)` | `WHERE resolution_status = 'pending'` | Review queue for Tenant Admin / Store Manager. |
| `idx_unknown_items_lookup_value` | `(tenant_id, identifier_type, value)` | `WHERE resolution_status = 'pending'` | Detect duplicate pending unknown items for the same identifier. |
| `idx_unknown_items_encountered_at` | `(tenant_id, encountered_at DESC)` | — | Time-ordered view of unknown item events per tenant. |

### RLS policies

| Policy | Command | Using | Check |
|---|---|---|---|
| `unknown_items_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant')::uuid` | — |
| `unknown_items_store_read` | `SELECT` | `store_id = current_setting('app.current_store')::uuid OR current_setting('app.current_store') = ''` | — |
| `unknown_items_insert` | `INSERT` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |
| `unknown_items_resolve` | `UPDATE` | `tenant_id = current_setting('app.current_tenant')::uuid` | `tenant_id = current_setting('app.current_tenant')::uuid` |

`sale_context` (jsonb) must be **redacted at all logger boundaries** per
Constitution §14. It may contain POS-supplied sale identifiers that constitute
business-confidential data. It must never appear in INFO, WARN, or ERROR logs.

### Audit / provenance notes

Auditable events: unknown item recorded, unknown item resolved (linked /
created / dismissed). Resolution is a separate, auditable event carrying
`resolved_by`, `resolution_action`, `resolved_product_id` (where applicable),
and `correlation_id`.

---

## 9. Cross-entity Constraints and Relationships

### Entity relationship summary

```
tenants
  ├── tenant_product_categories (tenant_id FK)
  ├── tenant_products (tenant_id FK)
  │     ├── source_global_product_id → global_products (soft ref, no FK)
  │     ├── category_id → tenant_product_categories (nullable FK)
  │     ├── store_product_overrides (product_id FK)
  │     ├── product_aliases (product_id FK)
  │     └── price_history (product_id FK)
  └── unknown_items (tenant_id FK)

stores
  ├── store_product_overrides (store_id FK)
  ├── product_aliases (store_id nullable FK)
  ├── price_history (store_id nullable FK)
  └── unknown_items (store_id FK)
```

### Cascade and delete rules summary

| FK | On Delete | Reason |
|---|---|---|
| `tenant_products.tenant_id → tenants` | RESTRICT | Hard-delete of tenant is a separate operation; use tenant-level retirement |
| `tenant_products.category_id → tenant_product_categories` | SET NULL | Retiring a category does not retire products; products become uncategorized |
| `store_product_overrides.product_id → tenant_products` | RESTRICT | Cannot delete a product with active overrides; retire the product first |
| `product_aliases.product_id → tenant_products` | RESTRICT | Cannot delete a product with aliases; retire aliases first |
| `price_history.product_id → tenant_products` | RESTRICT | Price history is immutable; cannot delete a product with history |
| `unknown_items.resolved_product_id → tenant_products` | SET NULL | If a product is later retired, unlink the resolution reference without destroying the unknown item record |

### Invariants enforced by design

1. **A Store Override cannot exist without a Tenant Catalog product.** Enforced
   by FK `store_product_overrides.product_id → tenant_products.id`.

2. **At most one active override per (tenant, store, product).** Enforced by
   partial UQ on `store_product_overrides`.

3. **At most one open price interval per product (per store).** Enforced by
   partial UQ indexes on `price_history`.

4. **An unknown item resolution requires a human actor.** Enforced by
   `CHK unknown_items_resolved_fields_consistent` and application-layer
   validation.

5. **Alias uniqueness is scope-specific.** Three partial UQ indexes enforce
   the three scope rules independently.

6. **Price history rows are immutable.** Enforced by RLS `FALSE` on
   `UPDATE` and `DELETE`.

---

## 10. RLS Policy Summary

All catalog tables are tenant-scoped. The runtime DB role must not have
`BYPASSRLS` (Constitution §2). RLS fails closed: a missing or empty
`app.current_tenant` GUC returns no rows on SELECT and rejects writes.

| Table | Tenant isolation | Store isolation | Write restriction |
|---|---|---|---|
| `global_products` | None (platform-wide) | None | Platform Admin only |
| `tenant_products` | `app.current_tenant` | None | Same tenant |
| `tenant_product_categories` | `app.current_tenant` | None | Same tenant |
| `store_product_overrides` | `app.current_tenant` | `app.current_store` | Same tenant + store |
| `product_aliases` | `app.current_tenant` | None (store-scoped rows read by tenant) | Same tenant |
| `price_history` | `app.current_tenant` | None (store rows read by tenant) | INSERT only; UPDATE/DELETE = FALSE |
| `unknown_items` | `app.current_tenant` | `app.current_store` | INSERT + UPDATE (resolution) |

Cross-tenant access and cross-store access return safe non-disclosing responses
(Constitution §2, §12). The API layer converts RLS-driven empty results for
unknown IDs into safe 404 responses, not 403 errors that would reveal existence.

---

## 11. Variants Forward-Compatibility Note (Q6)

Q6 (spec §16.Q6) resolved to **defer product variants from v1**. The v1 model
must remain compatible with a future `parent_product_id` or `variant_group_id`
column on `tenant_products` without requiring rewrites to `product_aliases`,
`price_history`, or `store_product_overrides`.

### How v1 is forward-compatible

**`product_aliases`**: aliases attach to `product_id` (the specific variant's
`tenant_products.id`). A future variant child product gets its own
`tenant_products.id` and its own alias rows. No change needed to the alias
schema when variants are introduced.

**`price_history`**: price history rows reference `product_id`. Each variant
would have its own `tenant_products.id`, its own price history rows, and its
own open-interval enforcement. The partial unique indexes on `(tenant_id,
product_id)` remain correct without modification.

**`store_product_overrides`**: overrides attach to `product_id`. Variant products
with independent prices or availability get their own override rows. No schema
change required.

### What a future variants feature must do

1. Add `parent_product_id uuid NULL REFERENCES tenant_products(id)` to
   `tenant_products` (or a separate `variant_groups` table with a FK from
   `tenant_products`).
2. Define whether variant children inherit aliases from the parent or maintain
   independent aliases.
3. Define whether store overrides apply to the parent, the variant, or both.
4. None of these decisions require changes to the alias, price history, or
   override table schemas — only to the application logic that reads them.

### Prohibited pre-implementations

Do not add `parent_product_id`, `variant_group_id`, `variant_attributes jsonb`,
or any other variant column to `tenant_products` in this feature. These are
reserved for the future variants feature specification.

---

## 12. SaleLine Snapshot Obligation

The SaleLine Snapshot is defined in spec §5.4 as a **concept and future binding
only**. No schema, table, or migration is designed here. The obligation is
recorded so that the future sales feature cannot be specified without honoring
it.

### Binding rules for future sales features

1. A SaleLine Snapshot must capture, at sale time: product identity, name,
   price, currency, tax category, and the aliases used to identify the product.
2. The snapshot is immutable post-write.
3. Historical sale facts must **not** be silently rewritten by later catalog
   changes (Constitution §10). A price change after a sale has no retroactive
   effect on `SaleLine Snapshot.price`.
4. The `correlation_id` of the sale event must be carried in the snapshot row
   for cross-reference with the catalog price history record active at that time.
5. Future sales features that read catalog data (resolved view, aliases, price)
   must record which `price_history.id` was the active interval at sale time
   so the snapshot is traceable to the exact price history row.

---

## 13. tenants Table Amendment (R-2 / PQ-1)

The `tenants` table from Feature 001 requires one additive column to support
this catalog feature. This amendment is noted here as a design obligation; the
actual migration is gated to the implementation feature.

**Column to add**:

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `default_currency_code` | `char(3)` | NOT NULL | `'USD'` | Tenant default ISO 4217 currency code. Used as pre-fill for new catalog rows. [R-2 / PQ-1 / Q2] |

**Rationale**: A dedicated column on `tenants` provides a simple, indexed join
path for catalog writes that need the pre-fill currency. There is no v1
requirement for a multi-key settings table. See R-2 and PQ-1 in `research.md`
for full decision rationale.

**Migration safety**: The `NOT NULL DEFAULT 'USD'` constraint means existing
tenants without an explicit currency code are populated with `'USD'` at
migration time, with no backfill query required. The default is safe for a
migration that adds the column to an existing table in a single DDL statement.
