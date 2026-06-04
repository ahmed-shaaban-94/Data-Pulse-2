<!--
  /speckit-tasks output for 014 Branch Inventory Reconciliation & Warehouse Mapping.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
  Authoring this file (and execution-map.yaml) does NOT authorize the first dispatch — the first slice
  touching packages/db / packages/contracts/openapi / apps/api is a new threshold the owner crosses explicitly.
-->

# Tasks: Branch Inventory Reconciliation & Warehouse Mapping

**Feature**: 014-branch-inventory-reconciliation-and-warehouse-mapping | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md)

---

## 0. TL;DR — 014 is a store↔ERPNext-Warehouse mapping module + a reconciliation *definition*

014 maps a DP2 `stores` row to an ERPNext **Warehouse** so ERPNext can value the same physical stock, and **defines** the reconciliation between DP2 operational on-hand (009) and ERPNext Bin quantity. **The authority question is CLOSED by the signed stock-impact decision** (DP2 = operational on-hand authority; ERPNext = valuation; **read-down rejected**). 014 adds a new `apps/api/src/catalog/erpnext-warehouse-map/` module + the `[GATED]` `erpnext_warehouse_map` table ([data-model.md](./data-model.md)) + a `[GATED]` manual set/list/retire review contract. The **reconciliation run + repair is 017** — 014 only defines *what is compared* and *what a mismatch is*.

