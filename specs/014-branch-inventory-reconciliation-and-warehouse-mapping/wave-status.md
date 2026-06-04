# Wave Status — `014-branch-inventory-reconciliation-and-warehouse-mapping`

> Human-readable summary of where the spec stands. The 014 **planning chain is
> complete** (spec → clarify → plan → data-model → tasks → **execution-map**).
> The map now defines dispatchable slices, but **authoring it does NOT authorize
> the first dispatch** — the first slice touching `packages/db` /
> `packages/contracts/openapi` / `apps/api` is a threshold the owner crosses
> explicitly. The two foundational slices (CONTRACT, SCHEMA) are `[GATED]` +
> `proposed`.

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `014-branch-inventory-reconciliation-and-warehouse-mapping`
**Base:** `origin/main` at `2c414de` (012 merged; 013 + 009 closed)
**Status:** spec + plan + data-model + tasks + execution-map **authored** on `docs/014-spec` — **not committed/pushed** (stop-before-commit)
**Active finding(s):** none

---

## TL;DR

014 maps a DP2 `stores` row to an ERPNext **Warehouse** so ERPNext can *value*
the same physical stock, and **defines** the reconciliation between DP2
operational on-hand (009) and ERPNext Bin quantity. **The authority question is
CLOSED by the SIGNED stock-impact decision**
([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md)):
**DP2 is the operational on-hand authority** (009 ledger), **ERPNext owns
valuation**, and **read-down replacing DP2 availability is REJECTED**. 014 builds
**no Bin mirror** (OQ-1) — a standing DP2 copy of ERPNext stock is the read-down
look-alike the decision rejects. The **reconciliation run + mismatch reports +
repair API is 017** (the §8 carve); 014 ships only the mapping + the
mismatch-class vocabulary. Docs/planning only: no code, schema, migration,
OpenAPI YAML, package/lockfile, CI, connector, POS, or Console change.

---

## Decisions locked (owner, 2026-06-04)

| OQ | Decision | Where |
|---|---|---|
| **authority / direction** | **CLOSED — DP2 operational on-hand; ERPNext valuation; read-down REJECTED.** Not an open OQ — signed. | stock-impact §4 + spec §5 |
| **OQ-1 + OQ-5** (collapsed) | **No ERPNext-quantity mirror in DP2.** 014 = mapping + mismatch vocabulary; 017 fetches Bin on-demand + runs/reports/repairs. | plan + data-model §1/§8 |
| **OQ-2** | **1:1 for v1, forward-compatible to warehouse-by-purpose.** Owner future intent: a returns/expired warehouse. v1 writes only `purpose='stock'`; partial-unique `(tenant_id, store_id, purpose)` admits a future `returns` row with no breaking migration. | plan OQ-2 note + data-model §3 |
| **OQ-3** | **Manual admin-set** via a `[GATED]` Console→DP2 contract (cookieAuth). No suggest-engine, no import worker. | plan + tasks |
| **OQ-4** | **Mismatch-class vocabulary LOCKED** — `match` / `quantity_divergence` / `unmapped_store` / `unmapped_item` / `dp2_only` / `erpnext_only` / `negative_balance_flagged`; exact-match default (no silent rounding, §III); negative-balance classed first (surfaced, never erased). | data-model §6 |

**No Bin mirror. No worker. No reconciliation run in 014** (the §8 carve — those
are **017**). Read-down / ERPNext-as-on-hand-master intent is a STOP-and-raise
(re-open the signed decision).

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Planning spec: purpose, boundaries, the operational-vs-accounting split (SIGNED), the 014↔017 carve, concepts, assumptions, open questions, Constitution Check | Authored (+ Clarifications + §11 lock banner) |
| `plan.md` | Decision-gated plan: Constitution Check, Architecture Impact Map, Technical Context / Storage / Project Structure; OQ-1/2/3/5 locked + the OQ-2 forward-compat rule | Authored |
| `data-model.md` | **`[GATED]` design** of `erpnext_warehouse_map`: `purpose`-grain partial-unique, no-FK ref, optimistic `version`, RLS, **no Bin mirror** + the **OQ-4 mismatch-class vocabulary** | Authored |
| `tasks.md` | Ordered task list (T001–T091 + T050-as-017): SIGN-OFF → `[GATED]` CONTRACT + SCHEMA → ISOLATION → US1 manual map → US2 reconciliation-definition → polish | Authored (this slice) |
| `execution-map.yaml` | Dispatch map: 9 slices + a proposed `014-FOUNDATIONAL-GATED` parallel group; conforms to `slice-schema.yaml` | Authored (this slice) |
| `checklists/requirements.md` | Spec quality checklist | Authored |
| `wave-status.md` | This file | Authored |

