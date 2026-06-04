# Implementation Plan: Branch Inventory Reconciliation & Warehouse Mapping

**Branch**: `docs/014-spec` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-branch-inventory-reconciliation-and-warehouse-mapping/spec.md`

> **Decision-gated plan — the open questions were answered by the owner
> (2026-06-04).** This is a **docs-only planning artifact**. It records the
> approach, the full Constitution Check, the Architecture Impact Map, and — now
> that the structure-gating OQs are locked — the Technical Context, Storage, and
> Project Structure.
>
> **Answered (owner, 2026-06-04):**
> - **OQ-1 + OQ-5 (collapsed)** = **No ERPNext-quantity mirror in DP2.** 014
>   stores only the store↔warehouse mapping + the mismatch vocabulary; the
>   fetch-ERPNext-Bin-and-compare is **017's machinery** (the [spec §8](./spec.md#8-the-014--017-reconciliation-boundary-the-carve)
>   carve: 014 = mapping + *meaning* of reconciliation; 017 = *machinery*). A
>   standing DP2 table of ERPNext stock quantities is precisely the artifact a
>   reader would mistake for the **rejected read-down** — so it is not built.
> - **OQ-2** = **1:1 for v1** (`store ↔ ERPNext Warehouse`, the signed default),
>   **but designed to widen** to *warehouse-by-purpose* later. **Owner forward
>   intent (verbatim):** *"1 for one but in future it can be one WH for stock and
>   one for expired product which would return to producer."* So v1 maps one
>   sellable/stock warehouse per store, and the v1 schema MUST NOT preclude a
>   later second row per store keyed by **purpose** (e.g. `stock` vs
>   `returns/expired`). See OQ-2 forward-compat note below.
> - **OQ-3** = **Manual admin-set** (a Tenant Admin sets the mapping directly via
>   a `[GATED]` Console→DP2 contract). **NOT** 013's suggest-then-confirm — that
>   pattern exists because *items* are high-volume and need barcode/code matching;
>   *warehouses* are few per store and need no matching, so a candidate-suggestion
>   engine would over-build for a problem that doesn't exist.
> - **OQ-4** = **deferred** to the data-model / recon-def slice (the mismatch
>   classes + tolerance vocabulary — detail, the analogue of 013's OQ-3/4
>   resolved post-plan).
>
> Still docs-only: the table + contract are described as **future `[GATED]`
> slices**, not authored here.

---

## Summary

014 plans **branch-inventory reconciliation + warehouse mapping** between
Data-Pulse-2 and ERPNext, so ERPNext can **value** the same physical stock a DP2
store holds and the two ledgers can be **reconciled** — never merged. **The
authority question is closed by the signed stock-impact decision**
([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md)):
DP2 stays the **operational on-hand authority** (009 ledger); ERPNext owns
**valuation**; **read-down replacing DP2 availability is rejected**. 014's job is
fidelity to that decision, not re-deciding it.

**The committed design (OQs locked 2026-06-04):**

- **Mapping persistence** — a **new `[GATED]` DP2 table** (provisionally
  `erpnext_warehouse_map`), tenant-scoped (RLS), linking a `stores` row to an
  ERPNext **Warehouse** reference. v1 cardinality is **1:1** (one sellable/stock
  warehouse per store) but the grain is designed to widen to **warehouse-by-
  purpose** (OQ-2 forward intent).
- **No ERPNext-quantity mirror** (OQ-1/OQ-5) — 014 does **not** store ERPNext Bin
  quantities. The reconciliation *comparison* (DP2 009 on-hand vs ERPNext Bin) is
  **defined** here as vocabulary; **running** it (fetch + compare + report +
  repair) is **017's machinery**.
- **Reconciliation definition** — 014 owns *what* is compared (per
  `(tenant, store, item)`: 009 on-hand vs ERPNext Bin for the mapped warehouse +
  the 013-mapped item) and *what a mismatch is* (the class vocabulary). 017 owns
  the jobs/reports/repair API.
- **Population** — **manual admin-set** (OQ-3) via a **`[GATED]` 014-CONTRACT**
  review surface (Console → DP2 only; §IV). No suggest-engine, no import worker.
- **No worker, no outbox event** in 014 (the reconciliation jobs are 017).

The structure-gating questions are answered; the mismatch-vocabulary detail
(OQ-4) remains open for the data-model / recon-def slice.

---

## Technical Context

> **RESOLVED** for the structure-gating questions (OQ-1/2/3/5 locked 2026-06-04).
> The mismatch-vocabulary detail (OQ-4) is marked
> `NEEDS CLARIFICATION (data-model / recon-def slice)`. No code/schema is
> authored here; the table + contract below are future `[GATED]` slices.

**Language/Version**: TypeScript 5.x strict (repo standard). 014 adds DP2
runtime: a warehouse-mapping module (api) for the manual admin-set flow + the
reconciliation *definition* it exposes to 017. Persisted in DP2 — not
connector-resident — per §IX/§II (tenant-owned mapping data).

**Primary Dependencies**: NestJS 11, Drizzle ORM, Zod (repo standard). **No new
external dependency is authorized by 014** (assumption A-3); the ERPNext/Frappe
client is connector-only and a separate `[GATED]` `package.json` decision. 014
never holds a Frappe client; any ERPNext Bin read (017's job) goes via the
connector + 012 contract.

**Storage**: a **new `[GATED]` DP2 mapping table** (provisionally
`erpnext_warehouse_map`), tenant-scoped (RLS), linking `stores.id` → an ERPNext
Warehouse reference (DP2-terms string, **no FK** to ERPNext — version-independent,
012 O-6, mirroring 013's `erpnext_item_ref` no-FK rationale), plus **optimistic
`version`** for edits (§III, the justified divergence 013 established) and
provenance (set/updated by-whom/when, §XIII). **v1 cardinality 1:1 but
forward-compatible** — see the OQ-2 forward-compat note. **No ERPNext-quantity
mirror table** (OQ-1). Reads existing `stores` (001) + the 009 on-hand
(compute-on-read) + 013's `erpnext_item_map` (item correspondence) read-only.
**Designed in [data-model.md](./data-model.md); the schema + migration are
authored in the future `[GATED]` `014-SCHEMA` slice, not here.**

**Testing**: Jest + Supertest + Testcontainers (repo standard). For the new
mapping table: **RLS-bypass probe + cross-tenant sweep mandatory** (§VI;
tenant-only — no store-axis bypass since the table *is* keyed by store within
tenant); contract-conformance test for the 014-CONTRACT review surface;
optimistic-version 409 + idempotent set on the mapping (§XI). Scoped in the
model/contract slices.

**Target Platform**: Linux server (NestJS **api**). **No worker** in 014 — the
reconciliation jobs are 017; 014's population is the synchronous admin-set flow.

**Project Type**: web-service (NestJS api in the pnpm monorepo). New warehouse-
mapping module under `apps/api` + new schema under `packages/db`; review surface
under `packages/contracts/openapi`. Concrete tree in **Project Structure** below.

**Performance Goals**: no bulk path (manual admin-set + no mirror), so **no
per-tenant bulk-ingestion posture is required** for 014. Mapping reads are a
single indexed lookup per store; the admin-set flow is interactive. The
reconciliation *run* perf posture belongs to 017.

**Constraints**: Version-independence at the DP2 boundary (012 O-6, assumption
A-2) — the mapping stores a DP2-terms ERPNext Warehouse *reference*; the
connector resolves it to the live doctype. **ERPNext major UNCONFIRMED**
(assumption A-1 — do not assume v15). Quantity exactness for the reconciliation
comparison is preserved (no silent rounding/erasure of a divergence); the exact
mismatch classes + tolerance are `NEEDS CLARIFICATION (data-model / recon-def
slice)` pending OQ-4.

**Scale/Scope**: one mapping row per store per warehouse-purpose (v1: one
`stock` row per store); bounded by the tenant's store count. No cross-tenant
aggregate. ERPNext Bin quantities are never stored in DP2 (OQ-1).

---

## OQ-2 forward-compatibility note (warehouse-by-purpose)

The owner locked **1:1 for v1** but flagged a concrete future case: a store may
later map to **two** ERPNext warehouses — one for **sellable stock** and one for
**expired product returned to the producer**. v1 must not paint the schema into a
corner that forbids this.

**Design rule for the data-model slice (recorded, not schema'd here):**

- The mapping row carries a **`purpose`** (or `role`) discriminator — v1 only
  ever writes the single sellable/stock value (e.g. `purpose = 'stock'`).
- The active-uniqueness is on **`(tenant_id, store_id, purpose)`** (partial-
  unique `WHERE retired_at IS NULL`, mirroring 013), **not** bare
  `(tenant_id, store_id)`. v1 behaves exactly 1:1 (only one purpose exists), but a
  later slice can introduce a second purpose (`returns`/`expired`) **without a
  breaking migration**.
- Reconciliation + future posting (015) target the **sellable/stock** purpose;
  the returns/expired warehouse is a non-sellable destination, so it never drives
  POS/Console sellability (consistent with §IX operational authority staying DP2).

This keeps v1 strictly 1:1 in behavior while leaving the door open for the
owner's stated future, with no design debt.

---

## Constitution Check

*GATE: this PR is docs-only — the check is at design-intent level. A full
per-task re-check lands in the future `[GATED]` model/contract slices.*

The discriminating principle is **§IX**, and it is **already resolved by the
signed stock-impact decision** (not re-decided here): DP2 operational on-hand
authority + ERPNext valuation + reconcile-never-merge. 014's design is fidelity
to that signed split.

| Principle | Gate verdict |
|---|---|
| **§I Reference, not source of truth** | ✅ No ERPNext fork / core copy-paste. Bespoke ERPNext lives in the connector's thin custom Frappe app (version-pin §3), never forked into DP2. 014 holds no Frappe client. |
| **§II Multi-tenant RLS** | ✅ (design intent) The new mapping table is tenant-scoped; cross-tenant non-disclosure (404) + an RLS-bypass probe are mandatory and scoped to the model slice (§VI) — not weakened here. |
| **§III Backend authority & integrity** | ✅ DP2 operational on-hand (009) stays authoritative; the reconciliation comparison preserves quantity exactness and never silently reconciles a divergence away (OQ-4 vocabulary, data-model slice). Optimistic `version` on the mapping (the 013-established §III divergence). |
| **§IV Contract-first** | ✅ Connector is the only ERPNext edge; the manual-set review surface ships as a **`[GATED]` 014-CONTRACT** OpenAPI YAML first. DP2 owns the contracts. |
| **§IX Source-of-truth model** | ✅ **RESOLVED by the SIGNED stock-impact decision.** DP2 operational stock authority; ERPNext valuation; reconciled, never merged; **read-down rejected** ([spec §5](./spec.md#5-source-of-truth--the-operational-vs-accounting-split-signed-not-open)). Re-opening it = STOP-and-raise (§5.4). No new ADR required (the decision is already signed). |
| **§VIII Reproducible releases** | ✅ No `package.json`/lockfile/schema/migration change in **this** PR. The new mapping table + 014-CONTRACT are future **`[GATED]`** slices with paired rollback + lock review. ERPNext version pin stays an explicit **unconfirmed** assumption (A-1). |
| **§XI Idempotency & external IDs** | ✅ (design intent) The admin-set write is idempotent (replay-safe) + optimistic-version guarded; reconciliation matches on correlation IDs (stock-impact §5; the run is 017). |
| **§XIII Auditability & provenance** | ✅ (design intent) The mapping table carries tenant/store/warehouse-ref/purpose + set/updated-by-whom/when provenance; mismatches are traceable for 017 repair. |

**Constitution Check result:** **PASS.** No principle is violated; **§IX is
resolved by the signed decision** (014 is faithful to the operational-vs-
accounting split). The plan may proceed to a `data-model.md` / `[GATED]` model
slice; the mismatch-vocabulary detail (OQ-4) is locked there.

**Complexity Tracking:** No violations to justify (no code/schema authored in
this PR; the new table + contract are standard `[GATED]` slices, not complexity
exceptions). Notably, the OQ-1 decision **removes** complexity — no Bin-mirror
table, no refresh path.

---

## Architecture Impact Map

Per Constitution Working Agreement
([`.specify/memory/architecture-impact.md`](../../.specify/memory/architecture-impact.md)).

### Impact Classification

- Impact level: **None**
- Reason: **This PR is documentation-only** — it adds planning docs under
  `specs/014-branch-inventory-reconciliation-and-warehouse-mapping/` and moves
  **no** module, schema, contract, queue, dependency, or auth surface. The design
  is now *decided* (the new DP2 mapping table + 014-CONTRACT), but those are
  **future `[GATED]` slices**, not authored here — so the impact of *this* PR is
  `None`.
- Boundary crossings: API→Worker none · API→DB none · Worker→DB none · package
  boundary none · external provider none · OpenAPI/codegen none · runtime none.

> Per the architecture-impact rule's **"No architecture impact" exception**
> (`Impact level: None` with a non-empty reason), the gate checklist and
> dimension table MAY be omitted for this docs-only PR. They are retained below as
> **firm forward references** — the design is decided (OQs locked), so the future
> implementation's blast radius is **known, not conditional**.

### Triggered Review Gates — *firm forward reference (decided; triggered by the future `[GATED]` slices, NOT this docs PR)*

- [x] **DB read/write → RLS / tenant-context strategy** — **YES.** A new
      tenant-scoped DP2 mapping table (§II). Pointer (future, 014-SCHEMA +
      014-ISOLATION-HARNESS): RLS-bypass probe + cross-tenant sweep per the new table.
- [x] **OpenAPI / API contract change** — **YES** (manual-set review, §IV).
      Pointer (future, 014-CONTRACT): a `[GATED]` YAML under
      `packages/contracts/openapi/catalog/` (or a 014 namespace) + conformance spec.
- [ ] **Queue / job publish or consume** — **NO.** No worker in 014; the
      reconciliation jobs are **017**. No outbox event registered by 014.
- [ ] Auth / session / token change — **NO.** The admin-set flow uses the existing
      Tenant-Admin cookie session (`cookieAuth`/`DashboardAuthGuard`, the 013
      pattern); no new auth surface. Connector auth is the 012 machine scheme.
- [ ] **Package dependency change** — **NO**, not authorized by 014 (A-3). The
      ERPNext/Frappe client is connector-only + separately `[GATED]`.
- [x] **Cross-package or cross-app import** — **YES** (minor): the new `apps/api`
      mapping module imports the new `packages/db` schema (standard monorepo
      boundary, as 003/009/013 do).
- [ ] External provider integration — **NO** for DP2: ERPNext is reached **only**
      via the connector (§IV, 011 boundaries); 014 itself integrates no external
      provider directly. (017's reconciliation run reads ERPNext Bin via the
      connector — that is 017's gate, not 014's.)

### Required dimensions — *firm forward reference (for the future implementation slices)*

| Dimension | This docs-only PR | Decided impact (future `[GATED]` slices) |
|---|---|---|
| Affected modules / packages | none | new `apps/api` warehouse-mapping module + new `packages/db` schema + `packages/contracts/openapi` review surface |
| DB tables read | none | `stores` (001), `stock_movements` (009, on-hand), `erpnext_item_map` (013) — read-only |
| DB tables written | none | **new `[GATED]` `erpnext_warehouse_map`**, partial-unique `(tenant_id, store_id, purpose) WHERE retired_at IS NULL` (OQ-2 forward-compat) |
| APIs / OpenAPI contracts changed | none | **new `[GATED]` 014-CONTRACT** — manual warehouse-map set/list/retire (OQ-3) |
| Events / jobs published | none | **none** (no worker; reconciliation jobs are 017) |
| Events / jobs consumed | none | none |
| Files likely to require edits | only `specs/014-…/**` | `apps/api/src/<warehouse-map-module>/**`, `packages/db/src/schema/catalog/erpnext-warehouse-map.ts` + migration, `packages/contracts/openapi/**`, new test suites |
| Risky dependencies / boundary concerns | none | **no Bin-mirror table** (OQ-1) — avoids the read-down look-alike; no new DP2 dep (A-3) |
| Regression test areas | none | 001 stores + 009 ledger suites (read-only); RLS-bypass + cross-tenant sweep for the new table; 014-CONTRACT conformance |

---

## Project Structure

### Documentation (this feature)

```text
specs/014-branch-inventory-reconciliation-and-warehouse-mapping/
├── spec.md             # Planning spec (authored)
├── plan.md             # This file (decision-gated plan)
├── checklists/
│   └── requirements.md # Spec quality checklist (authored)
├── data-model.md       # NEXT — the new mapping table ([GATED]) + mismatch vocab, pending OQ-4
└── tasks.md            # LATER — /speckit-tasks after data-model
```

> `research.md` is not needed as a separate artifact: the design questions were
> resolved as owner decisions (OQ-1/2/3/5) + the signed stock-impact decision,
> not open research — mirroring how 011/012/013 captured decisions in records,
> not a `research.md`.

### Source Code (repository root) — *scoped, NOT authored by this plan*

> The tree below is the **decided** target for the future `[GATED]` slices. **No
> source file is created by this docs-only plan.** Concrete names settle in the
> model/contract slices.

```text
apps/api/src/
└── catalog/
    └── erpnext-warehouse-map/        # NEW module — manual admin-set + reconciliation definition
        ├── erpnext-warehouse-map.controller.ts   # 014-CONTRACT review ops (set/list/retire)
        ├── erpnext-warehouse-map.service.ts       # mapping CRUD, optimistic version, RLS
        └── erpnext-warehouse-map.module.ts

packages/db/src/schema/
└── catalog/
    └── erpnext-warehouse-map.ts      # NEW [GATED] table: partial-unique
                                       #   (tenant_id, store_id, purpose) WHERE retired_at IS NULL
                                       #   → erpnext_warehouse_ref + version + provenance
                                       #   (NO ERPNext-quantity mirror — OQ-1)
packages/db/drizzle/
└── 00NN_erpnext_warehouse_map.sql    # NEW [GATED] migration (+ paired *.down.sql), RLS policies

packages/contracts/openapi/
└── catalog/
    └── erpnext-warehouse-map.yaml     # NEW [GATED] 014-CONTRACT — manual set/list/retire (cookieAuth)

apps/api/test/catalog/erpnext-warehouse-map/   # NEW — RLS-bypass probe, cross-tenant sweep,
                                               #   optimistic-version, contract conformance
```

**Structure Decision**: 014 adds a DP2 **api module**
(`catalog/erpnext-warehouse-map`) backed by a new **`[GATED]` `packages/db` table
+ migration** and a **`[GATED]` 014-CONTRACT** manual-set review surface. **No
worker, no Bin-mirror table** (the reconciliation *run* + any ERPNext-quantity
read is 017). Each `[GATED]` artifact is its own approval slice (§VIII / standing
rules §3); none is authored by this plan. This mirrors the 013
`catalog/erpnext-item-map` shape (CLOSED on `main`) — the proven sibling.

---

## Open-question gate (status)

The **structure-gating** questions are **LOCKED** (owner, 2026-06-04); the
**mismatch-vocabulary** detail remains open for the data-model / recon-def slice
([spec §11](./spec.md#11-open-questions-must-be-locked-before-implementation)):

| Question | Status | Effect |
|---|---|---|
| **OQ-1 + OQ-5** mirror-vs-on-demand / 014-017 line | ✅ **LOCKED — no mirror; 017 owns fetch-compare** | 014 = mapping + mismatch vocab only; no ERPNext-quantity table (avoids read-down look-alike) |
| **OQ-2** cardinality | ✅ **LOCKED — 1:1 v1, forward-compatible to warehouse-by-purpose** | partial-unique `(tenant_id, store_id, purpose)`; v1 writes only `purpose='stock'`; future returns/expired warehouse without breaking migration |
| **OQ-3** lifecycle | ✅ **LOCKED — manual admin-set** | a `[GATED]` 014-CONTRACT review surface (cookieAuth); no suggest-engine, no import worker |
| **OQ-4** mismatch vocabulary & tolerance | ⏳ **deferred — data-model / recon-def slice** | the exact mismatch classes + tolerance semantics; 017 reports/repairs against this vocabulary |

---

## Next step

`spec.md` + `plan.md` + [`data-model.md`](./data-model.md) + [`tasks.md`](./tasks.md)
+ [`execution-map.yaml`](./execution-map.yaml) are authored; the OQs are locked
(OQ-4 the mismatch vocabulary in data-model §6). The planning chain is
**complete**. The authoritative slice IDs + statuses live in the execution-map;
the next move is the **owner's call to begin implementation** — the two
foundational `[GATED]` slices (after the trivial SIGNOFF + SETUP):

- **014-SCHEMA** `[GATED]` — the Drizzle schema `erpnext_warehouse_map` +
  migration (`0018` indicative, paired `*.down.sql`, RLS, `purpose`-grain
  partial-unique, **no Bin mirror**), per [data-model.md](./data-model.md).
- **014-CONTRACT** `[GATED]` — the manual set/list/retire review OpenAPI (§IV,
  `cookieAuth`).

They are parallel-safe (disjoint surfaces) but each needs its own approval.
`014-CRUD` (the manual set→list→retire MVP) unblocks once both + the isolation
harness land. The reconciliation *run* (`014-RECON-RUN`) belongs to **017**.

```text
Use Agent OS. Execute slice 014-SCHEMA. Stop before commit.
```
```text
Use Agent OS. Execute slice 014-CONTRACT. Stop before commit.
```