**Locked decisions (owner, 2026-06-04):**
- **OQ-1 + OQ-5** — **no ERPNext-quantity mirror** in DP2; 017 fetches Bin on-demand. 014 = mapping + mismatch vocabulary only.
- **OQ-2** — **1:1 for v1**, forward-compatible to **warehouse-by-purpose** (a future returns/expired warehouse) via the `purpose` grain + partial-unique `(tenant_id, store_id, purpose)`. v1 writes only `purpose='stock'`.
- **OQ-3** — **manual admin-set** via a `[GATED]` Console→DP2 contract (cookieAuth). No suggest-engine, no import worker.
- **OQ-4** — mismatch-class vocabulary **LOCKED** in [data-model.md §6](./data-model.md#6-reconciliation-definition--mismatch-class-vocabulary-oq-4).

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [Story?] Description (file path).`
- **Labels**: `[P]` parallelizable; `[GATED]` requires explicit approval (forbidden path); `[TC]` Testcontainers/real-Postgres (run via WSL per `reference_007_test_env`); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test and made GREEN (Constitution §VI). Coverage ≥80%.
- **Auth (CONTRACT)**: the manual set/list/retire review surface is a **human Tenant-Admin** action → the **cookieAuth** (`dp2_session` → `DashboardAuthGuard`) scheme — the same scheme the shipped 013 `erpnext-item-map.yaml` uses. **NOT** 012's `connectorBearer` (machine) and **NOT** 010's `clerkJwt`/`posDeviceAuth` (device).
- **No worker / no event** (OQ-1, the carve): 014 adds no BullMQ queue, no scheduled job, no outbox event. The reconciliation run + mismatch reports + repair are **017**.
- **No new dependency**: no `package.json` change. Any ERPNext/Frappe client is connector-only + a separate `[GATED]` decision (assumption A-3).
- **No Bin mirror**: 014 stores **no** ERPNext-quantity column/table (OQ-1) — the read-down look-alike is explicitly not built.

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T010 | `[GATED]` | New OpenAPI manual set/list/retire review contract under `packages/contracts/openapi/**` (§IV/§VIII) — explicit approval, its own slice. **cookieAuth human auth.** |
| T012 | `[GATED]` | New `erpnext_warehouse_map` Drizzle schema + migration (`packages/db/**`, next number — **`0018`** indicative) **including RLS + the `purpose`-grain partial-unique** — explicit approval, paired `*.down.sql`, lock-duration review (§VIII). |
| T001 | `[SIGN-OFF]` | Confirm the authority/direction is **closed by the signed stock-impact decision** (DP2 operational on-hand; ERPNext valuation; **read-down rejected**); 014 builds **no Bin mirror** (OQ-1). Any read-down intent is STOP-and-raise (re-open the signed decision). |
| T002 | `[SIGN-OFF]` | Confirm 014 adds **no worker, no outbox event, no reconciliation run** — those are **017** (the §8 carve). 014 ships only the mapping + the mismatch-class vocabulary. |

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) 🎯 MVP | A Tenant Admin **maps** a store to an ERPNext Warehouse: manual **set → list → retire/re-point**, 1:1 (`purpose='stock'`), optimistic `version` | T030–T034 |
| (cross-cutting P1) | **Isolation & non-disclosure**: tenant RLS, RLS-bypass probe, cross-tenant 404 on `erpnext_warehouse_map` | T020 |
| US2 (P2) | **Reconciliation definition** — the comparison + mismatch-class vocabulary (data-model §6) as a shared contract 017 consumes (enum/schema; **no run**) | T040–T041 |
| (consumer, NOT 014) | **Reconciliation run + mismatch reports + repair API** | — belongs to **017** (the §8 carve) |
| (polish) | coverage, closeout | T090–T091 |

---

## 4. Phase 1 — Setup

- [ ] T001 [SIGN-OFF] Record that the authority/direction is **closed by the signed stock-impact decision** (DP2 operational on-hand authority; ERPNext valuation; **read-down rejected**) and that 014 builds **no Bin mirror** (OQ-1). Predecessors: none. Acceptance: decision recorded in [wave-status.md](./wave-status.md); no ERPNext-quantity column appears in any 014 allowed-files set.
- [ ] T002 [SIGN-OFF] Confirm 014 adds **no worker / no outbox event / no reconciliation run** (the §8 carve — those are 017). Predecessors: T001. Acceptance: no `apps/worker/**`, no `docs/outbox/event-types.md`, and no scheduled-job file in any 014 allowed-files set.
- [ ] T003 [P] Scaffold the new `apps/api/src/catalog/erpnext-warehouse-map/` module (empty `erpnext-warehouse-map.module.ts` registered in `apps/api/src/app.module.ts`, mirroring `erpnext-item-map.module.ts`). Predecessors: T002. Acceptance: `pnpm --filter @data-pulse-2/api build` green; module registered; no routes yet; existing catalog modules still compile (no regression).

## 5. Phase 2 — Foundational (`[GATED]`; block all capability slices)

> Per [data-model.md](./data-model.md): the mapping table + the review contract are both prerequisites for the manual-set CRUD. They touch **disjoint** surfaces (`packages/db/**` vs `packages/contracts/openapi/**`), so they are parallel-safe with each other even though both block the CRUD slice.

### 5.1 `[GATED]` manual set/list/retire review OpenAPI contract

- [ ] T010 [GATED] Request explicit approval, then author the review contract under `packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml`: operations to **set** a mapping (body carries `store_id` + `erpnext_warehouse_ref`; `purpose` defaults to `stock` server-side in v1; `tenant_id`/actor resolved server-side, never body — §XII), **list** a tenant's active mappings, and **retire** (versioned, optimistic concurrency → `409` on mismatch — §III). The **cookieAuth** (`dp2_session`) security scheme (NOT `connectorBearer`, NOT `clerkJwt`). A `toBody()` projection (no raw DB entity, §IV); canonical Error envelope incl. `409 conflict` + non-disclosing `404`. Predecessors: T003. Acceptance: YAML lints; conformance spec authored alongside (operationIds present + globally unique; cookieAuth scheme asserted; `409`/`404` in the closed error set; no raw entity; **no Bin-quantity field** anywhere in the contract — OQ-1).
- [ ] T011 [SIGN-OFF] [P] Confirm no `package.json` dependency is added by the contract/module. Predecessors: T010. Acceptance: conformance harness discovers the new operationIds; no dependency added.

### 5.2 `[GATED]` `erpnext_warehouse_map` schema + migration

- [ ] T012a [P] [TC] RED — schema-shape spec asserting (when the schema exists) `erpnext_warehouse_map` carries the [data-model.md §2](./data-model.md) field set: `tenant_id` NOT NULL FK, `store_id` NOT NULL FK (`ON DELETE restrict`), `purpose` (`stock`|`returns`, default `stock`), `erpnext_warehouse_ref text` (no FK), `version int`, set provenance, soft-delete; **fail-closed RLS** (empty-GUC CASE guard, mirror 0010/0017). Predecessors: T003. Acceptance: test runs, fails (no schema yet).
- [ ] T012 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/catalog/erpnext-warehouse-map.ts`), the barrel re-export (`packages/db/src/schema/index.ts`), and the paired `0018_erpnext_warehouse_map.sql` / `.down.sql` migration (next available number — **`0018`**; confirm free at authoring): the table per [data-model.md §2](./data-model.md) — **partial-unique `(tenant_id, store_id, purpose) WHERE retired_at IS NULL`** (OQ-2 forward-compat 1:1); `purpose`/`ref-length`/`version>=1` CHECKs; fail-closed RLS (SELECT + INSERT + UPDATE policies on `app.current_tenant`, empty-GUC CASE guard, no DELETE policy); indexes per data-model §2. **No Bin-quantity / valuation / on-hand column.** Predecessors: T012a, T010-style approval, T001 (no-mirror), data-model.md. Acceptance: T012a GREEN; migration applies + rolls back clean (UP→DOWN→UP) under Testcontainers; the `purpose`-grain partial-unique rejects a 2nd active `stock` mapping for the same store but admits a future `returns` row; lock-duration reviewed; **two-allowlist regression handled** — append `0018_erpnext_warehouse_map` to `cli/migrate.spec EXPECTED_MIGRATIONS` AND `erpnext-warehouse-map` to `schema/catalog/barrel.spec EXPECTED_CATALOG_MODULES` (the #487-class CI break — see `reference_migration_test_gotchas`).

### 5.3 Isolation-harness extension (blocking — serves the capability slices)

- [ ] T020 [P] [TC] RED→GREEN — `erpnext_warehouse_map` isolation: a raw-SQL **RLS-bypass probe** (wrong `app.current_tenant` → zero rows; unset GUC → fail-closed + INSERT denied), a **cross-tenant sweep** (tenant B cannot read/retire tenant A's mapping → non-disclosing 404), and the **`purpose`-grain partial-unique** assertion (a 2nd active `stock` row for the same store → 23505; a `returns` row coexists). Seed via a new `seed-warehouse-map.ts` (mirror `seed-item-map.ts`; do **NOT** touch the 003-owned `isolation-harness.ts`). DB-layer GREEN (characterises the shipped 0018 RLS — mirrors 013-ISOLATION-HARNESS). Predecessors: T012. Acceptance: GREEN under WSL Testcontainers; probe present; no store-axis sweep (tenant-only table).

## 6. Phase 3 — US1 (P1) 🎯 MVP: manual store↔warehouse map (set → list → retire)

- [ ] T030 [P] [TC] [US1] RED — set: a Tenant Admin sets a manual mapping (`store_id` + `erpnext_warehouse_ref`); row lands `purpose='stock'`, `version=1`; `tenant_id`/actor resolved server-side (body-injected `tenant_id` ignored — §XII); scope-check the store (non-disclosing 404 if absent/cross-tenant); a 2nd active `stock` set for the same store → `409 conflict` (1:1). Predecessors: T010, T012, T020. Acceptance: RED (no service yet).
- [ ] T031 [US1] GREEN — `erpnext-warehouse-map.service.ts` + controller `set` op (manual, `purpose='stock'`); audit-in-transaction; idempotent/1:1 on the active `(tenant_id, store_id, 'stock')`. Predecessors: T030. Acceptance: T030 GREEN.
- [ ] T032 [P] [TC] [US1] RED — list + retire: list returns the tenant's active mappings (never another tenant's); retire sets `retired_at` + `version++`, takes expected `version` → **`409` on stale version** (§III optimistic concurrency); cross-tenant retire → non-disclosing 404. Predecessors: T031. Acceptance: RED.
- [ ] T033 [US1] GREEN — `list` + `retire` ops (retire = version-on-update `WHERE id=$1 AND version=$2 AND retired_at IS NULL`, increment; 0-row disambiguated conflict-vs-404; re-point = retire old + fresh set, append-only). Predecessors: T032. Acceptance: T032 GREEN; stale-version → 409; history preserved.
- [ ] T034 [P] [TC] [US1] RED→GREEN — mass-assignment ban: `tenant_id`, `purpose`, `version`, `set_by` are NOT body-assignable (§XII strict `.strict()` DTO); reject unknown keys 400. Predecessors: T031. Acceptance: RED then GREEN with the command DTO.

## 7. Phase 4 — US2 (P2): reconciliation definition (vocabulary, NOT a run)

- [ ] T040 [P] [US2] RED→GREEN — the **mismatch-class vocabulary** ([data-model.md §6.2](./data-model.md#6-reconciliation-definition--mismatch-class-vocabulary-oq-4)) as a shared, testable contract: the closed enum (`match` | `quantity_divergence` | `unmapped_store` | `unmapped_item` | `dp2_only` | `erpnext_only` | `negative_balance_flagged`) + the comparison definition (009 on-hand vs ERPNext Bin for the mapped warehouse + 013-mapped item). **No run, no fetch, no stored rows** — a definition 017 consumes (likely a shared TS enum / OpenAPI schema). Predecessors: T033. Acceptance: the vocabulary is expressed + unit-tested (exhaustive enum); §III exact-match-default + negative-balance-first ordering (§6.3) asserted; nothing fetches ERPNext Bin or schedules a job.
- [ ] T041 [SIGN-OFF] [US2] Confirm the **014↔017 carve** holds in the delivered code: 014 ships the mapping + the vocabulary; **no** reconciliation job/report/repair lands in 014 (those are 017). Predecessors: T040. Acceptance: the §8 carve restated in wave-status; no scheduled-job/report/repair file in 014.

## 8. Phase 5 — Polish

- [ ] T090 [P] Observability: structured logs carry `tenant_id`/`correlation_id` on set/retire; no new metric category required (reuses existing). Predecessors: T034, T040. Acceptance: logs present; no secrets/PII.
- [ ] T091 Coverage ≥80% for the new module; closeout (execution-map + wave-status terminal). Predecessors: T090. Acceptance: coverage gate; map/wave-status reconciled.

---

## 9. Consumer (NOT a 014 slice) — the reconciliation run belongs to 017

- [ ] T050 [PROPOSED — 017] Reconciliation **run + mismatch reports + repair API**: 017 reads 014's active `stock` mapping + the mismatch-class vocabulary, **fetches** ERPNext Bin on-demand via the connector, compares against 009 on-hand, persists mismatch reports, and exposes the repair workflows (stock-impact §5). **Not dispatchable in 014** — 017 has no spec yet. Listed for traceability only.

---

## 10. Findings (carried into the execution map)

- *(none)* — unlike 013's `AUTO_MATCH_NO_SOURCE`, 014's manual admin-set has no missing candidate-source problem (warehouses need no matching, OQ-3). The OQ-1 no-mirror decision removed the would-be Bin-mirror complexity. The only deferral is the **`returns` warehouse purpose** (reserved in the grain, written by a future 014 widening) and the **per-tenant tolerance** (exact-match for v1, §6.3).
