# Phase 1 Data Model — 017 ERPNext Reconciliation & Repair

Grounded in research.md. 017 **owns** its run/report/repair state; it **reads**
(never copies) the 015 dead-letters, the 014 mapping, and the 009 ledger.

---

## 1. What 017 reads (not owned here)

| Source (owner) | Used for | Mutated by 017? |
|---|---|---|
| `erpnext_posting_status` (015, `0019`) | the posting dead-letter backlog (US1); the target of a posting repair (US2) | **Transition only** — a repair re-evaluates 015-RESOLVE eligibility and, if resolved, flips a `permanently_rejected` row to `pending` + re-heads `sequence`. NEVER edits `document_ref`, provenance, or a `posted` row. The 015 state machine stays authoritative. |
| `erpnext_warehouse_map` (014, `0018`) | the store→warehouse mapping for a stock run; the target of a **re-map** repair (drives 014's existing admin flow) | No — 017 reads it; re-map calls 014's mapping admin, 017 does not own the table. |
| `stock_movements` (009, `0014`) | DP2 compute-on-read on-hand for a stock run | **NEVER** (FR-013) |
| `sales` / `sale_lines` / `sale_voids` / `sale_refunds` (008, `0012`) | originating references + provenance projected into the backlog | **NEVER** (§IX, FR-013) |
| connector ERPNext-Bin view (012 seam) | the ERPNext valuation side of a stock compare | No (read; DP2 makes no outbound ERPNext HTTP) |

---

## 2. The new `[GATED]` state — `erpnext_reconciliation_*`

**Decision (research R2):** 017 owns durable **runs**, **results**, and
**repair attempts**. Proposed as a small family; the exact table split is
finalized at SCHEMA authoring, but the migration is `[GATED]` regardless
(`packages/db/**`, next number after `0019` → **`0020` indicative**).

### 2.1 `erpnext_reconciliation_run`

One reconciliation execution. **`kind` is STOCK-ONLY** (advisor #2 / R2): the
posting backlog (US1) is a **live read-projection** over the 015
`erpnext_posting_status` rows (READ, never mirror) and the contract has **no
posting-run trigger** (only `triggerReconciliationRun` = stock). A `kind='posting'`
run would never produce result rows, so it is NOT modeled — keeping it out
removes an implied mirror and shrinks the schema.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | UUIDv7 (caller-supplied, no DB default — the 0019 precedent) |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis; FK ON DELETE RESTRICT |
| `store_id` | uuid NOT NULL → stores | a stock run is always store-scoped (needs the 014 mapping). Tenant-local FK, not a 2nd RLS axis (the 0019 precedent) |
| `kind` | text NOT NULL | CHECK `IN ('stock')` — stock-only in v1 (posting is a read-projection, not a run; advisor #2). The CHECK reserves room to add `'posting'` later only if a posting-snapshot run is ever needed. |
| `trigger` | text NOT NULL | CHECK `IN ('on_demand','scheduled')` (v1 emits `on_demand`) |
| `status` | text NOT NULL DEFAULT `'running'` | CHECK `IN ('running','completed','failed')` |
| `started_at` | timestamptz NOT NULL DEFAULT now() | |
| `finished_at` | timestamptz NULL | set on terminal status |
| `summary` | jsonb NULL | counts by mismatch class (no PII/money values — counts only) |
| `actor_user_id` | uuid NULL → users | the operator for an on-demand run; NULL for scheduled |
| `correlation_id` | uuid NULL | end-to-end correlation (worker run) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 2.2 `erpnext_reconciliation_result`

One classified line of a run's mismatch report. Append-only per run.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `run_id` | uuid NOT NULL → erpnext_reconciliation_run(id) | **single-column FK** to the run PK (advisor #1) — `id` is a UUIDv7 PK and RLS scopes both rows to one tenant, so a composite `(run_id, tenant_id)` FK (which would need an extra `UNIQUE (id, tenant_id)` on the run) buys nothing here. ON DELETE RESTRICT |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis |
| `mismatch_class` | text NOT NULL | CHECK against **014's stock vocabulary ONLY** (`match`/`quantity_divergence`/`unmapped_store`/`unmapped_item`/`dp2_only`/`erpnext_only`/`negative_balance_flagged` — 014 data-model §6.2, finalized). The 015 posting categories are NOT here: posting dead-letters are read in place on the 015 rows, never mirrored as 017 results (advisor #2 / R2). 017 owns NO class of its own. |
| `source_ref_id` | uuid NULL | originating ref (for a stock line: the product ref); NULL for an aggregate line. POLYMORPHIC → no FK (the 0019 precedent) |
| `source_system` / `external_id` | text NULL | provenance carried for reconciliation |
| `result_state` | text NOT NULL DEFAULT `'open'` | CHECK `IN ('open','repaired','accepted')` — 017's OWN orthogonal workflow state (research R4) |
| `detail` | jsonb NULL | operator-facing values (DP2 vs ERPNext qty etc.) — values allowed on the row (NOT in metric labels) |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

### 2.3 `erpnext_reconciliation_repair_attempt`

Append-only audit of every repair action.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis |
| `target_kind` | text NOT NULL | CHECK `IN ('posting','stock')` |
| `target_ref_id` | uuid NOT NULL | the 015 `erpnext_posting_status.id` (posting repair) or a result id (stock); POLYMORPHIC → no FK |
| `repair_kind` | text NOT NULL | CHECK `IN ('re_post','re_map','re_sync','drain')` |
| `actor_user_id` | uuid NOT NULL → users | the operator (always human, FR-018) |
| `outcome` | text NOT NULL | CHECK `IN ('eligible_again','still_failing','no_op_echo')` |
| `resolved_document_ref` | text NULL | echoed when a posting repair resolves to a `posted` doc (O-3) |
| `correlation_id` | uuid NULL | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | append-only; no `updated_at` |

### 2.4 Invariants (all CHECK / RLS / code-enforced)

- **RLS**: every table ENABLE + FORCE RLS, `tenant_id` policy with the empty-GUC
  CASE guard (`current_setting('app.current_tenant', true) = '' → NULL`, the
  0012/0017/0019 fail-closed pattern). SELECT + INSERT + UPDATE policies on runs +
  results (a run completes, a result transitions `open→repaired/accepted`);
  repair_attempt is INSERT + SELECT only (append-only, no UPDATE/DELETE). NO
  DELETE policy on any (retention is a state, not a row removal — §XIV).
- **No money column / no PII** — `summary`/`detail` jsonb carry counts +
  operator-facing qty values, never PII or payment data (§XIV BUSINESS-class).
- **008/009 never mutated** — enforced in the service/processor (no UPDATE on
  sales/sale_lines/stock_movements anywhere in 017).
- **Repair idempotency (O-3)** — a posting repair re-evaluates 015-RESOLVE then
  transitions the 015 row; a repair of a `posted` row is a `no_op_echo` returning
  the stored `document_ref` (research R1). Concurrent repairs serialize via
  `SELECT … FOR UPDATE` on the 015 row (the US2-ACK precedent).
- **Two trails, one transaction (U1)** — a repair (and a run) writes BOTH (a) a
  platform `audit_events` row (FR-014 — the audit-of-record) AND (b) 017's own
  operational record (`repair_attempt` / `run` + `result_state` transition) **in
  the same transaction**. `result_state` (`open→repaired/accepted`) is the
  *current workflow status*; `repair_attempt` is the *immutable history*;
  `audit_events` is the *platform audit*. They are never written independently —
  a repair that cannot also audit rolls back. **The audit write is a NEW
  in-transaction path** (a direct `INSERT INTO audit_events` on the same tx
  client) — NOT the async `@Auditable` interceptor 013/014/015 use (post-response
  BullMQ enqueue, never in-tx) and NOT `insertAuditEvent` (which explicitly
  forbids use inside a transaction). The atomicity requirement is real; the
  implementation is new (review HIGH-finding correction).

---

## 3. State transitions

### 3.1 Posting repair (US2)

```
permanently_rejected (015 row)
        │  operator triggers repair
        ▼
  re-evaluate 015-RESOLVE (item map confirmed? store mapped? period open?)
        │                                  │
   resolved                          still unresolved
        ▼                                  ▼
  015 row → pending (sequence re-head)   015 row stays permanently_rejected
  repair_attempt.outcome=eligible_again  repair_attempt.outcome=still_failing
        │                                  (returns to backlog, class intact — FR-011)
        ▼
  connector re-posts via EXISTING 012 feed/ack
        ▼
  posted (one document_ref)  ──► a later repair = no_op_echo (same ref — FR-010)
```

### 3.2 Stock run (US3)

```
running ──(compare 009 on-hand vs connector ERPNext-Bin view per 014 mapping)──►
  persist one result per line, classified in 014's vocab ──► completed
  (009 + 008 never mutated — FR-013; unmapped store → unmapped_store, never guess — FR-006)
```

---

## 4. Drift-test allowlists to update (the #447/#487-class CI break)

The new `0020` migration + schema modules MUST be appended to, in lockstep:

- `packages/db/__tests__/cli/migrate.spec.ts` → `EXPECTED_MIGRATIONS` (+ `0020_…`)
- `packages/db/__tests__/schema/catalog/barrel.spec.ts` → `EXPECTED_CATALOG_MODULES` (+ the new module name[s])
- re-call `ensureAppRole` AFTER the migration in any new migration spec (grants only cover tables-at-grant-time — the documented gotcha)
- the cardinality / signal-name drift lists if any new metric is added (R7)
