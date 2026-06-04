# Implementation Plan: Product Master from ERPNext

**Branch**: `docs/013-product-master-planning` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/013-product-master-from-erpnext/spec.md`

> **Decision-gated plan — REVISED 2026-06-04 after the design-gating open
> questions were answered.** This is a **docs-only planning artifact**. It
> records the approach, the full Constitution Check, the Architecture Impact
> Map, and — now that OQ-1/OQ-2/OQ-7/OQ-8 are locked — the Technical Context,
> Storage, and Project Structure.
>
> **Answered (owner, 2026-06-04):** **OQ-1** = 013 is a *mapping/reconciliation*
> layer (§IX-clean; Tenant Catalog stays authoritative, ERPNext owns accounting
> Item identity only) — **not** an override, so **no §IX amendment / ADR is
> required**. **OQ-2** = **1:1** `tenant_product ↔ ERPNext Item`. **OQ-7** =
> *suggested-then-confirmed by Tenant Admin* (human-in-the-loop; no silent
> auto-trust). **OQ-8** = *lazy resolution at posting time* (no bulk import
> worker).
>
> **OQ-7 narrows OQ-8 — recorded so this plan carries no contradiction.** A
> human-confirmed mapping is tenant-owned data that MUST be **persisted in DP2,
> RLS-scoped** (§IX/§II) and confirmed via a DP2 API (Retail-Tower-Console talks
> only to DP2, never the connector — 011 boundaries). So OQ-8's "smallest
> footprint / maybe connector-side / no table" does **not** survive: a **new
> `[GATED]` DP2 mapping table** and a **`[GATED]` 013-CONTRACT review surface**
> are now **required**, not optional. What survives from OQ-8 is narrower and
> correct: **no bulk import worker**, and the *posting-time read* is
> on-demand/lazy. Remaining open questions (OQ-3/4/5/6) are posting-detail, not
> structure-gating, and stay open for the data-model slice.
>
> Still docs-only: the table + contract are described as **future `[GATED]`
> slices**, not authored here.

---

## Summary

013 plans the **product-master mapping** between Data-Pulse-2's 003 Tenant
Catalog and ERPNext, so a future sale posting (015) resolves each DP2 sale line
to a real ERPNext **Item** (posting decision §1; "fails-to-DLQ if not"). **013 is
a mapping/reconciliation layer, not a handover of catalog authority** (OQ-1): the
§IX Tenant Catalog stays authoritative for the retail/operational product view;
ERPNext owns **accounting Item identity** only. This mirrors the signed
stock-impact split (two authorities, reconciled by correlation, never merged).

**The committed design (OQ-1/2/7/8 locked 2026-06-04):**

- **Persistence** — a **new `[GATED]` DP2 mapping table**, tenant-scoped (RLS),
  unique `(tenant_id, tenant_product_id)` → exactly one ERPNext Item reference
  (OQ-2 1:1). Tenant-owned data, so it lives in **DP2, never connector-side**
  (§IX/§II).
- **Population** — **suggest-then-confirm by a Tenant Admin** (OQ-7): the system
  proposes a candidate ERPNext Item match (e.g. by barcode/Item-code); a Tenant
  Admin confirms before the mapping is active. **No silent auto-trust** — mirrors
  the 003 unknown-items "no silent create" discipline.
- **Resolution** — **lazy / on-demand at posting time** (OQ-8): 015 reads the
  persisted mapping when it posts; **unmapped → fails-to-DLQ** (posting decision
  §5). The DP2 sale fact is never mutated on a posting failure.
- **Surface** — a **`[GATED]` 013-CONTRACT** (`packages/contracts/openapi/…`) for
  the suggest/confirm review flow (Console → DP2 only; §IV). Required by OQ-7.
- **No bulk import worker** — population is the suggest-confirm flow, not a
  catalogue pull.

The structure-gating questions are answered; the posting-detail questions
(OQ-3 UOM, OQ-4 price-list-vs-amounts, OQ-5 sellable divergence, OQ-6
unknown-items relationship) remain open for the data-model / resolution slices.

---

## Technical Context

> **RESOLVED** for the structure-gating questions (OQ-1/2/7/8 locked
> 2026-06-04). Posting-detail fields that still depend on OQ-3/4/5/6 are marked
> `NEEDS CLARIFICATION (data-model slice)`. No code/schema is authored here; the
> table + contract below are future `[GATED]` slices.

**Language/Version**: TypeScript 5.x strict (repo standard). 013 adds DP2
runtime: a mapping module (api) for the suggest/confirm flow + posting-time
read. (Persisted in DP2 — not connector-resident — per OQ-7/§IX.)

**Primary Dependencies**: NestJS 11, Drizzle ORM, Zod (repo standard). **No new
external dependency is authorized by 013** (assumption A-3); the ERPNext/Frappe
client is connector-only and a separate `[GATED]` `package.json` decision. 013's
suggest/confirm reads ERPNext Item candidates **via the connector + 012
contract**, never a direct Frappe client in DP2.

**Storage**: a **new `[GATED]` DP2 mapping table** (tenant-scoped, RLS),
unique `(tenant_id, tenant_product_id)` → one ERPNext Item reference (OQ-2 1:1),
plus a confirmation-state + provenance columns (suggested/confirmed/by-whom/when,
§XIII). Paired `*.down.sql`, lock-duration reviewed (§VIII). **Authored in a
future `[GATED]` 013-MAPPING-MODEL slice, not here.** Reads existing `tenant_products`
+ `product_aliases` (003) read-only.

**Testing**: Jest + Supertest + Testcontainers (repo standard). For the new
mapping table: **RLS-bypass probe + cross-tenant/cross-store sweeps mandatory**
(§VI); contract-conformance test for the 013-CONTRACT review surface;
idempotency-replay on confirm (§XI). Scoped in the model/contract slices.

**Target Platform**: Linux server (NestJS **api**). **No worker** — population is
the synchronous suggest/confirm flow, not a bulk import job (OQ-8).

**Project Type**: web-service (NestJS api in the pnpm monorepo). New mapping
module under `apps/api` + new schema under `packages/db`; review surface under
`packages/contracts/openapi`. Concrete tree in **Project Structure** below.

**Performance Goals**: no bulk path (OQ-8 lazy resolution + suggest/confirm), so
**no per-tenant bulk-ingestion resource posture is required** for 013. The
posting-time read is a single indexed lookup per sale line; the suggest flow is
interactive (admin-paced). Concrete targets set in the model slice.

**Constraints**: Version-independence at the DP2 boundary (012 O-6, assumption
A-2) — the mapping stores a DP2-terms ERPNext Item *reference*; the connector
resolves it to the live doctype. **ERPNext major UNCONFIRMED** (assumption A-1 —
do not assume v15 as implementation truth). Money/quantity exactness for any
posting-detail field is `NEEDS CLARIFICATION (data-model slice)` pending OQ-3/4.

**Scale/Scope**: one mapping row per tenant product that needs posting; bounded
by the tenant's catalogue size. No cross-tenant aggregate.

---

## Constitution Check

*GATE: this PR is docs-only — the check is at design-intent level. A full
per-task re-check lands in the future `[GATED]` model/contract slices.*

The discriminating principle was **§IX**, and it is now **resolved**: OQ-1 =
mapping/reconciliation, so §IX is satisfied (Tenant Catalog stays authoritative),
**no amendment / ADR required**.

| Principle | Gate verdict |
|---|---|
| **§I Reference, not source of truth** | ✅ No ERPNext fork / core copy-paste. Bespoke ERPNext lives in the connector's thin custom Frappe app (version-pin decision §3), never forked into DP2. |
| **§II Multi-tenant RLS** | ✅ (design intent) The new mapping table is tenant-scoped; cross-tenant non-disclosure (404) + an RLS-bypass probe are mandatory and scoped to the model slice (§VI) — not weakened here. |
| **§III Backend authority & integrity** | ✅ DP2 amounts authoritative for the posted invoice; POS totals preserved as received. Money/quantity exactness for posting-detail fields tracked in OQ-3/OQ-4 (data-model slice). |
| **§IV Contract-first** | ✅ Connector is the only ERPNext edge; the suggest/confirm review surface ships as a **`[GATED]` 013-CONTRACT** OpenAPI YAML first (now required by OQ-7). DP2 owns the contracts. |
| **§IX Source-of-truth model** | ✅ **RESOLVED (OQ-1 = mapping/reconciliation).** Tenant Catalog stays authoritative for the retail view; ERPNext owns accounting Item identity only; the mapping reconciles, never overrides ([spec.md §5](./spec.md#5-source-of-truth--the-mappingreconciliation-split-the-crux)). No §IX amendment / ADR required. |
| **§VIII Reproducible releases** | ✅ No `package.json`/lockfile/schema/migration change in **this** PR. The new mapping table + 013-CONTRACT are future **`[GATED]`** slices with paired rollback + lock review. ERPNext version pin stays an explicit **unconfirmed** assumption (A-1). |
| **§XI Idempotency & external IDs** | ✅ (design intent) Posting-time resolution reuses the sale's `sourceSystem + externalId` (012 O-1/O-3); the confirm write must be idempotent (replay-safe) — scoped to the model slice. |
| **§XIII Auditability & provenance** | ✅ (design intent) The mapping table carries tenant/store/source-layer + suggested/confirmed/by-whom/when provenance; unmapped cases are traceable for repair. |

**Constitution Check result:** **PASS.** No principle is violated; **§IX is
resolved** (OQ-1 mapping/reconciliation). The plan may proceed to a
`data-model.md` / `[GATED]` model slice once the posting-detail questions
(OQ-3/4/5/6) that the data-model needs are locked.

**Complexity Tracking:** No violations to justify (no code/schema authored in
this PR; the new table + contract are standard `[GATED]` slices, not complexity
exceptions).

---

## Architecture Impact Map

Per Constitution Working Agreement
([`.specify/memory/architecture-impact.md`](../../.specify/memory/architecture-impact.md)).

### Impact Classification

- Impact level: **None**
- Reason: **This PR is documentation-only** — it adds/revises planning docs under
  `specs/013-product-master-from-erpnext/` and moves **no** module, schema,
  contract, queue, dependency, or auth surface. The design is now *decided* (the
  new DP2 mapping table + 013-CONTRACT), but those are **future `[GATED]` slices**,
  not authored here — so the impact of *this* PR remains `None`.
- Boundary crossings:
  - API → Worker: none
  - API → DB: none
  - Worker → DB: none
  - Package boundary: none
  - External provider: none
  - OpenAPI/codegen: none
  - Runtime/deployment: none

> Per the architecture-impact rule's **"No architecture impact" exception**
> (`Impact level: None` with a non-empty reason), the gate checklist and
> dimension table MAY be omitted for this docs-only PR. They are retained below
> as **firm forward references** — the design is now decided (OQ-1/2/7/8 locked),
> so the future implementation's blast radius is **known, not conditional**. Each
> entry is marked active-for-the-future-slice, not for this PR.

### Triggered Review Gates — *firm forward reference (decided; triggered by the future `[GATED]` slices, NOT this docs PR)*

Now that OQ-1/2/7/8 are locked, the implementation gates are **decided**:

- [x] **DB read/write → RLS / tenant-context strategy** — **YES.** A new
      tenant-scoped DP2 mapping table (§II). Pointer (future, 013-MAPPING-MODEL):
      RLS-bypass probe + cross-tenant/cross-store sweep added per the new table.
- [x] **OpenAPI / API contract change** — **YES** (now required by OQ-7
      suggest/confirm review, §IV). Pointer (future, 013-CONTRACT): a `[GATED]`
      YAML under `packages/contracts/openapi/erpnext-connector/` (or a 013
      namespace) + conformance spec.
- [ ] **Queue / job publish or consume** — **NO.** OQ-8 = lazy resolution, **no
      import worker**. (And `erpnext.posting.requested` stays named-only,
      registered with 015 — not 013.)
- [ ] Auth / session / token change — **NO.** The confirm flow uses the existing
      Tenant-Admin session auth; no new auth surface. (Connector auth is the 012
      machine-principal scheme, unchanged.)
- [ ] **Package dependency change** — **NO**, not authorized by 013 (A-3). The
      ERPNext/Frappe client is connector-only + separately `[GATED]`. 013 reads
      Item candidates via the connector + 012 contract.
- [x] **Cross-package or cross-app import** — **YES** (minor): the new `apps/api`
      mapping module imports the new `packages/db` schema (standard monorepo
      boundary). Pointer: justified by the established api↔db dependency pattern
      (e.g. the 003 catalog + 009 inventory modules).
- [ ] External provider integration — **NO** for DP2: ERPNext is reached **only**
      via the connector (§IV, 011 boundaries); 013 itself integrates no external
      provider directly.

> These gates describe the **future** `[GATED]` slices' blast radius. **This** PR
> ticks none of them in practice — it is docs-only (`Impact level: None`). The
> ticks above are firm *forward references* so the eventual review scope is on
> the record now, not discovered later. (Per the floor rule, a ticked gate
> implies the future slice — not this docs PR — is at least Medium impact.)

### Required dimensions — *firm forward reference (for the future implementation slices)*

| Dimension | This docs-only PR | Decided impact (future `[GATED]` slices) |
|---|---|---|
| Affected modules / packages | none | new `apps/api` mapping module + new `packages/db` schema + `packages/contracts/openapi` review surface |
| DB tables read | none | `tenant_products`, `product_aliases` (003) — read-only |
| DB tables written | none | **new `[GATED]` mapping table**, unique `(tenant_id, tenant_product_id)` (OQ-2 1:1) |
| APIs / OpenAPI contracts changed | none | **new `[GATED]` 013-CONTRACT** — suggest/confirm review operations (OQ-7) |
| Events / jobs published | none | **none** (OQ-8 lazy; no worker). Not `erpnext.posting.requested` |
| Events / jobs consumed | none | none |
| Files likely to require edits | only `specs/013-product-master-from-erpnext/**` | `apps/api/src/<mapping-module>/**`, `packages/db/src/schema/<mapping>.ts` + migration, `packages/contracts/openapi/**`, new test suites |
| Risky dependencies / boundary concerns | none | none new in DP2 (A-3); ERPNext client is connector-only |
| Regression test areas | none | 003 catalog suites; RLS-bypass + cross-tenant/cross-store sweeps for the new table; 013-CONTRACT conformance |

---

## Project Structure

### Documentation (this feature)

```text
specs/013-product-master-from-erpnext/
├── spec.md             # Planning spec (authored)
├── mapping-concepts.md # Concept catalogue (authored)
├── plan.md             # This file (decision-gated plan, REVISED)
├── wave-status.md      # Human-readable status (authored)
├── data-model.md       # NEXT — the new mapping table ([GATED]), pending OQ-3/4/5/6
└── tasks.md            # LATER — /speckit-tasks after data-model
```

> `research.md` is not needed as a separate artifact: the design questions were
> resolved as owner decisions (OQ-1/2/7/8) rather than open research, mirroring
> how 011/012 captured their decisions in signed records, not a `research.md`.

### Source Code (repository root) — *scoped, NOT authored by this plan*

> The tree below is the **decided** target for the future `[GATED]` slices. **No
> source file is created by this docs-only plan.** Concrete names settle in the
> model/contract slices.

```text
apps/api/src/
└── catalog/
    └── erpnext-item-map/          # NEW module — suggest/confirm + posting-time read
        ├── erpnext-item-map.controller.ts   # 013-CONTRACT review ops (suggest/confirm/list)
        ├── erpnext-item-map.service.ts       # 1:1 resolve, idempotent confirm
        └── erpnext-item-map.module.ts

packages/db/src/schema/
└── catalog/
    └── erpnext-item-map.ts        # NEW [GATED] table: unique (tenant_id, tenant_product_id)
                                    #   → erpnext_item_ref + state(suggested|confirmed) + provenance
packages/db/drizzle/
└── 00NN_erpnext_item_map.sql      # NEW [GATED] migration (+ paired *.down.sql), RLS policies

packages/contracts/openapi/
└── <erpnext-connector|catalog>/
    └── erpnext-item-map.yaml       # NEW [GATED] 013-CONTRACT — suggest/confirm review surface

apps/api/test/catalog/erpnext-item-map/   # NEW — RLS-bypass probe, cross-tenant/cross-store
                                          #   sweep, idempotent-confirm, contract conformance
```

**Structure Decision**: 013 adds a DP2 **api module** (`catalog/erpnext-item-map`)
backed by a new **`[GATED]` `packages/db` table + migration** and a **`[GATED]`
013-CONTRACT** review surface. The resolution path is read at posting time (015,
lazy); population is the suggest/confirm admin flow. **No worker** (OQ-8). Each
`[GATED]` artifact is its own approval slice (§VIII / standing rules §3); none is
authored by this plan.

---

## Open-question gate (status)

The **structure-gating** questions are **LOCKED** (owner, 2026-06-04); the
**posting-detail** questions remain open for the data-model / resolution slices
([spec.md §11](./spec.md#11-open-questions-must-be-locked-before-implementation)):

| Question | Status | Effect |
|---|---|---|
| **OQ-1** source-of-truth | ✅ **LOCKED — mapping/reconciliation** | §IX satisfied; no ADR; plan proceeds |
| **OQ-2** cardinality | ✅ **LOCKED — 1:1** | unique `(tenant_id, tenant_product_id)` |
| **OQ-7** lifecycle | ✅ **LOCKED — suggest-then-confirm** | requires a DP2 table + `[GATED]` 013-CONTRACT review surface |
| **OQ-8** direction | ✅ **LOCKED — lazy resolution, no import worker** | no worker; posting-time read |
| **OQ-3** UOM | ⏳ open | data-model slice (quantity exactness, §III) |
| **OQ-4** price-list vs explicit amounts | ⏳ open | data-model slice (§IX-safe default = explicit DP2 amounts) |
| **OQ-5** sellable-state divergence | ⏳ open | resolution slice |
| **OQ-6** unknown-items relationship | ⏳ open | resolution slice |

The plan may now proceed to **`data-model.md`** for the new `[GATED]` mapping
table. OQ-3/4/5/6 are **posting-detail**, not table-structure — they can lock
during the data-model/resolution slices; they do **not** block authoring the
mapping table's core grain (which OQ-1/2/7/8 already determine).

---

## Next step

The structure-gating questions are answered and the plan is complete. The next
move is the **`[GATED]` 013-MAPPING-MODEL** slice — author `data-model.md` for the
new mapping table (grain, columns, RLS, provenance, the unique 1:1 constraint),
locking OQ-3/4 (UOM, pricing) as part of it:

```text
Use Agent OS. Author 013 data-model.md — the [GATED] erpnext-item-map mapping
table (1:1 tenant_product↔Item, suggest/confirm state, provenance, RLS), and
lock OQ-3/OQ-4. Docs-only ([GATED] schema design, no migration authored yet).
Stop before commit.
```

> Note: `data-model.md` is a design doc (docs-only), but it designs a `[GATED]`
> surface (new table + migration), so it carries the `[GATED]` marker and the
> actual migration/schema lands in its own approval slice after the design is
> accepted.

Only after that does a `data-model.md` / `[GATED]` schema slice (013-MAPPING-MODEL)
become dispatchable.
