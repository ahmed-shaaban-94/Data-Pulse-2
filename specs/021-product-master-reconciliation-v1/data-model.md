# Phase 1 Data Model — 021 Product-Master Reconciliation v1

**Status: Design-only — `[GATED]`.** No SQL, no Drizzle schema, no migration, no
OpenAPI YAML authored here. This document **describes in prose** the forbidden
surfaces (a new DB table family under `packages/db/**` + an operator OpenAPI
contract under `packages/contracts/openapi/**`); both land in their own `[GATED]`
approval slices after this design is accepted.

Grounded in [research.md](./research.md). 021 **owns** its run/report/repair state;
it **reads** (never copies, never mutates) the 013 mapping, the 003 catalog, the
008 sale facts, and the connector's ERPNext-item view. It mirrors the
[017 data-model](../017-erpnext-reconciliation-and-repair/data-model.md) structure
for product-mapping rather than stock.

---

## 1. What 021 reads (not owned here)

| Source (owner) | Used for | Mutated by 021? |
|---|---|---|
| `erpnext_item_map` (013, `0017`) | the unmapped/unconfirmed backlog (US1, via the confirmed-only invariant); the target of a **repair** (US2 — confirm / suggest-confirm / re-point) | **Transition only via 013's existing lifecycle** — a repair drives the shipped 013 suggest/confirm/re-point flow under 013's `version` guard + 1:1 active partial-unique. 021 NEVER writes the table directly and owns no second mapping table. The 013 lifecycle stays authoritative. |
| `tenant_products` (003, `0007–0011`) | the backlog's read-projection parent; the product reference in reports | **NEVER** (§IX — Tenant Catalog authority) |
| `sales` / `sale_lines` (008, `0012`) | the immutable sale facts a run/repair must not touch | **NEVER** (§IX/§X, FR-014) |
| connector ERPNext-item view (012 seam) | the ERPNext side of the US3 two-sided compare | No (read; DP2 makes no outbound ERPNext HTTP; stub-tolerant) |
| `audit_events` (001) | the audit-of-record for every run + repair | **INSERT only, in-transaction** (FR-015; the 017 path, NOT `@Auditable`/`insertAuditEvent`) |

---

## 2. The new `[GATED]` state — `erpnext_product_reconciliation_*`

**Decision (research R2):** 021 owns durable **runs**, **results**, and **repair
attempts** — used by US3 (the persisted two-sided compare) and US2 (the repair
trail). The **US1 backlog is NOT a table** — it is a live read-projection (§3).
Proposed as a small family; the exact table split is finalized at SCHEMA
authoring, but the migration is `[GATED]` regardless (`packages/db/**`, next number
after `0021` → **`0022` indicative**).

### 2.1 `erpnext_product_reconciliation_run`

One reconciliation execution (the US3 two-sided compare). **Tenant-scoped, not
store-scoped** — a product↔Item mapping is tenant-wide (the 013 no-store-axis
precedent).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | UUIDv7 caller-supplied, no DB default (the 0017/0019/0020 precedent) |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis; FK ON DELETE RESTRICT |
| `trigger` | text NOT NULL | CHECK `IN ('on_demand','scheduled')` (v1 emits `on_demand`; `scheduled` reserved — R7) |
| `status` | text NOT NULL DEFAULT `'running'` | CHECK `IN ('running','completed','failed')` |
| `erpnext_view_status` | text NOT NULL DEFAULT `'unavailable'` | CHECK `IN ('available','unavailable','partial')` — records the connector-view availability so an absent view is a *reported* condition, never a failed run (FR-007 / R3) |
| `started_at` | timestamptz NOT NULL DEFAULT now() | UTC |
| `finished_at` | timestamptz NULL | set on terminal status |
| `summary` | jsonb NULL | counts by mismatch class (no PII/money — counts only, §XIV) |
| `actor_user_id` | uuid NULL → users | the operator for an on-demand run; NULL for scheduled |
| `correlation_id` | uuid NULL | end-to-end correlation (worker run) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

