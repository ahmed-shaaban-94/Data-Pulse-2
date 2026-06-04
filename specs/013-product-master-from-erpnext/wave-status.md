# Wave Status — `013-product-master-from-erpnext`

> Human-readable summary of where the spec stands. The 013 **planning chain is
> complete** (spec → plan → data-model → tasks → **execution-map**). The map now
> defines dispatchable slices, but **authoring it does NOT authorize the first
> dispatch** — the first slice touching `packages/db` / `packages/contracts/openapi`
> / `apps/api` is a threshold the owner crosses explicitly. The two foundational
> slices (CONTRACT, SCHEMA) are `[GATED]` + `proposed`.

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `013-product-master-from-erpnext` (`specs/013-product-master-from-erpnext/`)
**Base:** `origin/main` at `76d2768` (spec+plan #484, data-model #485 both merged)
**Status:** spec+plan+data-model **MERGED** (#484/#485); `tasks.md` + `execution-map.yaml` authored on `docs/013-tasks-execmap` — **not committed/pushed** (stop-before-commit)
**Active finding(s):** 1 — `AUTO_MATCH_NO_SOURCE` (medium; non-blocking — v1 manual-only)

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
| `data-model.md` | **`[GATED]` design** of `erpnext_item_map`: 1:1, no-FK version-independent ref, **confirmed-only invariant**, **optimistic `version`** (§III), RLS, no UOM/price/store column | **Merged** (#485) |
| `tasks.md` | Ordered task list (T001–T091 + T050-as-015): SIGN-OFF → `[GATED]` CONTRACT + SCHEMA → ISOLATION → US1 manual map → US2 re-point → polish. Manual-only suggest; AUTO_MATCH_NO_SOURCE finding | **Authored (this slice)** |
| `execution-map.yaml` | Dispatch map: 8 slices + the `AUTO_MATCH_NO_SOURCE` finding + a proposed `013-FOUNDATIONAL-GATED` parallel group. Conforms to `slice-schema.yaml` | **Authored (this slice)** |
| `wave-status.md` | This file | Authored |

> `spec.md` / `mapping-concepts.md` / `plan.md` (#484) + `data-model.md` (#485) are
> **merged on `main`**. This slice (`docs/013-tasks-execmap`) adds **`tasks.md` +
> `execution-map.yaml`** — the 013 planning chain is now **complete**. Still **NOT**
> created (the actual `[GATED]` surfaces): any OpenAPI YAML, any Drizzle schema /
> SQL migration, any app code. Those are the dispatchable slices the map defines —
> each its own approval slice, none authorized by this docs PR.

---

## Merged on `main`

| Slice | Files | PR / commit | Merged |
|---|---|---|---|
| `013-SETUP` (docs) | `spec.md`, `mapping-concepts.md`, `plan.md`, `wave-status.md` | **#484** (`afd3da2`) | 2026-06-04 |
| `013-MAPPING-MODEL` (docs) | `data-model.md` (+ sync edits) | **#485** (`b989b18`) | 2026-06-04 |

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `013-TASKS-MAP` (docs) | `docs/013-tasks-execmap` | _(uncommitted)_ | `tasks.md` + `execution-map.yaml` authored off `origin/main@76d2768`; completes the 013 planning chain. No code/schema/contract authored. No commit (stop-before-commit). |

---

## Active findings

| ID | Severity | Summary | Blocks |
|---|---|---|---|
| `AUTO_MATCH_NO_SOURCE` | medium | The data-model's `suggestion_source` includes `barcode`/`item_code`, but 012 `posting-feed.yaml` has only the posting ops — **no ERPNext item-search op** DP2→ERPNext, and OQ-8 forbids an import worker. **v1 is manual-only** (`suggestion_source='manual'`); auto-match deferred to a future `[GATED]` 012 item-search extension. | _Nothing in v1_ — the manual path is complete on its own. |

---

## Blocked

| What | Blocked by | Notes |
|---|---|---|
| 013 implementation slices (CONTRACT, SCHEMA, CRUD, …) | owner has not authorized the first dispatch | The planning chain is **complete** (spec→plan→data-model→tasks→map, all docs). depends_on (012) + gated_by (posting decision) **satisfied**; §IX **resolved**. The map's `013-CONTRACT` + `013-SCHEMA` are `[GATED]` + `proposed` — **authoring the map does not authorize them**; the owner crosses that threshold explicitly per slice. `013-SETUP`/`013-SIGNOFF-MANUAL` are `ready` by dependency. `013-RESOLVE` is `proposed` and **not dispatchable** (belongs to the future 015 spec). |

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

Per the [execution-map](./execution-map.yaml) — `ready` by dependency, but the
owner has **not** authorized the first dispatch:

- **013-SIGNOFF-MANUAL** (T001/T002, `ready`) — record the manual-only + no-worker decisions (docs).
- **013-SETUP** (T003, `ready` after SIGNOFF) — scaffold the empty `apps/api` module.

The first **`[GATED]`** slices (`013-CONTRACT`, `013-SCHEMA`) are `proposed` — they
need explicit in-session approval before any dispatch.

---

## Proposed (awaiting approval)

Per the [execution-map](./execution-map.yaml):

- **013-CONTRACT** `[GATED]` `proposed` — suggest/confirm review OpenAPI (**Clerk-JWT human auth**, NOT connectorBearer/posDeviceAuth); manual-only.
- **013-SCHEMA** `[GATED]` `proposed` — `erpnext_item_map` Drizzle + migration (`0017` indicative; 1:1 partial-unique + confirmed-only CHECK + RLS).
- **013-FOUNDATIONAL-GATED** (group, `proposed`) — CONTRACT + SCHEMA may run in parallel (disjoint surfaces); needs approval of **both**.
- **013-ISOLATION-HARNESS / 013-CRUD / 013-REPOINT / 013-POLISH** — `blocked` on their predecessors.
- **013-RESOLVE** — `proposed`, depends on a **future 015 slice**; **not dispatchable** from this map (posting-time read belongs to 015; OQ-5/6 lock there).

Downstream arc unchanged: 013 → 014 (warehouse) → 015 (sale posting) → 016 (tax) → 017 (sync-ops).

---

## Next recommended action

The **013 planning chain is complete** — `spec.md` + `plan.md` (#484) +
`data-model.md` (#485) are merged; `tasks.md` + `execution-map.yaml` are authored
(this slice). Once they merge, 013 has a full dispatchable map.

The next move is the **owner's call to begin implementation** — the first real
code/schema/contract threshold. The recommended first dispatch is the two
foundational `[GATED]` slices (after the trivial SIGNOFF + SETUP):

```text
Use Agent OS. Execute slice 013-SCHEMA. Stop before commit.
```
```text
Use Agent OS. Execute slice 013-CONTRACT. Stop before commit.
```

Each is `[GATED]` — dispatching it is an explicit in-session approval of that
forbidden surface (`packages/db/**` / `packages/contracts/openapi/**`). They are
parallel-safe (disjoint surfaces) but each needs its own approval. `013-CRUD`
(the manual suggest→confirm MVP) unblocks once both + the isolation harness land.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
CI, connector, POS, or Console file changed. **No runtime behavior changed.**
This slice (when committed) adds **`tasks.md` + `execution-map.yaml`** and updates
this `wave-status.md` under `specs/013-product-master-from-erpnext/` — nothing
else. The `execution-map.yaml` **defines** dispatchable slices (including the two
`[GATED]` ones) but **authorizes none of them** — the actual schema, migration,
OpenAPI YAML, and app code are authored only when the owner dispatches each
`[GATED]`/ready slice explicitly.
