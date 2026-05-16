# Quickstart: Catalog Foundation — Behavior Verifier Walkthrough

**Feature ID**: 003
**Task**: T313
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Research**: [research.md](./research.md)
**Data model**: [data-model.md](./data-model.md)
**RLS matrix**: [rls-test-matrix.md](./rls-test-matrix.md)
**Constitution**: v3.0.0
**Status**: Documentation only — no implementation, no tests, no runtime yet
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban

---

## 0. Purpose and scope

This document is a **behavior-level verifier walkthrough** for the seven
Required Scenarios (S1–S7) in `spec.md §7`. It is the human-readable companion
to `data-model.md` and the `rls-test-matrix.md`: each S# below describes what a
future verifier (manual reviewer or automated integration test, once written)
must observe in order to conclude that the catalog foundation model honors the
spec.

This file is **documentation-only**. It is not a script, a runbook, or an
executable plan:

- No shell commands.
- No command-line HTTP client examples.
- No HTTP methods, paths, or operationIds that look like real endpoints.
- No real POS endpoints.
- No claim that any test, route, service, or runtime exists yet.

POS-Pulse is a separate repository. The catalog foundation describes how the
SaaS platform models its source-of-truth layers; POS will integrate **only**
through documented OpenAPI contracts authored in future, gated features
(Constitution §4). POS must never reach the SaaS database directly.

Cross-tenant and cross-store rejection are described throughout using the
constitution-aligned phrase: **"the response is indistinguishable from
not-found."** This deliberately avoids stating an HTTP status code or
permission verdict, because the platform must not let an outsider learn that a
tenant or store exists by observing a different error code. Implementation
features will encode the concrete status code in their contracts; that detail
is out of scope here.

---

## 1. Layers and roles a verifier must understand first

A verifier must be able to identify these four source-of-truth layers
(`spec.md §5`) without conflating them:

| Layer | What it owns | Who writes it |
|---|---|---|
| Global Product Index | Reference-only suggestions | Platform Admin |
| Tenant Catalog | Authoritative tenant-owned products, default price, default tax, default aliases | Tenant Owner / Tenant Admin |
| Store Override | Branch-level deviations for price, availability, tax category | Tenant Owner / Tenant Admin / Store Manager of that store |
| SaleLine Snapshot *(future)* | Invoice truth — what was sold, at what price, in what currency, with what tax, at the moment of sale | Future sales feature (binding obligation only here) |

Roles referenced below correspond to `spec.md §4`: Platform Admin, Tenant
Owner, Tenant Admin, Store Manager, Store Staff, and POS Device / POS Operator
(future). Anonymous principals have no catalog access.

---

## 2. The resolved store catalog (read-model behavior)

Several scenarios depend on the **resolved store catalog** read view
(`spec.md §6.4`). A verifier confirms the algorithm produces the expected
result for a given `(tenant, store, product)` triple by checking that overlay
semantics apply field-by-field over the tenant default — and only for the
overrideable fields fixed by Q8.

### 2.1 Definition

`Resolved(store) = Tenant Catalog ⊕ Store Override(store)`

The `⊕` operator means: for each overrideable field, if the Store Override has
a non-null value for that field, use it; otherwise fall back to the Tenant
Catalog value.

### 2.2 Overrideable fields (Q8 / data-model.md §5)

The Store Override may carry, per `(tenant_id, store_id, product_id)`:

- `price` (with paired `currency_code`)
- `is_active` (store-level availability)
- `tax_category`

Product **name** and **category** are **never** overrideable at store level in
v1. Product identity remains tenant-level truth.

### 2.3 Field-by-field resolution rules

For a given `(tenant, store, product)`:

| Resolved field | Source if Store Override present | Source if no Store Override |
|---|---|---|
| Product identity (`id`) | Tenant Catalog | Tenant Catalog |
| Name | Tenant Catalog | Tenant Catalog |
| Category | Tenant Catalog | Tenant Catalog |
| Price | Store Override `price` if `NOT NULL`; else Tenant Catalog `default_price` | Tenant Catalog `default_price` |
| Currency code | Store Override `currency_code` if Store Override `price IS NOT NULL`; else Tenant Catalog `default_currency_code` | Tenant Catalog `default_currency_code` |
| Active flag | Store Override `is_active` if `NOT NULL`; else Tenant Catalog `is_active` | Tenant Catalog `is_active` |
| Tax category | Store Override `tax_category` if `NOT NULL`; else Tenant Catalog `tax_category` | Tenant Catalog `tax_category` |
| Aliases | Tenant Catalog aliases (with store-scope filtering — see §3) | Tenant Catalog aliases |