> **No `kind` column** — unlike 017 (which reserved `kind='stock'`), 021 has exactly
> one run kind (the two-sided product compare); the US1 backlog is a read-projection,
> never a run. A `kind` column would be vacuous.

### 2.2 `erpnext_product_reconciliation_result`

One classified line of a run's mismatch report. Append-only per run; its workflow
state may transition.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | UUIDv7 |
| `run_id` | uuid NOT NULL → …_run(id) | single-column FK to the run PK (the 017 advisor #1 rationale — `id` is UUIDv7 + RLS scopes both rows to one tenant; a composite FK buys nothing). ON DELETE RESTRICT |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis |
| `mismatch_class` | text NOT NULL | CHECK against **021's product-master vocabulary** (`match` / `unmapped_dp2_product` / `suggestion_unconfirmed` / `unmapped_erpnext_item` / `attribute_drift` / `sellable_state_divergence` — research R4, derived from 013 §7/OQ-5/OQ-6). 021 owns this vocabulary; it does not invent a competing one where 013 named the case. |
| `tenant_product_id` | uuid NULL | the DP2 product ref (NULL for an `unmapped_erpnext_item` line). POLYMORPHIC-ish but a real 003 ref → MAY carry an FK ON DELETE RESTRICT at SCHEMA authoring, or stay FK-less per the 0019/0020 polymorphic precedent (finalized then) |
| `erpnext_item_ref` | text NULL | the ERPNext item reference for the line (DP2-terms string; NULL for an `unmapped_dp2_product` line). No FK (external, 012 O-6) |
| `source_system` / `external_id` | text NULL | provenance carried for reconciliation |
| `result_state` | text NOT NULL DEFAULT `'open'` | CHECK `IN ('open','repaired','accepted')` — 021's OWN orthogonal workflow state |
| `detail` | jsonb NULL | operator-facing values (DP2 vs ERPNext attributes, drift fields) — values allowed on the row, NEVER in metric labels |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 2.3 `erpnext_product_reconciliation_repair_attempt`

Append-only audit of every repair action (US2 + US3 repairs).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | UUIDv7 |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis |
| `target_kind` | text NOT NULL | CHECK `IN ('backlog_item','result')` — a repair from the US1 live backlog (target = a `tenant_product_id`) or from a persisted US3 result (target = a result id) |
| `target_ref_id` | uuid NOT NULL | the `tenant_products.id` (backlog repair) or a `…_result.id` (run repair); POLYMORPHIC → no FK (the 0019/0020 precedent) |
| `repair_kind` | text NOT NULL | CHECK `IN ('confirm','suggest_confirm','re_point')` — all DRIVE 013's existing lifecycle (FR-010); 021 owns no new mapping write |
| `actor_user_id` | uuid NOT NULL → users | the operator (always human, FR-019) |
| `outcome` | text NOT NULL | CHECK `IN ('mapped','still_unmapped','no_op_echo','conflict')` — `conflict` = 013's `version` guard fired (FR-012) |
| `resolved_item_map_id` | uuid NULL | echoed when the repair resolves to a confirmed-and-active 013 mapping (the idempotency echo, FR-011) |
| `expected_version` | integer NULL | the 013 `version` the confirm was issued against (provenance for a `conflict` outcome) |
| `correlation_id` | uuid NULL | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | append-only; no `updated_at` |

### 2.4 Invariants (all CHECK / RLS / code-enforced)

- **RLS**: every table ENABLE + FORCE RLS, `tenant_id` policy with the empty-GUC
  CASE guard (`current_setting('app.current_tenant', true) = '' → NULL`, the
  0012/0017/0019/0020 fail-closed pattern). SELECT + INSERT + UPDATE policies on
  runs + results (a run completes; a result transitions `open→repaired/accepted`);
  repair_attempt is INSERT + SELECT only (append-only). **NO DELETE policy** on any
  (retention is a state, not a row removal — §XIV).
- **No money column / no PII** — `summary`/`detail` jsonb carry counts +
  operator-facing attribute values, never PII or payment data (§XIV BUSINESS-class).
- **013/003/008 never mutated** — enforced in the service/processor (021 issues NO
  UPDATE/INSERT/DELETE on `erpnext_item_map`, `tenant_products`, `sales`,
  `sale_lines`; a repair calls 013's *existing* lifecycle, which 013 owns).
- **Repair idempotency** — a confirm repair of an already-`confirmed`-and-active
  013 mapping is a `no_op_echo` returning `resolved_item_map_id` (research R5);
  013's 1:1 active partial-unique guarantees at most one active confirmed mapping.
  Concurrent confirms serialize via 013's `version` guard (a stale version →
  `conflict`).
- **Two trails, one transaction** — a repair (and a run) writes BOTH (a) a platform
  `audit_events` row (FR-015 — the audit-of-record) AND (b) 021's own operational
  record (`repair_attempt` / `run` + `result_state` transition) **in the same
  transaction**. `result_state` is the *current workflow status*; `repair_attempt`
  is the *immutable history*; `audit_events` is the *platform audit*. Never written
  independently — a repair that cannot also audit rolls back. **The audit write is a
  NEW in-transaction path** (a direct `INSERT INTO audit_events` on the same tx
  client) — NOT the async `@Auditable` (013/014/015) and NOT `insertAuditEvent`
  (forbidden in-tx). (Research R6 / the 017 correction.)

---

## 3. The US1 backlog — a live read-projection (NOT a table)

The US1 unmapped/unconfirmed backlog is computed **live** and is **not persisted**
(research R2 — the 017 read-projection-vs-run discriminator):

```
SELECT tp.*  ←  read-projection, tenant-scoped via app.current_tenant
FROM tenant_products tp                              (003, never mutated)
LEFT JOIN erpnext_item_map m                         (013, read only)
  ON m.tenant_product_id = tp.id
 AND m.state = 'confirmed'
 AND m.retired_at IS NULL                            (013 confirmed-only-and-active invariant)
WHERE tp.retired_at IS NULL                          (active products only)
  AND m.id IS NULL                                   (no current confirmed mapping)
```

Classification per row:
- a `suggested`-only (or retired-confirmed) row → `suggestion_unconfirmed` (a
  suggestion exists but is inert) — carries the 013 suggestion provenance.
- no `erpnext_item_map` row at all → `unmapped_dp2_product`.

This projection re-resolves the 013 truth on every read (READ-NOT-MIRROR-013); it
holds **no** copy of the 013 state, so it can never drift from 013.

---

## 4. State transitions

### 4.1 Repair (US2 — drives 013)

```
unmapped_dp2_product / suggestion_unconfirmed (live backlog row)
        │  operator triggers repair (confirm | suggest_confirm | re_point)
        ▼
  call 013's EXISTING lifecycle under 013's version guard
        │                                  │
   confirmed-and-active                stale version / declined
        ▼                                  ▼
  product leaves backlog               product stays in backlog (class intact — FR-013)
  repair_attempt.outcome=mapped        repair_attempt.outcome=conflict|still_unmapped
        │
        ▼
  a later repair of the now-mapped product = no_op_echo (resolved_item_map_id — FR-011)
```

### 4.2 Run (US3 — two-sided compare)

```
running ──(compare 013 confirmed mapping set vs connector ERPNext-item view)──►
  persist one result per line, classified in 021's vocab ──► completed
  (013 + 003 + 008 never mutated — FR-014; absent view → erpnext_view_status='unavailable',
   DP2-side classes only, NO fabricated unmapped_erpnext_item — FR-007)
```

---

## 5. Contracts (prose — `[GATED]`, NOT authored here)

### 5.1 Operator OpenAPI contract — `product-reconciliation.yaml` (`[GATED]`)

A future `[GATED]` slice authors `packages/contracts/openapi/catalog/product-reconciliation.yaml`
(the 017 `reconciliation.yaml` precedent). Described in prose:

- **Auth:** `cookieAuth` / `DashboardAuthGuard`, human-operator-only (FR-019);
  NOT `connectorBearer`, NOT a POS device scheme.
- **Namespace:** `/api/v1/catalog/erpnext-product-reconciliation` (alongside 017's
  `/api/v1/catalog/erpnext-reconciliation`).
- **Operations (indicative `operationId`s; finalized at the contract slice):**
  - `listProductReconciliationBacklog` — GET the US1 live backlog (paginated,
    sortable, groupable by mismatch class; gap-detectable).
  - `triggerProductReconciliationRun` — POST an on-demand US3 run (requires
    `Idempotency-Key`; returns the run id).
  - `listProductReconciliationRuns` — GET past runs.
  - `getProductReconciliationRunResults` — GET a run's classified report (filter by
    class).
  - `repairProductMapping` — POST a repair (confirm / suggest_confirm / re_point),
    carrying the expected 013 `version`; idempotent; `409` on stale version.
