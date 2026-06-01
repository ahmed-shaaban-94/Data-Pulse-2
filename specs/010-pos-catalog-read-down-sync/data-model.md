# Data Model — 010 POS Catalogue Read-Down Sync (Phase 1)

> Read projection + the change-log/cursor mechanism (R1). **No Drizzle schema or SQL is authored here** — the change-log migration is a `[GATED]` slice (Constitution VIII / Standing Rules §3). This document defines the logical shapes the gated migration + the wire contract must realize.

## 1. Resolved Sellable Catalogue Row (read projection — wire shape, not a table)

Projected from `Resolved(store) = Tenant Catalog ⊕ Store Override` (003 §6.4), filtered by the sellable rule (R5). An explicit `toBody()` wire shape (§IV — never a raw DB entity).

| Field | Type | Notes |
|:--|:--|:--|
| `product_id` | uuid | Stable identity; the consumer's resolver key. |
| `sku` | string | Exact-lookup key. |
| `name_ar` | string (NOT NULL) | Arabic-first display name. |
| `name_en` | string \| null | English name when available. |
| `aliases` | string[] | Raw alias terms (consumer folds them; platform does not). |
| `price` | `{ amount: string, currency_code: string }` | Exact-decimal string ≤4dp at the currency's **natural minor precision**; ISO-4217 currency. NEVER float. Always present for a sellable row (R5). |
| `tax_category` | string | Resolved tax category. |
| `unit_pack_label` | string \| null | e.g. "×20 tablets". |
| `active` | boolean | Resolved: `retired_at IS NULL` AND resolved is_active/availability. (A sellable row is always `active=true`; the field is explicit for consumer clarity.) |
| `controlled_substance` | boolean | Surfaced for cashier awareness (consumer does not enforce). |
| `prescription_required` | boolean | As above. |
| `row_cursor` | opaque string | Per-row change cursor/version (≤ the response cursor). |

**Validation / invariants**:
1. Tenant+store scoped — only the principal's `(tenant_id, store_id)` rows (§II/§XII).
2. `price` present + currency present + representable in currency minor unit, else the row is **not** in this projection (R5).
3. `name_ar` NOT NULL.
4. No raw DB columns, no soft-delete internals, no credential fields (§IV).

## 2. Catalogue Cursor (opaque, monotonic, scope-bound)

| Aspect | Definition |
|:--|:--|
| Encodes | `(tenant_id, store_id, sequence)` — opaque to the client |
| Monotonic | per `(tenant, store)`; total order over changes |
| Scope-bound | a cursor for one `(tenant, store)` is rejected non-disclosingly under another (FR-024) |
| Horizon | older than the retained change-log window → `snapshot_required` (FR-023) |

## 3. Catalogue Change-Log Entry (R1 — backs deltas; realized by the gated migration)

Logical shape the gated migration must provide (outbox-style; mirrors `outbox_events`):

| Field | Type | Notes |
|:--|:--|:--|
| `sequence` | monotonic (per tenant+store) | The cursor value. |
| `tenant_id`, `store_id` | uuid | Scope. |
| `product_id` | uuid | Affected product. |
| `op` | enum `upsert` \| `remove_from_sellable` | `remove_from_sellable` is the tombstone for retire OR became-unpriced/non-representable (Decision #3 / FR-042). |
| `occurred_at` | timestamptz | Diagnostics; ordering uses `sequence`, not this. |

**Population rule**: a change-log entry is written when a sellable-relevant field changes — price, currency, availability/`is_active`, `retired_at`, name/alias/tax — OR when a row crosses the sellable threshold in either direction (priced↔unpriced). Idempotent: replaying a cursor yields the same logical set (FR-021).

## 4. Sellable-Stream Delta Operation (wire shape)

| Field | Type | Notes |
|:--|:--|:--|
| `op` | `upsert` \| `remove_from_sellable` | |
| `product_id` | uuid | |
| `row` | Resolved Sellable Catalogue Row \| omitted | present for `upsert`; omitted for `remove_from_sellable` |
| `cursor` | opaque string | advanced cursor after this op |

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
