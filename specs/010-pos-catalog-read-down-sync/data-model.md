# Data Model — 010 POS Catalogue Read-Down Sync (Phase 1)

> Read projection + the change-log/cursor mechanism (R1). **No Drizzle schema or SQL is authored here** — the change-log migration is a `[GATED]` slice (Constitution VIII / Standing Rules §3). This document defines the logical shapes the gated migration + the wire contract must realize.

## 1. Resolved Sellable Catalogue Row (read projection — wire shape, not a table)

Projected from `Resolved(store) = Tenant Catalog ⊕ Store Override` (003 §6.4), filtered by the sellable rule (R5). An explicit `toBody()` wire shape (§IV — never a raw DB entity).

> **Revised 2026-06-03 (R-1 / Option B):** the wire shape carries **only fields backed by existing 003 catalog columns**. The pharmacy-domain fields `name_ar`/`name_en` (split), `controlled_substance`, `prescription_required`, and `unit_pack_label` are **removed** — they had no backing column and would have forced a catalogue write-schema change (violating §3/§9 + Constitution §I). Re-adding any is a future spec that first adds the column to 003.

| Field | Type | Backing 003 column | Notes |
|:--|:--|:--|:--|
| `product_id` | uuid | `tenant_products.id` | Stable identity; the consumer's resolver key. |
| `sku` | string | `product_aliases` (`identifier_type='sku'`) | Exact-lookup key. |
| `name` | string (NOT NULL) | `tenant_products.name` | Single display name (DP2 catalog is language-neutral; no ar/en split). |
| `aliases` | string[] | `product_aliases` (non-`sku` types: barcode/plu/supplier_code/external_pos_id) | Raw alias terms (consumer folds them; platform does not). |
| `price` | `{ amount: string, currency_code: string }` | resolved `default_price`/`default_currency_code` ⊕ override `price`/`currency_code` | Exact-decimal string ≤4dp at the currency's **natural minor precision**; ISO-4217 currency. NEVER float. Always present for a sellable row (R5). |
| `tax_category` | string | resolved `tenant_products.tax_category` ⊕ override `tax_category` | Resolved tax category. |
| `active` | boolean | resolved `retired_at IS NULL` AND `is_active` | (A sellable row is always `active=true`; the field is explicit for consumer clarity.) |
| `row_cursor` | opaque string | `catalog_change_log.sequence` (R1) | Per-row change cursor (≤ the response cursor). |

**Validation / invariants**:
1. Tenant+store scoped — only the principal's `(tenant_id, store_id)` rows (§II/§XII).
2. `price` present + currency present + representable in currency minor unit, else the row is **not** in this projection (R5).
3. `name` NOT NULL (the single `tenant_products.name`).
4. No raw DB columns, no soft-delete internals, no credential fields (§IV).

## 2. Catalogue Cursor (opaque, monotonic, scope-bound)

> **Revised 2026-06-03 (R9 — resolves external-review R-3):** the `sequence` is **per-tenant**, NOT per-`(tenant, store)`. A store's delta reads its own (`store_id = S`) events **unioned with** tenant-wide (`store_id IS NULL`) events. See research R9.

| Aspect | Definition |
|:--|:--|
| Encodes | `(tenant_id, sequence)` — opaque to the client (the store filter is applied at read time, not encoded) |
| Monotonic | **per `tenant_id`** (single sequence); total order over all of the tenant's catalogue changes. Sparse for any single store (other stores' events occupy intervening sequence values) — this is correct; completeness is server-guaranteed, not consumer-verified by contiguity (FR-022, R9) |
| Scope-bound | a cursor is bound to the principal's `(tenant_id, store_id)`; presenting it under another scope is rejected non-disclosingly (FR-024) |
| Horizon | older than the retained change-log window → `snapshot_required` (FR-023) |

## 3. Catalogue Change-Log Entry (R1 — backs deltas; realized by the gated migration)

Logical shape the gated migration must provide (outbox-style; mirrors `outbox_events`):

| Field | Type | Notes |
|:--|:--|:--|
| `sequence` | monotonic **per `tenant_id`** (R9) | The cursor value. Single per-tenant sequence — NOT per-store. |
| `tenant_id` | uuid | Scope. |
| `store_id` | uuid \| **NULL** | `NULL` = **tenant-wide** event (a `tenant_products`/tenant-wide-alias change affecting all non-overriding stores). Non-NULL = a store-override / store-scoped-alias change for that store. (R9) |
| `product_id` | uuid | Affected product. |
| `op` | enum `upsert` \| `remove_from_sellable` | `remove_from_sellable` is the tombstone for retire OR became-unpriced/non-representable (Decision #3 / FR-042). |
| `occurred_at` | timestamptz | Diagnostics; ordering uses `sequence`, not this. |

**Population rule (R9 — dumb trigger, one row per raw change)**: a change-log entry is written when a sellable-relevant field changes — price, currency, availability/`is_active`, `retired_at`, name/alias/tax — OR when a row crosses the sellable threshold in either direction (priced↔unpriced). A `tenant_products` (or tenant-wide alias) change writes **one** `store_id IS NULL` row; a `store_product_overrides` (or store-scoped alias) change writes **one** `store_id = S` row. **No write-time fan-out across stores** and **no trigger consultation of `store_product_overrides`** — the trigger is one-row-per-raw-table-change.

**Delta read**: `WHERE tenant_id = T AND (store_id = S OR store_id IS NULL) AND sequence > C ORDER BY sequence`. The resolved `row` (§1) is computed at read time per `(tenant, store)`.

**Override-masking (resolves the §3 gap flagged by external-review R-3)**: if a tenant-level field changes but store S overrides that exact field, S still receives the tenant-wide `upsert`; applying it re-writes S's resolved row to the **same** value (the resolver computes Tenant ⊕ Override; the override still wins) — a **harmless idempotent re-upsert** (FR-021). No special-casing in the trigger.

**Idempotent**: replaying a cursor yields the same logical set (FR-021).

## 4. Sellable-Stream Delta Operation (wire shape)

| Field | Type | Notes |
|:--|:--|:--|
| `op` | `upsert` \| `remove_from_sellable` | |
| `product_id` | uuid | |
| `row` | Resolved Sellable Catalogue Row \| omitted | present for `upsert`; omitted for `remove_from_sellable` |
| `row_cursor` | opaque string | advanced cursor after this op (canonical per-row token name — locks analyze I2/R-5; the response-level continuation token is `next_page_token`) |

## 5. Unpriced-Catalogue Issue (derived signal/backlog — not a sellable row)

| Field | Type | Notes |
|:--|:--|:--|
| `tenant_id`, `store_id`, `product_id` | uuid | The excluded product. |
| `reason` | enum | `null_price` \| `missing_currency` \| `non_representable` |
| surfacing | — | observability counter (R6) + backlog data for an existing/future reconciliation surface; **NEVER** on the POS sellable stream, **NEVER** to a cashier. |

## State transitions (sellable membership)

```
priced+active+representable   ──(price→null / currency dropped / non-representable / retire / deactivate)──>  remove_from_sellable delta  +  unpriced-issue (if price-related)
unpriced / inactive / retired ──(becomes priced+active+representable)──────────────────────────────────────>  upsert delta (re-enters sellable stream)
```