- Responses are explicit wire shapes (`toBody()` projection), never raw DB rows
  (§IV); uniform error envelope; conformance tests required.

### 5.2 Connector ERPNext-item view — `021-ITEM-VIEW-CONTRACT` (`[GATED]`, future/external)

The live ERPNext-item read is its **own** future `[GATED]` connector→DP2 contract
(the 017 `017-STOCK-VIEW-CONTRACT` precedent), authored when the connector ships
the item-fetch machinery. 021 v1 is stub-tolerant and ships without it. DP2 makes
no outbound ERPNext HTTP either way.

---

## 6. Drift-test allowlists to update (the #447/#487-class CI break)

The future `0022` migration + schema modules MUST be appended to, in lockstep
(research R10):

- `packages/db/__tests__/cli/migrate.spec.ts` → `EXPECTED_MIGRATIONS` (+ `0022_…`)
- `packages/db/__tests__/schema/catalog/barrel.spec.ts` → `EXPECTED_CATALOG_MODULES`
  (+ the new module name[s])
- re-call `ensureAppRole` AFTER the migration in any new migration spec (grants only
  cover tables-at-grant-time — the documented gotcha)
- the cardinality / signal-name drift lists for the new reconciliation metric (R9)

---

## 7. Constitution Check (data-model level)

