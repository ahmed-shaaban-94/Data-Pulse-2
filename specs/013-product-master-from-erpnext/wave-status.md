# Wave Status — `013-product-master-from-erpnext`

> Human-readable summary of where the spec stands. **013 is a docs-only
> planning spec** — it has **no `execution-map.yaml` and no dispatchable code
> slices** (same shape as 011 and 012). Its deliverable is a spec + a
> mapping-concepts catalogue. The "next move" is owner review of the spec +
> the open questions, then 013's own planning chain (`plan.md` → …) — not a
> slice dispatch.

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `013-product-master-from-erpnext` (`specs/013-product-master-from-erpnext/`)
**Base:** `origin/main` at `74aaa44`
**Status:** Authored — **not committed/pushed** (stop-before-commit per the brief)
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
| `plan.md` | **Plan (REVISED 2026-06-04 after OQ-1/2/7/8 locked)**: full Constitution Check (§IX **RESOLVED** — mapping/reconciliation, no ADR) + Architecture Impact Map (Impact: **None** for this docs PR; gates now **firm forward references**) + filled Technical Context / Storage / **concrete Project Structure**. Records the committed design: new `[GATED]` DP2 mapping table + `[GATED]` 013-CONTRACT review surface, lazy posting-time resolution, **no worker** | Authored |
| `wave-status.md` | This file | Authored |

> Deliberately **NOT** created (later gated steps): `data-model.md`, `tasks.md`,
> `execution-map.yaml`, any OpenAPI YAML, any schema/migration. `plan.md` is now
> **complete** — OQ-1/2/7/8 are locked (owner, 2026-06-04), so Technical Context,
> Storage, and a concrete Project Structure are filled. The next artifact is the
> `[GATED]` **`data-model.md`** for the new mapping table. `research.md` is not
> needed (design resolved as owner decisions, not open research — mirrors how
> 011/012 used signed decision records).

---

## Merged on `main`

_None._ (Authored on `docs/013-product-master-planning` off `origin/main@74aaa44`;
not committed or pushed — stop-before-commit per the brief.)

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `013-SETUP` (docs) | `docs/013-product-master-planning` | _(uncommitted)_ | Planning spec + mapping-concepts + revised `plan.md` (OQ-1/2/7/8 locked) authored off `origin/main@74aaa44`; no commit (brief stop condition). |

---

## Active findings

_None._

---

## Blocked

| What | Blocked by | Notes |
|---|---|---|
| 013 implementation (any schema, contract, resolution code) | `data-model.md` → `tasks.md` → `execution-map.yaml` not authored yet | `spec.md` + `plan.md` are done (OQ-1/2/7/8 locked). depends_on (012) and gated_by (posting decision) are both **satisfied**; §IX is **resolved**. The remaining block is the rest of 013's planning chain (data-model → tasks → map), then the `[GATED]` schema/contract approval slices. |

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
| **OQ-3/4/5/6** posting-detail | ⏳ open — locked during the data-model / resolution slices |
| **assumption**: ERPNext major confirmed | ⏳ UNCONFIRMED — baseline v15, final major confirmed in 012 staging validation (do not assume v15 as implementation truth) |

---

## Ready / approved — next to dispatch

_None (docs-only planning; no code slices)._

---

## Proposed (awaiting approval)

The 013 follow-up slices (see [spec.md §13](./spec.md)) — all proposals, none
green-lit, each runs its own planning chain:

- **013-PLAN** — ✅ **complete** (`plan.md`, OQ-1/2/7/8 locked; §IX resolved).
- **013-MAPPING-MODEL** — **NEXT.** `data-model.md` for the new `[GATED]`
  `erpnext-item-map` table (1:1, suggest/confirm state, provenance, RLS); locks OQ-3/4.
- **013-CONTRACT** — **required** (OQ-7 suggest/confirm review surface; `[GATED]` OpenAPI, §IV).
- **013-RESOLVE** — posting-time resolution (sale line → ERPNext Item; unmapped → DLQ), sequenced with 015.

Downstream arc unchanged: 013 → 014 (warehouse) → 015 (sale posting) → 016 (tax) → 017 (sync-ops).

---

## Next recommended action

`spec.md` + `mapping-concepts.md` + `plan.md` are all authored, and the
structure-gating questions are **locked** (OQ-1 mapping/reconciliation, OQ-2
1:1, OQ-7 suggest-then-confirm, OQ-8 lazy/no-worker). §IX is **resolved** — no
ADR needed. The committed design: a new `[GATED]` DP2 `erpnext-item-map` table +
a `[GATED]` 013-CONTRACT review surface, lazy posting-time resolution, no worker.

The next artifact is the **`[GATED]` `data-model.md`** for the mapping table —
which also locks the posting-detail questions it needs (OQ-3 UOM, OQ-4 pricing):

```text
Use Agent OS. Author 013 data-model.md — the [GATED] erpnext-item-map mapping
table (1:1 tenant_product↔Item, suggest/confirm state, provenance, RLS), and
lock OQ-3/OQ-4. Docs-only ([GATED] schema design, no migration authored yet).
Stop before commit.
```

After `data-model.md` is accepted: `tasks.md` → `execution-map.yaml`, then the
`[GATED]` schema/migration + 013-CONTRACT approval slices become dispatchable.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
CI, connector, POS, or Console file changed. **No runtime behavior changed.**
This PR (when committed) adds the `specs/013-product-master-from-erpnext/`
documentation set (`spec.md`, `mapping-concepts.md`, `plan.md`, this
`wave-status.md`) and nothing else.
