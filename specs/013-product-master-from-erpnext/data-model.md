# Data Model Design: Product Master from ERPNext

**Feature ID**: 013
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Mapping concepts**: [mapping-concepts.md](./mapping-concepts.md)
**Constitution**: v3.0.1
**Status**: **Design only — `[GATED]`.** No SQL, no Drizzle schema, no migration, no OpenAPI YAML authored here.
**Created**: 2026-06-04
**Owner**: Ahmed Shaaban

> This document is **design-only** and carries the **`[GATED]`** marker because
> it designs a forbidden surface — a **new DB table + migration** under
> `packages/db/**` (standing rules §3, Constitution §VIII). **No schema file or
> migration is authored here.** The actual Drizzle schema + SQL migration land
> in their own `[GATED]` approval slice **after this design is accepted**.
>
> It mirrors the [003 catalog `data-model.md`](../003-catalog-foundation/data-model.md)
> shape and conventions. It realises the [013 plan](./plan.md)'s committed design
> (OQ-1 mapping/reconciliation, OQ-2 1:1, OQ-7 suggest-then-confirm, OQ-8 lazy /
> no-worker), all locked by the owner 2026-06-04.

---

## Contents

1. [Overview and conventions](#1-overview-and-conventions)
2. [Entity: `erpnext_item_map`](#2-entity-erpnext_item_map)
3. [The confirmed-only resolution invariant](#3-the-confirmed-only-resolution-invariant)
4. [Concurrency posture (§III)](#4-concurrency-posture-iii)
5. [RLS policy summary](#5-rls-policy-summary)
6. [Relationships & cross-entity notes](#6-relationships--cross-entity-notes)
7. [Open questions still deferred (OQ-3/4/5/6)](#7-open-questions-still-deferred)
8. [Constitution Check (data-model level)](#8-constitution-check-data-model-level)

---

## 1. Overview and conventions

### What this table is — and is NOT

`erpnext_item_map` is a **pure identity-mapping table**: it links a DP2
`tenant_products` row to an **ERPNext Item reference** so a future sale posting
(015) can resolve the line to a real Item (posting decision §1; "fails-to-DLQ if
not"). Per **OQ-1 (mapping/reconciliation)**, it does **NOT** carry catalog
authority: the §IX Tenant Catalog (`tenant_products`) stays authoritative for the
retail product view. The mapping reconciles identities; it never overrides them.

**It is an identity table only** (OQ-3/OQ-4 resolved 2026-06-04):

- **No UOM column** — UOM conversion is a connector-internal / 015-posting
  concern against the ERPNext Item's own UOM (OQ-3). Keeping it off the table
  preserves version-independence (012 O-6).
- **No price / price-list column** — DP2 amounts are authoritative for the posted
  invoice (posting decision §4; §IX); ERPNext must not reprice a DP2 sale. A
  pricing column on an identity table is exactly where §IX would blur, so it is
  **deliberately absent** (OQ-4 — §IX-forced).

### Source-of-truth authority

| Entity | Layer | Authority |
|---|---|---|
| `tenant_products` (003) | Tenant Catalog | **Authoritative** for the tenant's retail product (unchanged by 013) |
| `erpnext_item_map` (013, new) | Mapping/reconciliation | Authoritative for **the link** only — which ERPNext Item a tenant product resolves to |
| ERPNext Item (external) | Accounting | ERPNext owns accounting Item identity; reached only via the connector |

### Notation

Same as 003's data-model: **PK / FK / UQ / CHK / IDX / RLS**. `[OQ-#]` binds to
[spec.md §11](./spec.md#11-open-questions-must-be-locked-before-implementation).

### Universal type conventions (inherited from 003)

| Concern | Type | Binding |
|---|---|---|
| Primary key | `uuid NOT NULL DEFAULT gen_random_uuid()` | UUIDv7 preferred; UUIDv4 fallback |
| Timestamps | `timestamptz NOT NULL DEFAULT now()` | UTC storage; §X |
| Soft-delete | `retired_at timestamptz NULL` | `NULL` = active (mirrors 003) |
| Tenant scope | `tenant_id uuid NOT NULL` FK → `tenants(id)` | §II — all tenant-owned rows |
| Actor | `*_by uuid` | §XII/§XIII — never body-supplied; resolved from principal |
| Correlation ID | `correlation_id uuid NULL` | §XIII — linked to audit event |

### RLS context variables (from Feature 001)

- `app.current_tenant` (`uuid`) — set by the API tenant-context middleware.

The runtime DB role must not have `BYPASSRLS` (§II). This table is **tenant-axis
only** (no store axis — see §6); it does not use `app.current_store`.

---

## 2. Entity: `erpnext_item_map`

### Purpose and source-of-truth role

One row per `(tenant_id, tenant_product_id)` recording the ERPNext Item that
tenant product resolves to, and the **suggest → confirm** state of that mapping.
A Tenant Admin confirms a suggested match before it becomes usable (OQ-7). The
posting path (015) reads **confirmed** rows lazily at posting time (OQ-8); an
absent or unconfirmed mapping → fails-to-DLQ (posting decision §5). Population is
the suggest/confirm flow — **there is no import worker** (OQ-8).

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. UUIDv7 preferred. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id** (`ON DELETE restrict`). Never body-supplied. [§II/§XII] |
| `tenant_product_id` | `uuid` | NOT NULL | — | **FK → tenant_products.id** (`ON DELETE restrict`). The DP2 product being mapped. [OQ-2] |
| `erpnext_item_ref` | `text` | NOT NULL | — | The ERPNext Item reference **in DP2 terms** (e.g. the ERPNext Item `name`/code as a string). **NO FK** — ERPNext is external, reached only via the connector; the reference is informational, version-independent (012 O-6). Length 1–140 by CHK. |
| `state` | `text` | NOT NULL | `'suggested'` | `'suggested'` \| `'confirmed'`. Only `'confirmed'` rows are resolvable (§3). [OQ-7] |
| `suggested_by` | `uuid` | NULL | `NULL` | Actor that recorded the suggestion (a user; or `NULL` when system-suggested by barcode/code match). [§XIII] |
| `suggested_at` | `timestamptz` | NOT NULL | `now()` | When the suggestion was recorded (UTC). |
| `suggestion_source` | `text` | NOT NULL | — | How the candidate was found: `'barcode'` \| `'item_code'` \| `'manual'`. Provenance for the match (auditable). CHK-constrained. |
| `confirmed_by` | `uuid` | NULL | `NULL` | **Tenant Admin** user that confirmed. NOT NULL exactly when `state = 'confirmed'` (paired CHK). Never body-supplied. [OQ-7/§XII] |
| `confirmed_at` | `timestamptz` | NULL | `NULL` | When confirmed (UTC). Paired with `confirmed_by`/`state` by CHK. |
| `version` | `integer` | NOT NULL | `1` | **Optimistic-concurrency token** (§III §4 below). Incremented on every update; `If-Match`/version-on-update at the API. |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete. `NULL` = active. Re-pointing a mapping retires the old row and inserts a new one (no in-place identity rewrite). |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Updated on every write. |
| `correlation_id` | `uuid` | NULL | `NULL` | Links the row change to its audit event. [§XIII] |

> **No** `store_id`, **no** UOM column, **no** price/price-list column, **no**
> ERPNext-doctype field columns — by the OQ-1/3/4 decisions and §6.

### Constraints

**PK**
- `(id)`

**Foreign keys**
- `FK erpnext_item_map_tenant_id → tenants(id)` — `ON DELETE restrict` (soft-delete, mirrors 003).
- `FK erpnext_item_map_tenant_product_id → tenant_products(id)` — `ON DELETE restrict` (a mapped product is not hard-deleted out from under its mapping).
- **No FK on `erpnext_item_ref`** — ERPNext is external (mirrors the 003 `source_global_product_id` no-FK rationale: never couple DP2 row lifecycle to an out-of-DP2 catalogue).

**Unique**
- `UQ_idx_erpnext_item_map_active` — `UNIQUE (tenant_id, tenant_product_id) WHERE retired_at IS NULL` — enforces **OQ-2 1:1**: at most one *active* mapping per tenant product. (Retired rows are allowed to accumulate as history, so the partial index is the correct form — mirrors 003's `WHERE retired_at IS NULL` partial uniques.)

**Check constraints**
- `CHK erpnext_item_map_state_valid`: `state IN ('suggested','confirmed')`
- `CHK erpnext_item_map_suggestion_source_valid`: `suggestion_source IN ('barcode','item_code','manual')`
- `CHK erpnext_item_map_item_ref_length`: `length(erpnext_item_ref) BETWEEN 1 AND 140`
- `CHK erpnext_item_map_confirmed_paired`: `(state = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL) OR (state = 'suggested' AND confirmed_by IS NULL AND confirmed_at IS NULL)` — **the confirmed-only invariant at the DB layer** (§3). A row cannot be `confirmed` without its confirm provenance, and cannot carry confirm provenance while `suggested`.
- `CHK erpnext_item_map_version_positive`: `version >= 1`

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `UQ_idx_erpnext_item_map_active` | `(tenant_id, tenant_product_id)` | `WHERE retired_at IS NULL` | The 1:1 active-mapping unique (above). Also the **posting-time resolution lookup** (OQ-8 lazy read by tenant + product). |
| `idx_erpnext_item_map_unconfirmed` | `(tenant_id, state)` | `WHERE state = 'suggested' AND retired_at IS NULL` | The Tenant-Admin review queue: list suggestions awaiting confirmation. |
| `idx_erpnext_item_map_item_ref` | `(tenant_id, erpnext_item_ref)` | `WHERE retired_at IS NULL` | Reverse lookup — which DP2 product(s) point at an ERPNext Item (reconciliation/audit). |

### Audit / provenance notes

Auditable events (§XIII): **suggest**, **confirm**, **re-point** (retire + new),
**retire**. Each carries the actor (`suggested_by`/`confirmed_by`), a
`correlation_id` from the request context, and the `suggestion_source`. Audit is
insert-only; corrections are new events, never edits to audit rows.

---

## 3. The confirmed-only resolution invariant

**A `suggested` (unconfirmed) mapping does NOT count as "mapped."**

Lazy posting-time resolution (OQ-8) resolves **only** against rows where
`state = 'confirmed' AND retired_at IS NULL`. A `tenant_product` whose only
mapping row is `suggested` is treated as **unmapped** → the sale line
**fails-to-DLQ** (posting decision §5), exactly as if no row existed.

This is the DB-level expression of OQ-7's **"no silent auto-trust"**: a
system-suggested barcode match (`suggestion_source = 'barcode'`,
`suggested_by IS NULL`) is inert until a Tenant Admin confirms it. The
`CHK erpnext_item_map_confirmed_paired` constraint makes it impossible to be
`confirmed` without recorded `confirmed_by` + `confirmed_at` provenance — so the
posting path can never silently post against an unconfirmed auto-match.

> Mirrors the shipped 003/006/007 **unknown-items** "no silent create"
> discipline — but in the **outbound/posting** direction, kept distinct from the
> inbound unknown-items queue ([spec.md §8](./spec.md#8-relationship-to-the-shipped-unknown-items-workflow); OQ-6 still open).

---

## 4. Concurrency posture (§III)

`erpnext_item_map` is a **mutable tenant-owned resource** (`suggested → confirmed
→ possibly retired/re-pointed`). Constitution §III requires new mutable
tenant-owned resources to use **optimistic concurrency control** (a `version`
column + `If-Match` / version-on-update) **or** explicitly justify last-write-wins.

**Decision: optimistic concurrency via the `version` column.** Two admins could
review the same suggested mapping concurrently; confirming a stale view must not
silently clobber a concurrent re-point. The confirm/update API takes the
expected `version` (e.g. `If-Match`) and the update is
`... WHERE id = $1 AND version = $2`, incrementing `version`; a mismatch is a
`409 conflict` (canonical envelope). This is a deliberate divergence from the 003
catalog tables (which use last-write-wins without a `version` column): a
confirmation is an explicit trust action where a silent overwrite is
unacceptable, so LWW is **not** justified here.

---

## 5. RLS policy summary

`erpnext_item_map` is tenant-scoped; RLS uses `app.current_tenant` (Feature 001
GUC), fail-closed (`current_setting('app.current_tenant', true)::uuid`).

| Policy | Command | Using | Check |
|---|---|---|---|
| `erpnext_item_map_tenant_isolation` | `SELECT` | `tenant_id = current_setting('app.current_tenant', true)::uuid` | — |
| `erpnext_item_map_tenant_write` | `INSERT, UPDATE, DELETE` | `tenant_id = current_setting('app.current_tenant', true)::uuid` | `tenant_id = current_setting('app.current_tenant', true)::uuid` |

Cross-tenant access returns a safe non-disclosing **404** (§II/§XII) — never a
permission error that reveals whether a mapping exists. The future model slice
MUST add: an **RLS-bypass probe** (raw SQL with the wrong tenant → zero rows), a
**cross-tenant sweep**, and a **cross-store sweep** (vacuously, since no store
axis — assert the table is correctly tenant-only) per §VI.

---

## 6. Relationships & cross-entity notes

- **`tenant_products` (003)** — the FK parent. The mapping reads it; it never
  writes or mutates it (§IX authority stays with the catalog).
- **`product_aliases` (003)** — the barcode/code source the **suggestion** step
  reads to propose a candidate ERPNext Item match (`suggestion_source =
  'barcode'`/`'item_code'`). 013 does **not** move alias authority out of 003;
  it only reads aliases to suggest. No schema change to `product_aliases`.
- **No store axis.** A tenant↔Item identity mapping is tenant-wide; store-level
  divergence (sellability, price) is a 003 Store-Override concern and a
  posting-behavior question (OQ-5), not an identity-table column. If a genuine
  per-store Item mapping need surfaces later, it is a separate `[GATED]` change
  with its own justification — not assumed here.
- **ERPNext Item** — referenced as an opaque DP2-terms string (`erpnext_item_ref`),
  no FK, resolved to the live doctype by the connector (012 O-6). The ERPNext
  **major is UNCONFIRMED** (assumption A-1); the text reference is deliberately
  version-independent.

---

## 7. Open questions still deferred

These are **posting-behavior** questions (015 + the resolution slice), not
table-structure questions — confirmed during this data-model design that none
of them requires a column on `erpnext_item_map`:

| OQ | Question | Status after this design |
|---|---|---|
| **OQ-3** | UOM conversion | **No column** — connector-internal / 015 against the ERPNext Item UOM. **Stays open** for 015 (exactness §III enforced there). |
| **OQ-4** | Price-list ref vs explicit DP2 amounts | **No column** — §IX-forced: DP2 amounts authoritative (posting decision §4). **Resolved as "no pricing on this table"**; any posting-time pricing detail is a 015 concern. |
| **OQ-5** | Sellable-state divergence (DP2 vs ERPNext Item disabled) | Posting-resolution concern (does a disabled Item block resolution?). **Stays open** for the resolution slice — not a column here. |
| **OQ-6** | Relationship to the 003 unknown-items queue | Workflow concern. **Stays open**; §3 keeps the two mechanisms distinct at the data layer. |

> Per the plan's open-question gate: locking OQ-3/OQ-4 meant deciding **whether
> they need a column** — they do not. They remain behavioral decisions for 015.
> Under-locking is correct: the data-model's job is the table, not 015's posting
> semantics.

---

## 8. Constitution Check (data-model level)

| Principle | Verdict |
|---|---|
| **§II Multi-tenant RLS** | ✅ `tenant_id` NOT NULL + FK; fail-closed RLS on `app.current_tenant`; safe-404 cross-tenant; RLS-bypass probe + sweeps required in the model slice (§5). |
| **§III Backend authority & concurrency** | ✅ **Optimistic concurrency** via `version` (§4) — deliberate divergence from 003 LWW, justified (confirmation is a trust action). Identity-only table; no money column (DP2 amounts authoritative, §IX). |
| **§IV Contract-first** | ✅ The suggest/confirm review surface ships as a `[GATED]` 013-CONTRACT (its own slice); no raw entity in responses (a `toBody()` projection). |
| **§VIII Reproducible releases** | ✅ This doc authors **no** schema/migration — the table + `0017`-or-next migration (with paired `*.down.sql`, lock-duration review) is a separate `[GATED]` slice. |
| **§IX Source-of-truth** | ✅ Identity-mapping only; `tenant_products` stays authoritative; ERPNext owns accounting Item identity; **no override** (OQ-1). |
| **§XI Idempotency** | ✅ Confirm is idempotent via `version` (replay with the same version is a no-op/409, not a double-confirm); posting-time resolution reuses sale `sourceSystem+externalId` (012 O-1/O-3). |
| **§XII Object safety** | ✅ `tenant_id`/`confirmed_by`/`suggested_by` never body-supplied (resolved from principal); strict DTOs; the confirm command DTO omits security fields. |
| **§XIII Auditability & provenance** | ✅ suggest/confirm/re-point/retire are audited; `suggestion_source` + confirm provenance recorded; insert-only audit. |

**Result: PASS.** No principle violated. The one deliberate divergence
(optimistic concurrency vs 003's LWW) is justified per §III, not silent.

**Complexity Tracking:** one new table, standard `[GATED]` treatment. No
complexity exception to justify.

---

## Next step

This design → its own **`[GATED]` schema slice** (author the Drizzle schema
`packages/db/src/schema/catalog/erpnext-item-map.ts` + the migration, next
available number at authoring — `0017` indicatively — with paired `*.down.sql`),
and the **`[GATED]` 013-CONTRACT** for the suggest/confirm review surface. Both
are separate approval slices. Before them, `tasks.md` + `execution-map.yaml`
sequence the work. OQ-5/OQ-6 (and OQ-3 behavior) lock with the resolution slice
alongside 015.