| Principle | Verdict |
|---|---|
| **§II Multi-tenant RLS** | ✅ every owned table `tenant_id` NOT NULL + FK; fail-closed RLS; safe-404 cross-tenant; RLS-bypass probe + sweeps required in the SCHEMA slice. |
| **§III Backend authority & concurrency** | ✅ repair reuses 013's `version` optimistic-concurrency guard (no new LWW); no money column. |
| **§IV Contract-first** | ✅ operator surface + connector item-view are each `[GATED]` OpenAPI slices; `toBody()` projections, no raw entities. |
| **§VIII Reproducible releases** | ✅ this doc authors NO schema/migration/YAML; `0022` family + contract are separate `[GATED]` slices with paired `*.down.sql`. |
| **§IX Source-of-truth** | ✅ reconciliation, not handover; 013/003/008 read-only; divergence surfaced, never overwritten. |
| **§XI Idempotency** | ✅ repair no-op echo on already-confirmed; run worker idempotent. |
| **§XII Object safety** | ✅ `tenant_id`/`actor_user_id` from principal, never body; strict DTOs; safe 404. |
| **§XIII Auditability** | ✅ in-transaction `audit_events` (the 017 path); insert-only; bounded/redacted metadata; 013 suggestion provenance carried. |
| **§XIV PII & lifecycle** | ✅ BUSINESS-class only; no PII/money/raw payloads; no DELETE policy (retention = state). |

**Result: PASS.** No principle violated. The §IX discriminator is satisfied by
read-not-mutate + reuse-013-lifecycle.

---

## Next step

This design → its own **`[GATED]` SCHEMA slice** (Drizzle schema
`packages/db/src/schema/catalog/erpnext-product-reconciliation.ts` + the `0022`
migration with paired `*.down.sql`, lock-duration review) and the **`[GATED]`
021-CONTRACT** for the operator surface. The connector ERPNext-item view
(`021-ITEM-VIEW-CONTRACT`) is a separate future/external `[GATED]` slice. Before
them, [tasks.md](./tasks.md) sequences the work.