### 2.4 Branch-of-truth precedence

The verifier confirms branch-of-truth precedence by checking the following
invariants:

1. A Store Override row **cannot exist without** a Tenant Catalog product
   row. The FK `store_product_overrides.product_id → tenant_products.id`
   guarantees this at the database layer.
2. Editing a Store Override **never** mutates the Tenant Catalog row.
3. Editing the Tenant Catalog **does not silently** rewrite the Store
   Override; if the override has a non-null value, it continues to apply.
4. A Store Override row whose every overrideable column is `NULL` is rejected
   by `CHK store_product_overrides_at_least_one_override` and cannot exist.
5. The resolved view is **read-only**: it is a computed projection, not a
   stored table. Writes always go to either Tenant Catalog or Store Override,
   never to "the resolved view."

### 2.5 Active-flag composition

If either layer marks the product as inactive in the store's resolution
window, the resolved record is **inactive for that store**. Concretely: the
resolved `is_active` is the Store Override value when present, otherwise the
Tenant Catalog `is_active`. A product retired at the tenant level
(`tenant_products.retired_at IS NOT NULL`) is excluded entirely from the
resolved view; no store can keep a retired tenant product alive.

### 2.6 Currency invariant

In the resolved view, a non-null `price` always carries a non-null
`currency_code`. The pairing CHK constraints on both `tenant_products` and
`store_product_overrides` (Q2) make any other state unreachable. A verifier
that observes `price NOT NULL AND currency_code NULL` in a resolved record
must flag it as a model violation — that combination is unrepresentable.

---

## 3. Alias resolution order (lookup behavior)

When an identifier is presented (a barcode scan, a SKU lookup, a PLU keypad
entry, a POS-supplied `externalId`, or a supplier code), the alias resolver
must return **at most one product** within the configured resolution scope
(`spec.md §6.1`, `data-model.md §6`). This section defines the lookup order a
verifier must observe.

### 3.1 The three uniqueness scopes (Q4 / data-model.md §6)

Aliases are tagged with an `identifier_type` and a `value`. Uniqueness is
**identifier-type-specific**:

1. **Tenant-wide scope** — for `identifier_type IN ('barcode', 'sku', 'plu',
   'supplier_code')` when `store_id IS NULL`. Uniqueness is enforced by the
   partial unique index `UQ_idx_product_aliases_tenant_wide` on
   `(tenant_id, identifier_type, value) WHERE store_id IS NULL AND
   identifier_type <> 'external_pos_id' AND retired_at IS NULL`.
2. **External POS identifier scope** — for `identifier_type =
   'external_pos_id'`, which requires a non-null `source_system`. Uniqueness
   is enforced by `UQ_idx_product_aliases_external_pos_id` on
   `(tenant_id, source_system, value) WHERE identifier_type =
   'external_pos_id' AND retired_at IS NULL`. External POS identifiers are
   always tenant-wide and cannot be store-scoped (CHK
   `product_aliases_store_scope_consistency`).
3. **Store-scoped scope** — for any alias explicitly flagged as store-scoped
   by setting `store_id IS NOT NULL`. Uniqueness is enforced by
   `UQ_idx_product_aliases_store_scoped` on `(tenant_id, store_id,
   identifier_type, value) WHERE store_id IS NOT NULL AND retired_at IS
   NULL`. Aliases **default to tenant-wide** and are store-scoped only when
   explicitly flagged.

### 3.2 Lookup precedence

For a lookup originating in a known `(tenant, store)` context, the resolver
behaves as follows:

1. Identify the `identifier_type` of the presented value. The caller declares
   the type (e.g., POS specifies `barcode` vs `external_pos_id`); the system
   does not guess.
2. Resolve in this order:
   - **External POS identifier**: if `identifier_type = 'external_pos_id'`,
     look up by `(tenant_id, source_system, value)` against the active aliases.
   - **Store-scoped first, then tenant-wide**: for any other identifier type,
     first look for an active alias matching `(tenant_id, store_id,
     identifier_type, value)`. If a store-scoped alias is found, return it.
     Otherwise, look for an active alias matching `(tenant_id,
     identifier_type, value) WHERE store_id IS NULL`.
