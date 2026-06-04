# Wave Status — `013-product-master-from-erpnext`

> Human-readable summary of where the spec stands. **013 implementation is
> COMPLETE** — the full planning chain (spec → plan → data-model → tasks →
> execution-map) plus all **7 dispatchable slices** have shipped. The two
> `[GATED]` foundational slices (SCHEMA + CONTRACT) merged via PR #487; the
> remaining api-only slices (SETUP, ISOLATION-HARNESS, CRUD, REPOINT, POLISH)
> shipped on `feat/013-crud-impl`. `013-RESOLVE` remains `proposed` (belongs to
> the future 015 spec).

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `013-product-master-from-erpnext` (`specs/013-product-master-from-erpnext/`)
**Base:** `origin/main` at `4012439` (planning chain + #487 [GATED] foundation merged)
**Status:** **CLOSED** — all 7 slices terminal (SCHEMA/CONTRACT via #487; SETUP/ISOLATION-HARNESS/CRUD/REPOINT/POLISH via `feat/013-crud-impl`)
**Active finding(s):** 1 — `AUTO_MATCH_NO_SOURCE` (medium; non-blocking — v1 manual-only, as built)

---

## TL;DR

013 is the **product-master mapping** between Data-Pulse-2's 003 Tenant Catalog
and ERPNext, so a future sale posting (015) can resolve each DP2 sale line to a
real ERPNext **Item** (posting decision §1; "fails-to-DLQ if not"). The crux is
the **source-of-truth split**: 013 is a **mapping/reconciliation layer, NOT a
handover of catalog authority** — the §IX Tenant Catalog stays authoritative for
the retail product; ERPNext owns **accounting Item identity** only.

As built: a new `apps/api/src/catalog/erpnext-item-map/` module (suggest →
confirm → retire/re-point) over the `[GATED]` `erpnext_item_map` table
(migration `0017`) + the `[GATED]` `catalog/erpnext-item-map.yaml` review
contract. Mapping is **1:1** (OQ-2), **suggest-then-confirm by a Tenant Admin**
(OQ-7, no silent auto-trust), with **optimistic `version`** concurrency (§III)
and a **confirmed-only invariant** (only confirmed rows are resolvable). v1
suggest is **manual-only** (`suggestion_source='manual'`; finding
AUTO_MATCH_NO_SOURCE). **No worker, no outbox event** (OQ-8) — the posting-time
read belongs to 015.

---

## Slices — all terminal

| Slice | Type | PR / branch | State |
|---|---|---|---|
| `013-SIGNOFF-MANUAL` | docs | (decisions recorded here) | **done** |
| `013-SETUP` | chore | `feat/013-crud-impl` | **merged** — empty module registered in `app.module.ts` |
| `013-CONTRACT` `[GATED]` | feat | **#487** (`d18b0a5`) | **merged** — `catalog/erpnext-item-map.yaml` (4 ops, cookieAuth) + 16/16 conformance |
| `013-SCHEMA` `[GATED]` | feat | **#487** (`d18b0a5`) + `6e60f90` | **merged** — `0017_erpnext_item_map` + barrel + RLS; schema-shape 8/8, migration 11/11 |
| `013-ISOLATION-HARNESS` | test | `feat/013-crud-impl` | **merged** — DB-layer RLS sweep, **GREEN 8/8** |
| `013-CRUD` 🎯 MVP | feat | `feat/013-crud-impl` | **merged** — suggest/confirm/list, **GREEN 16/16** |
| `013-REPOINT` | feat | `feat/013-crud-impl` | **merged** — retire + append-only re-point, **GREEN 6/6** |
| `013-POLISH` | chore | `feat/013-crud-impl` | **merged** — structured logs + coverage + this closeout |
| `013-RESOLVE` | feat | — | **proposed** — belongs to **015** (not dispatchable; OQ-5/6 lock there) |

**Module test totals:** 46/46 GREEN under WSL Testcontainers (contract 16, isolation 8, crud 16, repoint 6). Coverage on the implementation files: controller 97.95%, service 97.82%, DTOs 100% (≥80% slice target met; the `.module.ts` DI-wiring file is the standard never-imported 0% noise).

---

## Map-text reconciliations (recorded at closeout)

Two execution-map header notes drafted **before** authoring turned out stale; the
shipped artifacts are authoritative (same posture as the auth-scheme note in 010):

1. **Auth scheme = `cookieAuth`, not "Clerk-JWT".** The map header + tasks.md said
   the CONTRACT uses a "manager/dashboard Clerk-JWT / session" scheme. The
   **shipped** `catalog/erpnext-item-map.yaml` (#487) uses `cookieAuth` (the
   httpOnly `dp2_session` cookie → `DashboardAuthGuard`), mirroring the
   `tenantAdmin*` ops in `catalog/unknown-items.yaml`. The CRUD controller wires
   `DashboardAuthGuard + TenantContextGuard + RolesGuard`. (Clerk is not an auth
   scheme in this repo; the human dashboard scheme is the session cookie.)
2. **The isolation harness landed DB-layer GREEN, not "RED on missing ops".** The
   map said `013-ISOLATION-HARNESS` should be RED on missing suggest/confirm. That
   is mechanically unsound: importing a non-existent service *errors* (not fails),
   and a missing-controller route returns a trivial framework 404 (not the
   *designed* non-disclosing 404). Every existing repo isolation spec (003's
   `rls-bypass-probe`) is pure-DB-layer and GREEN — it characterises shipped RLS.
   So the harness is GREEN (it tests the 0017 RLS that #487 shipped), and the
   **operations-level cross-tenant 404** moved to `013-CRUD`/`013-REPOINT`, where
   the controller exists and a meaningful RLS-driven 404 can be asserted.

---

## Active findings

| ID | Severity | Summary | Status |
|---|---|---|---|
| `AUTO_MATCH_NO_SOURCE` | medium | The `suggestion_source` enum keeps `barcode`/`item_code`, but 012 `posting-feed.yaml` has no ERPNext item-search op DP2→ERPNext, and OQ-8 forbids an import worker. **v1 is manual-only** (`suggestion_source='manual'`, as built); auto-match deferred to a future `[GATED]` 012 item-search extension. | **as designed** — manual path complete; non-blocking |

---

## Deferred (owner's call)

- **Composite cross-tenant FK on `tenant_product_id`** — not added. RLS is the
  primary tenant guard; the FK is plain `(tenant_product_id) REFERENCES
  tenant_products(id) ON DELETE RESTRICT`. 0014 added a composite
  `(tenant_id, …)` FK as defense-in-depth; faithful-to-spec for 013 = not added.
  A follow-up `[GATED]` schema slice could add it if wanted.
- **`tenantAdminListErpnextItemMappings` is unbounded** (no LIMIT / pagination).
  This is faithful to the shipped `[GATED]` contract, whose list op defines NO
  pagination params and a bare `{items}` envelope — adding a service-layer LIMIT
  would be a **silent truncation** (returns *some* rows with no "more" signal),
  which the standing rules forbid. The honest fix, if it ever matters, is
  pagination params in the OpenAPI — a future `[GATED]` contract change. (The 007
  unknown-items list paginates because *its* contract defines limit/cursor; 013's
  review-queue contract deliberately does not.)

---

## Dependencies & gates (all satisfied)

| Gate | State |
|---|---|
| **depends_on**: 012-erpnext-connector-contracts merged | ✅ MERGED (#476 / #479 / #481 / #482) |
| **gated_by**: posting decision (011-DR-POSTING) SIGNED | ✅ SIGNED 2026-06-03 |
| **OQ-1** source-of-truth (§IX) | ✅ mapping/reconciliation (no ADR; §IX satisfied) |
| **OQ-2** cardinality | ✅ 1:1 `(tenant_id, tenant_product_id)` active partial-unique |
| **OQ-7** lifecycle | ✅ suggest-then-confirm (confirmed-only invariant enforced) |
| **OQ-8** direction | ✅ lazy resolution, **no import worker / no outbox event** |
| **OQ-3** UOM / **OQ-4** pricing | ✅ no column (15 behavioral decisions) |
| **OQ-5/6** posting-detail | ⏳ open — lock during the 015 resolution slice |
| **assumption**: ERPNext major confirmed | ⏳ UNCONFIRMED — baseline v15, confirmed in 012 staging validation (the no-FK `erpnext_item_ref` is version-independent by design) |

---

## Next recommended action

013 is **CLOSED**. The downstream arc:

- **014** branch-inventory-reconciliation + warehouse-mapping (gated by stock-impact).
- **015** pos-sale-posting-to-erpnext (gated by posting + stock-impact) — this is
  where **`013-RESOLVE`** (the confirmed-only posting-time read) + the
  `erpnext.posting.requested` registration land. OQ-5/OQ-6 lock here.
- **016** tax-and-fiscal-egypt-v1; **017** sync-ops-and-repair-api.

Each needs its own Spec-Kit chain (spec → plan → data-model → tasks → map) like
013 had. Separately: ERPNext-major **staging validation** (confirm the version
pin) and the **connector repo** build against `posting-feed.yaml`.

---

## Closeout note

The 013 mapping module is complete and tested end-to-end against real Postgres.
It changed: a new `apps/api/src/catalog/erpnext-item-map/` module (module +
controller + service + 3 DTOs), 3 new test suites (isolation + crud + repoint)
+ a seed helper, one line in `app.module.ts`, and this spec's `execution-map.yaml`
+ `wave-status.md`. The `[GATED]` surfaces (the `0017` migration + the OpenAPI
contract) shipped earlier via #487. No worker, no outbox event, no
`package.json`/lockfile, no CI, no connector/POS/Console change.
