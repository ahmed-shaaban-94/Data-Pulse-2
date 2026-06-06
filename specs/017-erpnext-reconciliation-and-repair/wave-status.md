# Wave Status — `017-erpnext-reconciliation-and-repair`

> Human-readable summary of where the spec stands. 017 is the ERPNext arc's
> **operational reconciliation surface** (011→017): **run → report → repair**. It
> is the home the 015 `015-DLQ-DRAIN` traceability stub and the 014 §8 carve
> pointed to — it makes the 015 posting dead-letter backlog **visible**, exposes an
> **idempotent repair** that re-uses the 015 O-3 state machine, and runs **stock
> reconciliation** (009 vs the connector's ERPNext-Bin view per the 014 mapping).

**Last updated:** 2026-06-06 by Ahmed Shaaban — full Spec-Kit planning chain authored (spec → plan → research → data-model → contracts → tasks → execution-map + this file); `/speckit-analyze` clean (0 crit/0 high; 2 medium + 4 low REMEDIATED via "fix all"). **NOT STARTED** — no slice dispatched; the two `[GATED]` slices + the first `apps/api` slice are owner thresholds not yet crossed.
**Spec:** `017-erpnext-reconciliation-and-repair` (`specs/017-erpnext-reconciliation-and-repair/`)
**Base:** `origin/main` (015 CLOSED #501–#505; 014-CRUD #495; 009 CLOSED; 012 SHIPPED)
**Status:** **planning complete, implementation NOT STARTED.** MVP = `017-US1-BACKLOG` (the visible posting dead-letter backlog) once the two `[GATED]` foundational slices (`017-CONTRACT` + `017-SCHEMA`) + the isolation harness land.

---

## SIGN-OFF Decisions (017-SIGNOFF, T001–T003 — recorded 2026-06-06)

### T001 — `017-SIGNOFF-STATE`: a new `[GATED]` `erpnext_reconciliation_*` table family (READ, not mirror, the 015 dead-letters)

**Decision: a new `[GATED]` reconciliation-state table family** (`erpnext_reconciliation_run` + `…_result` + `…_repair_attempt`, migration `0020` indicative). 017 **owns** its durable runs / mismatch reports / repair-attempt audit — those are first-class facts an operator returns to and cannot be derived. But the posting dead-letter backlog itself **lives in 015** (`erpnext_posting_status`): 017 **reads it in place** (a read-projection over `status='permanently_rejected'`), it **never mirrors** it — mirroring a derived projection is the 010 RESTRICT-vs-CASCADE drift trap (`READ-NOT-MIRROR-015` finding). Tables are RLS fail-closed (empty-GUC CASE), append-only repair audit (no DELETE policy), **no money / no PII** column (BUSINESS-class, §XIV). Full rationale: [data-model.md §2](./data-model.md). Mirrors `015-SIGNOFF-STATE` / `010-SIGNOFF-READONLY`.

### T002 — repair re-uses the 015 O-3 state machine (no new primitive)

**Decision:** a posting repair is a **state transition on the existing 015 `erpnext_posting_status` row** — re-evaluate 015-RESOLVE, and if resolved, flip `permanently_rejected → pending` + **re-head `sequence`** (the exact mechanism `connectorAckOutcome` already ships for `failed_transient` re-offer). The connector then re-posts via the **existing** 012 feed/ack — DP2 makes **no outbound ERPNext HTTP**. The 015 O-3 unique `(tenant_id, source_ref_id)` + the ack echo already guarantee **exactly one `document_ref`** across re-offer + ack, so a repaired posting that succeeds resolves to the same document; a repair of an already-`posted` row is a no-op echo. **Bounded by `POSTING_RETRY_BUDGET`** (no unbounded re-offer). NOT a new posting/idempotency primitive, NOT DP2 calling ERPNext (`REPAIR-REUSES-015-O3` finding / research R1).

### T003 — v1 scope carve: on-demand, connector-seam (stub-tolerant), human-only

**Decision:** v1 ships **on-demand** reconciliation runs (scheduled is later wiring over the same idempotent processor — R5); the stock-run ERPNext-Bin read is a **connector seam behind the fixed 012 boundary**, and v1 is **stub-tolerant** (an injected seam; an absent view → reported `erpnext_only`/unavailable, never a run failure) so 017's DP2-side run + report + repair ship independently of the connector repo (`STOCK-VIEW-CONNECTOR-SEAM` / R3); every 017 surface is **human Tenant Admin (`cookieAuth` / DashboardAuthGuard)** — no machine/connector path (FR-018 / R6). The **live** ERPNext read activates via a future `[GATED]` connector→DP2 view contract.

---

## TL;DR

017 implements the **machinery** two signed/shipped predecessors deferred here:

- **From 015** (the `015-DLQ-DRAIN` stub): surface the posting dead-letter backlog
  (US1 🎯 MVP) + the **idempotent repair / re-post** workflow (US2) — a repair
  resolves to the **same `document_ref`**, never a 2nd document or a silent
  rewrite (the 015 O-3 invariant, re-used).
- **From 014** (the §8 014↔017 carve, gated by SIGNED 011-DR-STOCK-IMPACT §5):
  **014 defines** the mismatch vocabulary; **017 owns** the reconciliation **run**,
  the persisted **mismatch reports**, and the **repair API** (re-post / re-map /
  re-sync / drain) (US3).

**No new ERPNext authority** (DP2 = operational on-hand truth; reconciliation
never silently overwrites either side). **No outbound ERPNext HTTP from DP2**
(the connector is the only ERPNext-calling component, ADR 0008). The **008 sale
fact + 009 ledger are NEVER mutated** — only 015 posting state / 017 reconciliation
state advances (§IX).

---

## Slices (execution-map.yaml)

| Slice | Tasks | Gate | Status |
|---|---|---|---|
| `017-SIGNOFF` | T001–T003 | `[SIGN-OFF]` | ready (decisions above) |
| `017-SETUP` | T004 | — | ready |
| `017-CONTRACT` | T010 | `[GATED]` `packages/contracts` | proposed |
| `017-SCHEMA` | T012a, T012 | `[GATED]` `packages/db` (`0020`) | proposed |
| `017-ISOLATION-HARNESS` | T020 | — | blocked (waits SCHEMA) |
| `017-US1-BACKLOG` 🎯 | T030–T034 | — | blocked (MVP) |
| `017-US2-REPAIR` | T040–T044 | — | blocked |
| `017-US3-STOCK` | T050–T056 | — | blocked |
| `017-POLISH` | T090–T092 | — | blocked |
| `017-STOCK-VIEW-CONTRACT` | T100 | `[GATED]` future | proposed (non-dispatchable — connector repo absent) |
| `017-SCHEDULED-RUNS` | T101 | — | proposed (later wiring) |

**Two `[GATED]` thresholds** (`017-CONTRACT` + `017-SCHEMA`) are parallel-safe with
each other (disjoint `packages/contracts` vs `packages/db` files); both block the
capability slices and both wait on the `017-SIGNOFF` decisions. **No new outbox
event-type, no 012 contract change** — repair re-uses the 015 state machine; the
connector re-posts via the existing 012 feed/ack.

---

## Dependencies & gates (verified 2026-06-06 against `main`)

| Gate | State |
|---|---|
| **gated_by**: 011-DR-STOCK-IMPACT (§5 assigns run/report/repair to 017) SIGNED | ✅ SIGNED 2026-06-03 |
| **gated_by**: 011-DR-POSTING (+ rider) SIGNED | ✅ SIGNED 2026-06-03/05 |
| **depends_on**: 015 `erpnext_posting_status` + the recon signal on `main` | ✅ CLOSED (#501–#505) — `0019` + `connectorAckOutcome` + `erpnext_posting_reconciliation_total` |
| **depends_on**: 014 `erpnext_warehouse_map` + mismatch vocabulary on `main` | ✅ CLOSED (#495) — `0018` + the §7.4 vocabulary |
| **depends_on**: 009 `stock_movements` on `main` | ✅ CLOSED — `0014` compute-on-read on-hand |
| **depends_on**: 012 `posting-feed.yaml` on `main` (read-only) | ✅ SHIPPED |
| **prerequisite**: connector repo (live ERPNext-Bin read) | ⏳ NOT built — v1 ships stub-tolerant (R3); the live read is a future `[GATED]` view contract (`017-STOCK-VIEW-CONTRACT`) |

---

## /speckit-analyze result (2026-06-06) — clean after "fix all"

0 critical / 0 high. Remediated: **I1** (namespace `/api/admin/v1` → the real
`/api/v1/catalog/erpnext-reconciliation` 014 convention), **C1** (FR-014 now names
the platform `audit_events` pipeline, audit-in-transaction with the run/repair
state write), **C2** (SC-006 backlog-depth alerting carved as ops-config, not a DP2
task), **U1** (`repair_attempt` audit vs `result_state` workflow status — both
written atomically), **A1** (spec US3 discloses the stub-tolerant connector seam),
**X1** (typo `toBacklogItem`). Coverage: 100% of 19 FR + 6 SC have ≥1 task.

---

## Next recommended action

Dispatch order (each its own feature branch, per-slice commit/PR, owner merges —
the 015 cadence): record the **`017-SIGNOFF`** decisions (already captured above) →
**`017-SETUP`** (empty module) → the two **`[GATED]`** slices **`017-CONTRACT`** +
**`017-SCHEMA`** (need explicit in-session approval of BOTH) → **`017-ISOLATION-
HARNESS`** → **`017-US1-BACKLOG`** 🎯 (the shippable MVP on already-merged 015 data)
→ **`017-US2-REPAIR`** → **`017-US3-STOCK`** → **`017-POLISH`**. `017-STOCK-VIEW-
CONTRACT` (live ERPNext read) + `017-SCHEDULED-RUNS` are post-v1, non-dispatchable
from this map.

> The 015 rider's **Payment Entry** arc remains separate + later-gated (DP2 tender
> model → 012 payment extension → connector PE → payment repair); 017 does not
> touch it.