3. If exactly one alias matches in the scope chain, the resolver returns its
   `product_id` and the lookup is complete.
4. If **no** alias matches, the resolver does not invent a product. The
   caller treats the lookup as unresolved and, in POS contexts, the unknown
   item flow (§6) is triggered.
5. If **multiple** aliases match within the same active scope — a state that
   the partial unique indexes are designed to prevent — the resolver does
   **not** pick an arbitrary winner. Instead, a `duplicate_alias_conflict`
   observability event is emitted (`spec.md §9`) and the lookup surfaces a
   conflict signal to the caller. This event is metric-only and contains no
   identifier values, PII, or product names per `spec.md §9` and Constitution
   §7.

### 3.3 Why store-scoped beats tenant-wide

Q4 (`spec.md §16.Q4`) flags store-scoped aliases as the explicit exception.
A store-scoped alias exists precisely to express "in this store, this
barcode/SKU points to a different product than the tenant-wide default."
Tenant-wide is the default; store-scoped overrides it when present. The
lookup order in §3.2 mirrors that precedence: store-scoped match first, then
tenant-wide match.

### 3.4 Identifier types covered

The Q4 contract covers, at minimum, these identifier types from
`data-model.md §6` (the CHK `product_aliases_identifier_type_valid`
enumeration):

- `barcode` — EAN / UPC / GTIN values from POS scanners.
- `sku` — internal stock-keeping unit string.
- `plu` — price-look-up code (typically produce / weighted goods).
- `supplier_code` — supplier-side product identifier for purchasing
  reconciliation.
- `external_pos_id` — legacy POS-system identifier; always requires
  `source_system`.

A verifier confirms that each type is resolved by the same scope-chain
algorithm above, except that `external_pos_id` is restricted to the external
POS identifier scope (it cannot be store-scoped and always carries
`source_system`).

### 3.5 Idempotency note for POS ingestion

Future POS sale ingestion follows the `sourceSystem + externalId` idempotency
pattern (Constitution §11). The verifier confirms that resolving an
`external_pos_id` alias is the same lookup whether the call arrives once or
ten times; the resolver returns the same `product_id` deterministically and
records no state on successful read.

---

## 4. Scenario S1 — Tenant admin creates and manages a tenant-owned product

**Scenario reference**: `spec.md §7` row 1.
**Layers involved**: Tenant Catalog (write); Global Product Index (must not be
mutated); Product Aliases (optional attach).

### 4.1 What a verifier confirms

A Tenant Admin acting under their authenticated tenant context creates a new
product. The verifier confirms:

1. A new `tenant_products` row exists under the principal's `tenant_id`. The
   value of `tenant_id` is taken **from the authenticated principal**, not
   from any body-supplied field. Body-supplied `tenant_id`, `created_by`,
   `updated_by`, `source_global_product_id`, and any audit timestamps are
   rejected by strict body validation (Constitution §12).
2. No `global_products` row is created, updated, or retired by this action.
3. The new tenant product carries: a non-empty `name`, an explicit
   `tax_category` (Q11), an `is_active` flag (default `TRUE`), and, if a
   price is provided, a paired `default_price` and `default_currency_code`
   (Q1, Q2).
4. An audit event is recorded for the create operation per `spec.md §8`,
   carrying actor, tenant, store (N/A — null at tenant scope), operation
   (`tenant_product.create`), target product id, timestamp, correlation id,
   and outcome.
5. Optional aliases attached to the new product (per §3) honor the
   identifier-type-specific uniqueness rules. A duplicate alias write surfaces
   the duplicate-alias conflict signal (§3.2 step 5) rather than silently
   creating the duplicate.

### 4.2 What a verifier confirms is *not* true

- The Global Product Index is unchanged.
- No price history row is required at creation time if no price is set; if
  a price is set at creation, a single open interval price history row is
  inserted with `effective_from = now()` and `effective_to = NULL` (see §8).
- No Store Override row is created automatically.

### 4.3 Negative branch

A principal lacking Tenant Admin or Tenant Owner authority who attempts the
same write receives a response **indistinguishable from not-found**. The
existence of the target tenant or product is not disclosed by the response
shape, status code, or error message.

