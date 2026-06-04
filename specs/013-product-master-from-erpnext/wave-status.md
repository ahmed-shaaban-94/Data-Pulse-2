# Wave Status — `013-product-master-from-erpnext`

> Human-readable summary of where the spec stands. **013 is a docs-only
> planning spec** — it has **no `execution-map.yaml` and no dispatchable code
> slices** (same shape as 011 and 012). Its deliverable is a spec + a
> mapping-concepts catalogue. The "next move" is owner review of the spec +
> the open questions, then 013's own planning chain (`plan.md` → …) — not a
> slice dispatch.

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `013-product-master-from-erpnext` (`specs/013-product-master-from-erpnext/`)
**Base:** `origin/main` at `20e4817` (spec+plan merged via #484)
**Status:** spec+plan **MERGED** (#484); `data-model.md` authored on `docs/013-data-model` — **not committed/pushed** (stop-before-commit)
**Active finding(s):** 0

---

## TL;DR

013 plans the **product-master mapping** between Data-Pulse-2's 003 Tenant
Catalog and ERPNext, so a future sale posting (015) can resolve each DP2 sale
line to a real ERPNext **Item** (posting decision §1; the "fails-to-DLQ if not"
obligation). The crux is the **source-of-truth split**: 013 is a
**mapping/reconciliation layer, NOT a handover of catalog authority** — the
§IX Tenant Catalog stays authoritative for the retail/operational product
view; ERPNext owns **accounting Item identity** only. This mirrors the signed
stock-impact split (two authorities, reconciled by correlation, never merged).
It enumerates the seven mapping concepts (ERPNext Item, Barcode, UOM, Price
List reference, active/sellable state, provenance, unmapped-item case),
explicitly distinguishes the unmapped-item case from the shipped
003/006/007 **unknown-items** queue, and records the ERPNext-version-unconfirmed
assumption (baseline v15, final major confirmed in 012/staging — **not** assumed
as implementation truth). **Docs/planning only**: no code, schema, migration,
OpenAPI YAML, package/lockfile, CI, connector, POS, or Console change. No
runtime behavior changes.

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Planning spec: purpose, boundaries, the §IX mapping/reconciliation split, the seven mapping concepts, unknown-items distinction, dependencies/gates, explicit assumptions, open questions, Constitution Check, follow-up proposals, acceptance criteria | Authored |
| `mapping-concepts.md` | Concept catalogue: what each of the seven concepts links, which side is authoritative, what stays open | Authored |
| `plan.md` | **Plan** (OQ-1/2/7/8 locked): Constitution Check (§IX **RESOLVED**) + Architecture Impact Map + Technical Context / Storage / concrete Project Structure. Committed design: new `[GATED]` DP2 mapping table + `[GATED]` 013-CONTRACT review surface, lazy posting-time resolution, **no worker** | **Merged** (#484) |
| `data-model.md` | **`[GATED]` design** of the new `erpnext_item_map` identity table: 1:1 `(tenant_id, tenant_product_id)` → `erpnext_item_ref` (no FK, version-independent); `state` suggested\|confirmed + **confirmed-only resolution invariant**; **optimistic `version`** concurrency (§III, deliberate divergence from 003 LWW, justified); RLS by `app.current_tenant`; **no UOM / no price column** (OQ-3/OQ-4 resolved as no-column) | **Authored (this slice)** |
| `wave-status.md` | This file | Authored |

> `spec.md` / `mapping-concepts.md` / `plan.md` are **merged on `main`** (PR #484,
> `afd3da2`). This slice (`docs/013-data-model`) adds **`data-model.md`** only.
> Still **NOT** created (later gated steps): `tasks.md`, `execution-map.yaml`, any
> OpenAPI YAML, any Drizzle schema / SQL migration. The data-model carries the
> `[GATED]` marker because it designs a new table + migration — those land in
> their own approval slice after this design is accepted. `research.md` is not
> needed (design resolved as owner decisions, mirroring 011/012's signed records).

---

## Merged on `main`

| Slice | Files | PR / commit | Merged |
|---|---|---|---|
| `013-SETUP` (docs) | `spec.md`, `mapping-concepts.md`, `plan.md`, `wave-status.md` | **#484** (`afd3da2`) | 2026-06-04 |

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `013-MAPPING-MODEL` (docs, `[GATED]` design) | `docs/013-data-model` | _(uncommitted)_ | `data-model.md` authored off `origin/main@20e4817`; designs the new `erpnext_item_map` table (no schema/migration authored). No commit (stop-before-commit). |

---

## Active findings

_None._

---

## Blocked

| What | Blocked by | Notes |
|---|---|---|
| 013 implementation (schema, contract, resolution code) | `tasks.md` → `execution-map.yaml` not authored yet | `spec.md` + `plan.md` (merged #484) + `data-model.md` (this slice) are done. depends_on (012) and gated_by (posting decision) are **satisfied**; §IX **resolved**. Remaining block: `tasks.md` → `execution-map.yaml`, then the `[GATED]` schema slice + `[GATED]` 013-CONTRACT + resolution slice. |

---

## Dependencies & gates (satisfied)

| Gate | State |
|---|---|
| **depends_on**: 012-erpnext-connector-contracts merged | ✅ MERGED (#476 / #479 / #481 / #482) |
| **gated_by**: posting decision (011-DR-POSTING) SIGNED | ✅ SIGNED 2026-06-03 (011 gate SATISFIED) |
| **OQ-1** source-of-truth (§IX) | ✅ LOCKED — mapping/reconciliation (no ADR; §IX satisfied) |
| **OQ-2** cardinality | ✅ LOCKED — 1:1 `(tenant_id, tenant_product_id)` |
| **OQ-7** lifecycle | ✅ LOCKED — suggest-then-confirm (→ DP2 table + `[GATED]` 013-CONTRACT) |
| **OQ-8** direction | ✅ LOCKED — lazy resolution, **no import worker** |
| **OQ-3** UOM / **OQ-4** pricing | ✅ resolved at data-model — **no column** (UOM → connector/015; pricing → §IX-forced off-table); stay 015 behavioral decisions |
| **OQ-5/6** posting-detail | ⏳ open — locked during the resolution slice (with 015) |
| **assumption**: ERPNext major confirmed | ⏳ UNCONFIRMED — baseline v15, final major confirmed in 012 staging validation (do not assume v15 as implementation truth) |

---

## Ready / approved — next to dispatch

_None (docs-only planning; no code slices)._

---

## Proposed (awaiting approval)

The 013 follow-up slices (see [spec.md §13](./spec.md)) — all proposals, none
green-lit, each runs its own planning chain:

- **013-PLAN** — ✅ **merged** (`plan.md`, #484).
- **013-MAPPING-MODEL** — ✅ **authored** (`data-model.md`, this slice; OQ-3/4 resolved as no-column).
- **013-MAPPING-SCHEMA** — **NEXT `[GATED]`.** Drizzle schema + migration for `erpnext_item_map` (its own approval slice).
- **013-CONTRACT** — **required** (OQ-7 suggest/confirm review surface; `[GATED]` OpenAPI, §IV).
- **013-RESOLVE** — posting-time resolution (confirmed-only; unmapped → DLQ), sequenced with 015; locks OQ-5/6 (+ OQ-3 behavior).

Downstream arc unchanged: 013 → 014 (warehouse) → 015 (sale posting) → 016 (tax) → 017 (sync-ops).

---

## Next recommended action

`spec.md` + `plan.md` are **merged** (#484); **`data-model.md` is now authored**
(this slice) — the `[GATED]` `erpnext_item_map` identity table: 1:1
`(tenant_id, tenant_product_id)` → `erpnext_item_ref` (no FK, version-independent);
`state` suggested\|confirmed with the **confirmed-only resolution invariant**;
**optimistic `version`** concurrency (§III); RLS by `app.current_tenant`; **no
UOM / no price column** (OQ-3/OQ-4 resolved as no-column).

Once `data-model.md` is reviewed/merged, the next step is to **sequence the
gated slices** — `tasks.md` + `execution-map.yaml`:

```text
Use Agent OS. Author 013 tasks.md + execution-map.yaml — sequence the [GATED]
schema slice (erpnext-item-map), the [GATED] 013-CONTRACT, and the resolution
slice from the authored data-model. Docs-only. Stop before commit.
```

Then the `[GATED]` Drizzle schema + migration and the `[GATED]` 013-CONTRACT
become dispatchable approval slices. OQ-5/6 (and OQ-3 behavior) lock with the
resolution slice alongside 015.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
CI, connector, POS, or Console file changed. **No runtime behavior changed.**
This slice (when committed) adds **`data-model.md`** and updates this
`wave-status.md` (plus a sync note in `spec.md` §11 and `plan.md`'s open-question
table / next-step) under `specs/013-product-master-from-erpnext/` — nothing else.
The `data-model.md` carries the `[GATED]` marker because it **designs** a new
table + migration, but **authors no schema or migration file**; those land in a
separate `[GATED]` approval slice after this design is accepted.