> Still **NOT** created (the actual `[GATED]` surfaces): any OpenAPI YAML, any
> Drizzle schema / SQL migration, any app code. Those are the dispatchable slices
> the map defines — each its own approval slice, none authorized by this docs PR.

---

## Slices (per the [execution-map](./execution-map.yaml))

| Slice | Status | Notes |
|---|---|---|
| `014-SIGNOFF` | **ready** | record the read-down-rejected + no-mirror + no-run decisions (docs) |
| `014-SETUP` | **ready** | scaffold the empty `apps/api/src/catalog/erpnext-warehouse-map` module |
| `014-CONTRACT` `[GATED]` | **proposed** | manual set/list/retire review OpenAPI (**cookieAuth**); no Bin field |
| `014-SCHEMA` `[GATED]` | **proposed** | `erpnext_warehouse_map` Drizzle + migration (`0018` indicative); `purpose`-grain partial-unique + RLS; no Bin column |
| `014-ISOLATION-HARNESS` | **blocked** (→ SCHEMA) | DB-layer RLS sweep + `seed-warehouse-map.ts`; GREEN (characterises shipped RLS) |
| `014-CRUD` 🎯 MVP | **blocked** (→ both gated + harness) | manual set → list → retire; optimistic-version 409; strict DTO |
| `014-RECON-DEF` | **blocked** (→ CRUD) | the mismatch-class vocabulary (data-model §6) as a shared enum 017 consumes; **no run** |
| `014-POLISH` | **blocked** (→ RECON-DEF) | coverage + closeout |
| `014-RECON-RUN` | **proposed — NOT dispatchable** | the reconciliation run + repair belongs to **017** (no spec yet) |

`014-FOUNDATIONAL-GATED` (group, proposed): CONTRACT + SCHEMA may run in parallel
(disjoint surfaces); needs approval of **both**.

---

## Dependencies & gates (satisfied)

| Gate | State |
|---|---|
| **gated_by**: stock-impact decision (011-DR-STOCK-IMPACT) SIGNED | ✅ SIGNED 2026-06-03 — gates 014/015/017; direction/authority fixed by it |
| **depends_on**: 012-erpnext-connector-contracts merged | ✅ MERGED (#476 / #479 / #481 / #482) |
| **depends_on**: 013-product-master-from-erpnext closed | ✅ CLOSED on main (#489, `2d9de86`) — supplies the item correspondence for per-item reconciliation |
| **depends_on**: 009-inventory-stock-ledger closed | ✅ CLOSED on main — the DP2 side of the comparison (operational on-hand) |
| **OQ-1/2/3/5** | ✅ LOCKED (plan) |
| **OQ-4** | ✅ LOCKED (data-model §6) |
| **assumption**: ERPNext major confirmed | ⏳ UNCONFIRMED — baseline v15, final major confirmed in 012 staging validation (the no-FK `erpnext_warehouse_ref` is version-independent by design) |

---

## Next recommended action

The **014 planning chain is complete** — `spec.md` + `plan.md` + `data-model.md`
+ `tasks.md` + `execution-map.yaml` are authored. Once they merge, 014 has a full
dispatchable map.

The next move is the **owner's call to begin implementation** — the first real
code/schema/contract threshold. The recommended first dispatch is the trivial
SIGNOFF + SETUP, then the two foundational `[GATED]` slices:

```text
Use Agent OS. Execute slice 014-SCHEMA. Stop before commit.
```
```text
Use Agent OS. Execute slice 014-CONTRACT. Stop before commit.
```

Each is `[GATED]` — dispatching it is an explicit in-session approval of that
forbidden surface (`packages/db/**` / `packages/contracts/openapi/**`). They are
parallel-safe (disjoint surfaces) but each needs its own approval. `014-CRUD`
(the manual set→list→retire MVP) unblocks once both + the isolation harness land.

> Reminder for 014-SCHEMA: a new catalog table + migration trips **two**
> allowlists — append `0018` to `cli/migrate.spec EXPECTED_MIGRATIONS` AND
> `erpnext-warehouse-map` to `schema/catalog/barrel.spec EXPECTED_CATALOG_MODULES`
> (the #487-class hosted-CI break; see `reference_migration_test_gotchas`).

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
CI, connector, POS, or Console file changed. **No runtime behavior changed.**
This slice adds the 014 planning chain under
`specs/014-branch-inventory-reconciliation-and-warehouse-mapping/` (+ the
`.specify/feature.json` pointer) — nothing else. The `execution-map.yaml`
**defines** dispatchable slices (including the two `[GATED]` ones) but
**authorizes none of them**.