---

## 5. Scenario S2 — Tenant admin adopts a Global Product Index suggestion

**Scenario reference**: `spec.md §7` row 2.
**Layers involved**: Global Product Index (read-only); Tenant Catalog (write).
**Decision binding**: Q5 — copy-on-adopt snapshot.

### 5.1 What a verifier confirms

A Tenant Admin selects a Global Product Index suggestion and adopts it into
their tenant catalog. The verifier confirms:

1. A new `tenant_products` row is created under the principal's `tenant_id`
   carrying its own independent values for name, default price, default
   currency code, suggested tax category, and any other adoptable fields,
   **copied from the global record at adoption time**.
2. The new tenant product row stores the originating `global_products.id` in
   `source_global_product_id` for **provenance only**. There is **no
   foreign-key constraint** between `tenant_products.source_global_product_id`
   and `global_products.id` (data-model.md §3) — the reference is soft.
3. Any subsequent edit to the originating `global_products` row does **not**
   propagate to the adopted `tenant_products` row. The two records are
   independent post-adoption.
4. Any subsequent retirement of the originating `global_products` row does
   **not** retire or constrain the adopted tenant product.
5. An audit event of operation `tenant_product.adopt_from_global` is recorded,
   carrying actor, tenant, the adopted product id, the source global product
   id (for traceability), timestamp, correlation id, and outcome
   (`spec.md §8`).

### 5.2 Why copy-on-adopt and not link

Q5 (`spec.md §16.Q5`) resolved this: the Tenant Catalog is the tenant's
truth. A live link would let a Platform Admin silently mutate tenant data via
an edit to the Global Product Index, violating Constitution §9. The
copy-on-adopt snapshot makes the tenant a truly independent owner of its data
while preserving an audit trail back to the suggestion.

### 5.3 Negative branch

An unauthenticated principal, or an authenticated principal without Tenant
Admin / Tenant Owner authority, that attempts to adopt receives a response
**indistinguishable from not-found**. The Global Product Index remains
readable to authenticated tenant users (read-only suggestion mode), but
adoption is a write that requires tenant write authority.

---

## 6. Scenario S3 — Store manager creates a Store Override

**Scenario reference**: `spec.md §7` row 3.
**Layers involved**: Tenant Catalog (read, unchanged); Store Override (write);
Price History (write if price changed).

### 6.1 What a verifier confirms

A Store Manager of Store X creates a Store Override for product P (which
already exists in the Tenant Catalog). The verifier confirms:

1. A new `store_product_overrides` row exists under `(tenant_id, store_id,
   product_id) = (A, X, P)`. The values for `tenant_id` and `store_id` are
   resolved from the authenticated principal's tenant and active-store
   context, **not** from the request body.
2. The row carries at least one non-null overrideable field: `price` (with
   paired `currency_code`), `is_active`, or `tax_category`. An attempt to
   create a row with all overrideable fields null is rejected by
   `CHK store_product_overrides_at_least_one_override`.
3. The corresponding `tenant_products` row for product P is **unchanged**.
   Its `name`, `category_id`, `default_price`, `default_currency_code`,
   `is_active`, and `tax_category` retain their pre-existing values.
4. The resolved view for `(A, X, P)` reflects the override per §2.3. The
   resolved views for `(A, Y, P)` and `(A, Z, P)`, where Y and Z are other
   stores of tenant A with no Store Override row for P, **continue to return
   the Tenant Catalog defaults** for P.
5. An audit event for `store_product_override.create` is recorded with
   actor, tenant, store, target product id, the set of overridden fields,
   timestamp, correlation id, and outcome (`spec.md §8`).
6. If the new override sets a non-null `price`, a `price_history` row is
   created with `store_id = X`, `product_id = P`, `effective_from = now()`,
   `effective_to = NULL`. See §8 for full price-history behavior.

### 6.2 Non-overrideable fields

A Store Manager **cannot** set `name` or `category_id` via Store Override —
those columns do not exist on `store_product_overrides` (data-model.md §5).
An attempt to supply them in the request body is rejected by strict body
validation. The Tenant Catalog name and category remain tenant-level truth
across all stores.

### 6.3 Negative branches

- A Store Manager of Store X attempting to write a Store Override for Store
  Y (a different store of the same tenant) receives a response
  **indistinguishable from not-found**. The existence of Store Y or product
  P-in-Store-Y is not disclosed.
- A principal of tenant B attempting to write a Store Override against
  tenant A's product P receives a response **indistinguishable from
  not-found**. The existence of tenant A, store X, or product P is not
  disclosed.
- Cross-tenant and cross-store probes covered in `rls-test-matrix.md` §4
  describe the verifier-level RLS expectations.

---

## 7. Scenario S4 — Staff / POS lookup resolves a barcode/SKU to the correct catalog view

**Scenario reference**: `spec.md §7` row 4.
**Layers involved**: Tenant Catalog (read); Store Override (read); Product
Aliases (read).

### 7.1 What a verifier confirms

A lookup arrives in context `(tenant A, store X)` with an identifier of a
specific `identifier_type`. The verifier confirms:

1. The alias resolver follows the lookup order described in §3.2 and returns
   **at most one** product within the scope chain.
2. If the alias resolves to product P, the response presents the **resolved
   view** of `(A, X, P)` per §2.3 — Tenant Catalog ⊕ Store Override(X), not
   the raw Tenant Catalog and not the raw Store Override row.
3. If the alias does not resolve to any product, the response indicates an
   unresolved lookup; the unknown item flow (§8) is invoked at the POS
   boundary in S5.
4. A duplicate alias within the active uniqueness scope emits the
   `duplicate_alias_conflict` observability signal (`spec.md §9`) and the
   resolver does not return an arbitrary winner. The signal contains
   tenant-anonymous and product-anonymous labels per Constitution §7.
5. A retired product (`tenant_products.retired_at IS NOT NULL`) is excluded
   from resolution even if a non-retired alias still references it; the
   alias retire path is the canonical retirement step (data-model.md §6).
6. A retired alias (`product_aliases.retired_at IS NOT NULL`) does not match
   the lookup. Alias retire is non-destructive; historical alias rows are
   preserved and excluded by the partial indexes' `WHERE retired_at IS NULL`
   predicates.

### 7.2 What read authority is required

Per `spec.md §4`, Store Staff and POS Device (future) can read the resolved
store catalog. Tenant Owner / Tenant Admin / Store Manager can also read it.
Anonymous principals cannot read it at all. The RLS policies in
`data-model.md §10` enforce these scopes at the database layer; the API
layer must convert any cross-tenant or cross-store lookup result into a
response **indistinguishable from not-found**.

### 7.3 POS posture

No POS endpoint is implemented in this feature. The behavior described above
is the resolved-view contract that future POS-facing OpenAPI contracts must
honor. POS integrates only through documented APIs published in
`packages/contracts/openapi/` in future features (Constitution §4); POS does
not access the SaaS database directly.

---

## 8. Scenario S5 — POS records an unknown item

**Scenario reference**: `spec.md §7` row 5.
**Layers involved**: Unknown Item Workflow (write); Tenant Catalog
(**must not** be silently mutated); Product Aliases (write at resolution
time, optional).
**Decision binding**: Q10 — manual approval only in v1.

### 8.1 What a verifier confirms at the unrecognized-identifier moment

A POS interaction (future) presents an identifier in context `(tenant A,
store X)` that does not resolve to any product per §3.2 step 4. The verifier
confirms:

1. A single new `unknown_items` row is created under
   `(tenant_id = A, store_id = X)`, carrying: `identifier_type`, `value`,
   `source_system` (when `identifier_type = 'external_pos_id'`, otherwise
   `NULL`), `encountered_at = now()`, an optional `sale_context` jsonb
   payload, `resolution_status = 'pending'`, `resolved_*` fields all null,
   and a `correlation_id` taken from the originating request.
2. **No** `tenant_products` row is created.
3. **No** `product_aliases` row is created.
4. The Tenant Catalog is otherwise unchanged.
5. An audit event for `unknown_item.create` is recorded
   (`spec.md §8`).

### 8.2 Workflow row enters the review queue

The unknown item is now visible in the per-store review queue surfaced to
Tenant Admin and Store Manager via the `idx_unknown_items_pending` index.
Anonymous and Store Staff principals do not see this queue per the role
matrix (`spec.md §4`).

### 8.3 Resolution paths (manual approval only — Q10)

A Tenant Admin or Store Manager later resolves the unknown item. The verifier
confirms exactly one of three outcomes:

1. **Linked** — the unknown item is linked to an existing tenant product.
   - A new `product_aliases` row is created connecting the identifier value
     and `identifier_type` to the chosen `tenant_products.id`, honoring the
     uniqueness scope rules from §3.1. If a uniqueness conflict is detected,
     the resolution attempt fails with the duplicate-alias conflict signal
     and the unknown item remains `pending`.
   - The `unknown_items` row is updated: `resolution_status = 'resolved'`,
     `resolution_action = 'linked'`, `resolved_at = now()`, `resolved_by =
     <actor user id>`, `resolved_product_id = <chosen product id>`.
2. **Created** — a new tenant product is created (in a separate
   `tenant_products` write) and the unknown item is linked to it.
   - The `tenant_products` write follows the S1 rules in §4.
   - A new `product_aliases` row is created connecting the identifier to the
     new product (uniqueness rules apply).
   - The `unknown_items` row is updated: `resolution_status = 'resolved'`,
     `resolution_action = 'created'`, `resolved_at`, `resolved_by`, and
     `resolved_product_id` populated as in path 1.
3. **Dismissed** — the unknown item is judged invalid (typo, mis-scan,
   garbage).
   - No `tenant_products` row is created. No `product_aliases` row is
     created.
   - The `unknown_items` row is updated: `resolution_status = 'dismissed'`,
     `resolution_action = 'dismissed'`, `resolved_at`, `resolved_by`
     populated; `resolved_product_id` remains `NULL`.

The `CHK unknown_items_resolved_fields_consistent` constraint ensures the
resolution fields are populated all-or-nothing per data-model.md §8.

### 8.4 What a verifier confirms is *not* true

- The system does not auto-create a `tenant_products` row from an unknown
  item. Q10 explicitly forbids that. Any future auto-create policy must be a
  separately-specified opt-in feature.
- The `sale_context` field, when present, is never written to logs at INFO,
  WARN, or ERROR boundaries (Constitution §14, data-model.md §8). The
  verifier confirms no log line carries `sale_context` contents.
- The `resolved_by` column is never set without an actor. A code path that
  sets `resolved_at` without `resolved_by` is a bug; the CHK constraint
  rejects such a row.

### 8.5 Observability

The `unknown_items` insert increments the **unknown-item rate** metric
(`spec.md §9`). Each subsequent resolution emits an audit event but does not
emit a separate unknown-item metric — the workflow row is the source of
truth for the queue.

---

## 9. Scenario S6 — Price change preserves history and does not mutate past sale facts

**Scenario reference**: `spec.md §7` row 6.
**Layers involved**: Tenant Catalog or Store Override (write); Price History
(write — interval close + open); SaleLine Snapshot (future — must remain
untouched).
**Decision binding**: Q1 (numeric(19,4)), Q2 (paired currency), Q9 (effective
intervals).

### 9.1 The interval-close write sequence

A tenant or store price changes from value V1 (currency C) to value V2
(currency C). The verifier confirms the write path performs these steps in a
single serialized service call under read-committed isolation (data-model.md
§7):

1. Read the **currently open interval** for the affected scope:
   - Tenant-level price change: `(tenant_id, product_id)` with `store_id IS
     NULL AND effective_to IS NULL`.
   - Store-override price change: `(tenant_id, product_id, store_id)` with
     `effective_to IS NULL`.
2. **Close** the open interval: `UPDATE price_history SET effective_to =
   now() WHERE id = <current open interval id>`.
3. **Open** a new interval: `INSERT INTO price_history` with `price = V2`,
   `currency_code = C`, `effective_from = now()`, `effective_to = NULL`,
   `changed_by = <authenticated actor>`, `correlation_id = <request
   correlation>`.
4. Update the canonical `tenant_products.default_price` or
   `store_product_overrides.price` to V2 in the same operation.

### 9.2 Invariants the verifier checks

1. **At most one open interval per scope.** The partial unique indexes
   `UQ_idx_price_history_tenant_open` and `UQ_idx_price_history_store_open`
   (data-model.md §7) guarantee this at the database layer. If a buggy code
   path attempts to insert a second open interval before closing the first,
   the second insert fails.
2. **Immutability.** No price history row is ever updated or deleted by
   application code. The RLS policy `price_history_no_update_delete` is
   `FALSE` for UPDATE and DELETE; the `rls-test-matrix.md` §6.3 documents
   that even own-tenant principals receive denial.
3. **Currency presence.** Every `price_history` row carries a non-null
   `currency_code` (Q2 — there is no exception for this table because it
   always stores an actual monetary amount).
4. **Interval ordering.** `CHK price_history_interval_order` ensures
   `effective_to IS NULL OR effective_to > effective_from`.
5. **Point-in-time lookup.** A query of the form `WHERE effective_from <= $t
   AND (effective_to IS NULL OR effective_to > $t)` returns exactly one row
   per scope at any past timestamp $t — the price that was active then.

### 9.3 What a verifier confirms is *not* true

- Historical `price_history` rows are not silently overwritten by later
  price changes. A correction to a historical price is recorded as a **new
  row** (per Constitution §13 audit-immutability) and the original row
  remains visible.
- A price change to `tenant_products.default_price` or
  `store_product_overrides.price` does **not** retroactively rewrite any
  past SaleLine Snapshot row (Constitution §10, `spec.md §5.4`). SaleLine
  Snapshot is the future obligation captured by `data-model.md §12`. When
  that feature lands, sale rows must reference the `price_history.id` that
  was the open interval at sale time so the snapshot remains traceable.
- A price change does **not** alter the resolved view's overlay semantics —
  the resolution algorithm in §2.3 continues to apply with the new value.

### 9.4 Audit

The price-change operation emits an audit event with the from-value,
to-value, currency, actor, tenant, store (where applicable), correlation id,
and the resulting `price_history.id` per `spec.md §8`. The audit log entry
cross-references the price_history row.

---

## 10. Scenario S7 — Cross-tenant / cross-store access is safely rejected

**Scenario reference**: `spec.md §7` row 7.
**Layers involved**: All catalog tables, all read and write paths.
**Constitution alignment**: §2 (Multi-Tenant SaaS by Default), §12
(Authorization & Object Safety).

### 10.1 The non-disclosure contract

For every catalog endpoint and operation (read or write), the platform must
satisfy this contract: **the response a principal receives when targeting
data they cannot access is indistinguishable from the response they would
receive if the target did not exist.**

This means:

- The body of the response must not reveal whether the target tenant,
  store, product, alias, price history row, or unknown item exists.
- The response status code must not differ based on whether the failure was
  caused by authorization or non-existence.
- The error message and structured envelope must not differ.
- Headers must not differ in a way that lets an outsider infer existence.

The phrase used throughout this document — "indistinguishable from
not-found" — is deliberately non-numeric. The implementation feature
encodes the concrete status code in its OpenAPI contract; that detail is
out of scope here.

### 10.2 Cross-tenant verifier checks

A verifier confirms, for principal P of tenant A operating against any
record `r` belonging to tenant B (B != A):

1. SELECT-class operations against `r` return the response **indistinguishable
   from not-found**. No row is returned and no field of `r` is revealed.
2. UPDATE-class and DELETE-class operations targeting `r` by id receive the
   same not-found-shaped response. Zero rows are affected.
3. INSERT-class operations with body-supplied `tenant_id` set to B are
   **never** trusted. The principal's authenticated tenant is A; the insert
   either uses A (overriding the body) or is rejected by strict body
   validation. Cross-tenant body injection is forbidden by Constitution §12.
4. The RLS policies on every catalog table — listed in `data-model.md §10`
   and exercised by the scenarios in `rls-test-matrix.md` — enforce this at
   the database layer, not just at the application layer.

### 10.3 Cross-store verifier checks

A verifier confirms, for principal P with active store X of tenant A,
operating against a store-scoped record `s` for store Y (Y != X, Y owned by
A):

1. SELECT-class operations against `s` return the response **indistinguishable
   from not-found**, except when P has tenant-wide read authority (Tenant
   Owner / Tenant Admin) and the request is presented with `app.current_store
   = ''` per data-model.md §5 — the documented cross-store read carve-out for
   tenant owners.
2. INSERT-class and UPDATE-class operations against `s` are rejected.
   `store_product_overrides_tenant_write` and `unknown_items_*` policies
   require `store_id = current_setting('app.current_store')::uuid` for
   writes, so Store Manager of X cannot mutate Store Y data.
3. Body-supplied `store_id` is **never** trusted. The store context is the
   principal's active store; bodies attempting to set a different `store_id`
   are rejected by strict body validation.
4. Cross-store presence is not leaked. A Store Manager of X who probes for a
   record that only exists in store Y receives a response
   **indistinguishable from not-found** — the same response they would
   receive if Y did not exist or had no override for the queried product.

### 10.4 Fail-closed posture

The RLS policies fail closed on a missing or empty `app.current_tenant`
GUC: SELECTs return zero rows and writes are rejected. A request that
arrives without tenant context produces no leakage — it produces no data.
The verifier confirms this by observing the `rls-test-matrix.md` §2.3 /
§3.3 / §4.6 / §5.3 / §6.5 / §7.6 scenarios.

### 10.5 What a verifier confirms is *not* true

- The platform does **not** return a separate "permission denied" response
  for cross-tenant or cross-store access. A separate response code or
  envelope would itself leak existence.
- The platform does **not** include the target tenant id, store id, product
  id, alias value, or price in any error response for a failed cross-tenant
  or cross-store operation.
- A successful operation and a denied operation **must not** be
  distinguishable by timing in a way that leaks existence at any
  noticeable scale. Timing-channel hardening is the implementation
  feature's concern; the verifier records the obligation here.

---

## 11. Verifier outcomes summary

| # | Scenario | Verifier must observe |
|---|---|---|
| S1 | Tenant admin creates a tenant-owned product | New `tenant_products` row under principal's tenant; Global Product Index untouched; audit event recorded; aliases honor §3 rules. |
| S2 | Tenant admin adopts a Global Product Index suggestion | New `tenant_products` row with `source_global_product_id` set as a soft provenance reference (no FK); subsequent global edits do not propagate. |
| S3 | Store manager creates a Store Override | New `store_product_overrides` row under `(tenant, store, product)`; Tenant Catalog row unchanged; resolved view for this store reflects the override; other stores unaffected. |
| S4 | Staff / POS lookup | Alias resolver returns at most one product per the scope chain in §3.2; duplicate alias emits conflict signal; result presented as resolved view. |
| S5 | POS records an unknown item | One `unknown_items` row created; no `tenant_products` or `product_aliases` row created automatically; manual approval required to resolve. |
| S6 | Price change | Open interval closed, new interval opened, canonical price column updated; immutability holds; past SaleLine Snapshots (when sales features land) are not retroactively rewritten. |
| S7 | Cross-tenant / cross-store access | Response **indistinguishable from not-found**; RLS denies at database layer; body-supplied tenant_id / store_id rejected. |

---

## 12. What this document is *not*

- It is **not** a list of HTTP routes. No real route, method, or
  operationId appears in this document.
- It is **not** a contract. OpenAPI contracts will be written in future
  features under `packages/contracts/openapi/`.
- It is **not** a test suite. No tests exist for this feature yet. The
  `rls-test-matrix.md` planning artifact identifies the future test tasks;
  this quickstart is the human-readable behavior reference those tests will
  honor.
- It is **not** a POS integration guide. POS integrates only through
  documented OpenAPI contracts published in future, gated features.
- It is **not** a runbook. There are no shell commands, no command-line
  HTTP client invocations, and no operational procedures here.

---

## 13. Cross-references

- `spec.md` §5 — Source-of-truth layers (Global / Tenant / Store /
  SaleLine Snapshot).
- `spec.md` §6 — Aliases, Price History, Unknown Item, Resolved Catalog
  View.
- `spec.md` §7 — Required Scenarios S1–S7 (the seven scenarios this
  document walks through).
- `spec.md` §8 — Audit requirements.
- `spec.md` §9 — Observability requirements (`unknown_item_rate`,
  `duplicate_alias_conflict`, `catalog_lookup_failure_rate`,
  `reconciliation_mismatch_rate`).
- `spec.md` §16 — Clarifications Q1–Q12.
- `data-model.md` §2–§8 — Entity definitions.
- `data-model.md` §10 — RLS policy summary.
- `data-model.md` §12 — SaleLine Snapshot obligation (binding on future
  sales feature).
- `rls-test-matrix.md` — Per-table verifier scenarios for tenant and store
  isolation, raw-SQL bypass probes, malicious body-override probes.
- `research.md` — R-1..R-5 and PQ-1..PQ-6 decisions referenced by the data
  model.
