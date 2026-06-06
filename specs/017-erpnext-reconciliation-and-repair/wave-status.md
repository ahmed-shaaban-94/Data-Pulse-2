# Wave Status — `017-erpnext-reconciliation-and-repair`

> Human-readable summary of where the spec stands. 017 is the ERPNext arc's
> **operational reconciliation surface** (011→017): **run → report → repair**. It
> is the home the 015 `015-DLQ-DRAIN` traceability stub and the 014 §8 carve
> pointed to — it makes the 015 posting dead-letter backlog **visible**, exposes an
> **idempotent repair** that re-uses the 015 O-3 state machine, and runs **stock
> reconciliation** (009 vs the connector's ERPNext-Bin view per the 014 mapping).

**Last updated:** 2026-06-06 by Ahmed Shaaban — **implementation COMPLETE end-to-end** on `feat/017-impl` (owner-authorized both `[GATED]` slices in-session; built in an isolated worktree off fresh `main`). All 8 slices GREEN (WSL Testcontainers).
**Spec:** `017-erpnext-reconciliation-and-repair` (`specs/017-erpnext-reconciliation-and-repair/`)
**Base:** `feat/017-impl` off `origin/main` (planning chain MERGED via #507; 015 CLOSED #501–#505; 014-CRUD #495; 009 CLOSED; 012 SHIPPED)
**Status:** **FUNCTIONALLY COMPLETE.** SETUP + `[GATED]` SCHEMA (0020) + `[GATED]` CONTRACT (reconciliation.yaml) + ISOLATION-HARNESS + 🎯 US1-BACKLOG + US2-REPAIR + US3-STOCK + POLISH all built + GREEN.

### Slice ledger (all GREEN, WSL Testcontainers)
| Slice | Tests | Notes |
|---|---|---|
| SETUP | build | empty module registered |
| `[GATED]` SCHEMA (0020) | 32/32 | run + result + repair_attempt; migration round-trip + migrate + barrel drift |
| `[GATED]` CONTRACT | 19/19 | reconciliation.yaml conformance (6 ops, cookieAuth, 014-vocab-only) |
| ISOLATION-HARNESS | 8/8 | RLS sweep on all 3 tables (incl. repair_attempt append-only) |
| US1-BACKLOG 🎯 | 10/10 | read-projection over 015 permanently_rejected; tenant isolation; §XII |
| US2-REPAIR | 9/9 | 4-status branching + retry_count reset + in-tx audit; HTTP idempotency |
| US3-STOCK | 8/8 | worker classification (014 §6.3 order) + stub-tolerant + idempotent; api trigger/get/list/repair |
| POLISH | — | `erpnext_reconciliation_repair_total` (shared); report-only k6; coverage; this reconcile |

### Deferrals carried (not blockers)
- **Live trigger→queue→processor wiring** — the `ReconciliationRunProcessor` is a directly-invokable class (the 015 consumer precedent); the live wiring (an outbox event-type in the `[GATED]` `packages/db` registry, or a BullMQ queue in `worker.module`) is OUT of US3's approved scope → a **separate deferred slice**. **In production-without-wiring a triggered run stays `running`** until that slice lands (NOT claimed live end-to-end).
- **`repairStock` is a state-transition + audit, NOT an ERPNext mutation** — DP2 makes no outbound HTTP and the connector isn't built; `result_state='repaired'` = operator acknowledged+initiated, the actual fix is the 014 admin re-map / connector re_sync when it ships.
- **Live ERPNext-Bin read** — v1 ships the stub-tolerant seam (R3); the live connector→DP2 view contract is `017-STOCK-VIEW-CONTRACT` (future `[GATED]`).
- **Scheduled runs** — v1 is on-demand (R5); scheduling is later wiring over the same processor.
- **Perf report-only** — no perf env (005/008/009/010/015 precedent); k6 thresholds carried, not gating.

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
the platform `audit_events` table + requires the audit write be ATOMIC with the
run/repair state write — via a NEW in-tx `INSERT INTO audit_events`, since the
async `@Auditable` 013/014/015 use is post-response and `insertAuditEvent` forbids
in-tx use), **C2** (SC-006 backlog-depth alerting carved as ops-config, not a DP2
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

---

## Live Verification Wave — `017-VERIFY` (pilot-credibility, post-merge)

**Added:** 2026-06-06 — a **bounded verification/follow-up plan** (NOT a new feature
spec, NOT a refactor) proving DP2 is pilot-credible for ERPNext posting operations
now that **DP-015** (feed/ack/reversal/polish) and **DP-017** (run/report/repair)
are merged on `main` (017 via #509) and the connector poller is live (connector
repo PR #23). Goal: the smallest practical wave that evidences the merged DP2 half
end-to-end and **honestly** marks the cross-system leg as not-yet-run.

### 🟢 RUN LEDGER — DP2-side legs executed 2026-06-06 (WSL Testcontainers, Docker up)

All four slices' **🟢 in-repo legs RUN + GREEN** — **75/75 across 14 suites**; `pnpm -r run build` (tsc strict, 6 packages) clean. The **🔶 cross-system legs were NOT run and are NOT claimed** (no connector + staging ERPNext from this repo).

| Slice | 🟢 leg | Suites | Tests | Result |
|---|---|---|---|---|
| V1 | capture→feed→(recorded)ack→posted | 7 | 41/41 | ✅ RUN+GREEN |
| V2 | rejected → backlog + isolation | 2 | 18/18 | ✅ RUN+GREEN |
| V3 | repair → re-head → (recorded) re-post | 2 | 10/10 | ✅ RUN+GREEN |
| V4 | stock recon (directly-invoked, stub-tolerant) | 3 | 16/16 | ✅ RUN+GREEN |
| **Total** | | **14** | **75/75** | **🟢 DP2 half PASS** |

> Evidence is the green suites listed per-slice below. The single-`document_ref`, sale-fact immutability, RLS isolation, same-`document_ref`-on-repost, and never-guess-warehouse assertions all live **inside** those specs. The 🔶 legs (connector poller → real ERPNext SI/ack, live Bin read, live triggered run) remain prerequisites/stop conditions, unrun.

### The honesty split every slice obeys

The target loop spans **three systems** — DP2 → connector poller → ERPNext → ack.
Two are **out of this repo's reach** (connector = separate repo, "do not touch";
ERPNext = "do not touch directly"). Therefore each slice has two legs:

- **🟢 DP2-side, runnable in-repo now** — real evidence: the already-GREEN
  Testcontainers specs + k6 found below. The connector ack is **simulated/recorded**
  inside these specs (the ack ingest path is driven directly, not by a live poller).
- **🔶 Cross-system live leg** — connector poller + a real/staging ERPNext. This is
  the actual pilot end-to-end. It is **a prerequisite + stop condition, NOT claimed
  runnable or passed from this repo.** Evidence is specified but left **unchecked**
  until run with connector + staging available.

> **No slice has a pass criterion satisfiable only by the connector running against
> ERPNext** — that cannot be run from here, and "do not claim live verification has
> passed unless actually run and evidenced" governs.

### Prerequisites common to all slices

- All on `main`: `0019` `erpnext_posting_status` (015), `0020` reconciliation tables
  (017), `0018` `erpnext_warehouse_map` (014), `0014` `stock_movements` (009).
- DB-backed runs are **WSL Testcontainers** (`reference_007_test_env`); `MIGRATION_TEST_ALLOW_SKIP=1`
  for Docker-less, `WORKER_INCLUDE_DB_TESTS=1` for worker run specs.
- 🔶 legs additionally need: the connector poller pointed at a DP2 instance with a
  `connector`-scoped bearer, and a real/staging ERPNext (ERPNext-major staging
  validation — open arc item). **Absent these, the 🔶 leg does not run.**

### Run commands (do not duplicate — see [`quickstart.md`](./quickstart.md) gate checks)

```
pnpm -r run build                                          # tsc strict (repo has NO eslint/md-lint)
wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- catalog/erpnext-posting"
wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- catalog/erpnext-reconciliation"
wsl -e bash -lc "WORKER_INCLUDE_DB_TESTS=1 pnpm --filter @data-pulse-2/worker test -- erpnext-posting erpnext-reconciliation"
wsl -e bash -lc "WORKER_INCLUDE_DB_TESTS=1 pnpm --filter @data-pulse-2/worker test -- sales/dp-008-liveloop"
```

---

### Slice V1 — DP2 posting half: capture → feed → (recorded) ack → posted 🎯 FIRST

- **Purpose:** prove the merged DP2 posting half end-to-end with **zero external
  dependency** — a processed 008 sale becomes a `pending` posting work-item, is
  offered on the feed, and a `posted` ack flips it to `posted` with **exactly one**
  `document_ref`. This is flow 1's DP2 leg.
- **Prerequisites:** common prerequisites only. No connector, no ERPNext.
- **Run (🟢 in-repo):**
  - `apps/worker/test/sales/dp-008-liveloop.e2e.spec.ts` — capture→outbox→drain→`processed_at` (the live-loop precedent).
  - `apps/worker/test/erpnext-posting/posting-requested-consumer.spec.ts` — sale→`pending` / `unmapped_item` / `unmapped_store`, idempotent re-run.
  - `apps/api/test/catalog/erpnext-posting/feed/{posting-feed,build-work-item}.spec.ts` — resolved `erpnextItemRef`, posted-excluded, exact-decimal money, cursor replay.
  - `apps/api/test/catalog/erpnext-posting/ack/posting-ack.spec.ts` + `http/posting-ack-http-edge.spec.ts` — `posted`/`failed_transient`-re-head/`permanently_rejected`, two-layer idempotency, §XII 404.
- **Evidence to collect:** suite pass counts (expect feed 5/5, ack 7/7 + edge 8/8, consumer 5/5 per 015 ledger); a `posting_status` row transitioning `pending→posted` with a single non-null `document_ref`; the 008 `sales` row byte-identical before/after (immutability).
- **Pass/fail:** 🟢 PASS = all listed specs green + single `document_ref` + sale-fact unchanged. **FAIL** if any spec regresses or a 2nd `document_ref` appears.
- **✅ RUN+GREEN (2026-06-06):** worker 8/8 (`dp-008-liveloop.e2e` + `posting-requested-consumer`, `WORKER_INCLUDE_DB_TESTS=1`) + api 33/33 (`build-work-item` + `posting-feed` + `posting-ack` + 2× http-edge) = **41/41 across 7 suites**, WSL Testcontainers.
- **🔶 Cross-system live leg (NOT run here):** the connector poller actually GETs the feed and POSTs a real ERPNext Sales-Invoice ack. Evidence *to collect when run*: a real ERPNext SI doc id echoed back; DP2 row `posted`. **Unchecked.**
- **Stop conditions:** the ack in 🟢 is **recorded/simulated**, not a live poller — do not claim flow 1 is live end-to-end (Deferrals: "live trigger→queue→processor wiring", line 28). If a live e2e harness is wanted, **STOP and report it as a proposed slice** — do not write it.

### Slice V2 — Rejected posting → 017 backlog (flow 2)

- **Purpose:** prove a `permanently_rejected` posting surfaces in the 017 dead-letter
  backlog with class + provenance + reason, tenant-isolated.
- **Prerequisites:** common only. Reuses V1's reject paths (`unmapped_item` / `unmapped_store` / `validation`).
- **Run (🟢 in-repo):**
  - `apps/api/test/catalog/erpnext-reconciliation/backlog/posting-backlog.spec.ts` — read-projection over `status='permanently_rejected'`; class/provenance/reason; healthy rows absent; pagination/sort/group.
  - `apps/api/test/catalog/erpnext-reconciliation/isolation/reconciliation-sweep.spec.ts` — RLS sweep, wrong-`app.current_tenant` → 0 rows.
- **Evidence to collect:** backlog returns exactly the seeded dead-letters (per quickstart US1: 3 rejected of 5); tenant-B call returns none of tenant-A's; suite pass counts (expect US1 10/10, isolation 8/8).
- **Pass/fail:** 🟢 PASS = both specs green + correct backlog membership + isolation. **FAIL** on cross-tenant leak or healthy-row inclusion.
- **✅ RUN+GREEN (2026-06-06):** api **18/18 across 2 suites** (`posting-backlog` + `reconciliation-sweep`), WSL Testcontainers.
- **🔶 Cross-system live leg:** the reject originates from a **real** ERPNext validation failure relayed by the connector ack (vs. the in-repo seeded reject). Evidence *to collect when run*: a connector-relayed `permanently_rejected` with a real ERPNext reason. **Unchecked.**
- **Stop conditions:** none beyond V1's recorded-ack caveat (the reject is seeded/recorded, not connector-relayed).

### Slice V3 — Operator repair → re-head → (recorded) re-post → posted (flow 3)

- **Purpose:** prove the idempotent repair re-uses the 015 O-3 state machine — a
  fixed dead-letter flips `permanently_rejected → pending` + **re-heads `sequence`**,
  is re-offered on the feed, and a `posted` ack resolves to the **same**
  `document_ref` (no 2nd document, no silent rewrite).
- **Prerequisites:** common only. A V2 backlog row whose cause is confirmed fixed.
- **Run (🟢 in-repo):**
  - `apps/api/test/catalog/erpnext-reconciliation/repair/posting-repair.spec.ts` — 4-status branching, `retry_count` reset, in-tx audit, `repair_attempt.outcome`.
  - `apps/api/test/catalog/erpnext-reconciliation/http/posting-repair-http-edge.spec.ts` — HTTP idempotency.
  - Re-offer + `no_op_echo` re-verified via the V1 feed/ack specs (the same 012 loop).
- **Evidence to collect:** `permanently_rejected→pending` + re-headed `sequence`; `repair_attempt outcome=eligible_again`; second repair of a now-`posted` row → `no_op_echo` + same `document_ref`; a still-broken repair → stays `permanently_rejected` + `outcome=still_failing` + returns to backlog; 008 `sales` byte-identical before/after every repair; suite counts (expect repair 9/9 + edge per ledger).
- **Pass/fail:** 🟢 PASS = repair specs green + same-`document_ref` on re-post + sale-fact unchanged + still-broken returns to backlog. **FAIL** on a 2nd `document_ref`, a rewrite, or a sale-fact mutation.
- **✅ RUN+GREEN (2026-06-06):** api **10/10 across 2 suites** (`posting-repair` incl. `eligible_again`/`no_op_echo`/`still_failing` branches + `posting-repair-http-edge` idempotency), WSL Testcontainers.
- **🔶 Cross-system live leg:** the connector actually re-posts the re-headed work-item to ERPNext and acks `posted`. Evidence *to collect when run*: same ERPNext SI doc id as (or, for a previously-never-posted row, a single new id). **Unchecked.**
- **Stop conditions:** `repairStock`/repair is a **state-transition + audit, NOT an ERPNext mutation** (Deferrals line 29) — DP2 makes no outbound HTTP; the actual ERPNext fix is the connector re-post when it runs. Do not claim the repost reached ERPNext from in-repo evidence.

### Slice V4 — Stock reconciliation run (current-limit, stub-tolerant) (flow 4)

- **Purpose:** prove the stock reconciliation classification logic over a known DP2
  divergence using the **stub-tolerant** ERPNext-Bin seam, and **honestly mark the
  live Bin read + live triggered run as deferred**.
- **Prerequisites:** common only. A mapped store (014), a seeded 009 on-hand divergence, a **stub/recorded** ERPNext-Bin view (connector seam, research R3).
- **Run (🟢 in-repo):**
  - `apps/worker/test/erpnext-reconciliation/reconciliation-run.spec.ts` (`WORKER_INCLUDE_DB_TESTS=1`) — processor classification in 014 §6.3 order, stub-tolerant, idempotent (**directly-invoked**, not queue-triggered).
  - `apps/api/test/catalog/erpnext-reconciliation/run/{stock-run-api,stock-service-branches}.spec.ts` — trigger/get/list/repair API; classification branches.
- **Evidence to collect:** classified results per 014 vocabulary (unmapped store → `unmapped_store`, never a guessed warehouse); the 009 ledger + 008 sale fact unchanged before/after the run; suite counts (expect US3 8/8).
- **Pass/fail:** 🟢 PASS = run + API specs green via the directly-invoked processor + correct classification + ledger/sale-fact unchanged. **FAIL** on a ledger mutation or a guessed warehouse.
- **✅ RUN+GREEN (2026-06-06):** worker 4/4 (`reconciliation-run`, directly-invoked, `WORKER_INCLUDE_DB_TESTS=1`) + api 12/12 (`stock-run-api` + `stock-service-branches`) = **16/16 across 3 suites**, WSL Testcontainers. **🔶 live Bin read + live triggered run remain deferred + unrun** (processor not wired into `worker.module.ts`).
- **🔶 Cross-system live leg (the current limit):** a **live ERPNext-Bin read** through the connector + a **live triggered run** (trigger → queue → processor). Both are **deferred** (Deferrals lines 28, 30): `reconciliation-run.processor.ts` is **NOT wired into `apps/worker/src/worker.module.ts`** (verified 2026-06-06), and the live Bin read needs the future `[GATED]` `017-STOCK-VIEW-CONTRACT`. **A triggered run in production-without-wiring stays `running`** — do not claim a live run.
- **Stop conditions:** **do NOT implement the worker wiring or the Bin-read contract** — both are forbidden production-code surfaces here. In-repo evidence is the **directly-invoked processor only**. Scheduled runs (`017-SCHEDULED-RUNS`) are likewise deferred (Deferrals line 31).

---

### Known deferred items (carried from "Deferrals carried", lines 28–32)

| Deferred | Owning slice | Why it cannot be verified live here |
|---|---|---|
| Live trigger → queue → processor wiring | `017-` follow-up (not specced) | `reconciliation-run.processor.ts` absent from `worker.module.ts`; triggered run stays `running`. |
| Live ERPNext-Bin read | `017-STOCK-VIEW-CONTRACT` (future `[GATED]`) | Connector→DP2 view contract not authored; v1 is stub-tolerant. |
| Scheduled reconciliation runs | `017-SCHEDULED-RUNS` (proposed) | v1 is on-demand (R5); scheduling is later wiring over the same processor. |
| Perf assertions | report-only (k6) | No perf env (005/008/009/010/015 precedent). `loadtests/k6/erpnext-posting.js` + `loadtests/k6/erpnext-reconciliation.js` ready; thresholds carried, not gating. |

### Recommendation — execute V1 first

**Run `017-VERIFY` Slice V1 first.** It is the **fully in-repo-runnable baseline with
zero external dependency** — re-running the already-green 015/017 posting suites +
the DP-008 live-loop e2e proves the DP2 half is pilot-credible with no connector or
ERPNext gating, the cheapest highest-signal start. V2 and V3 build on V1's reject and
repair paths (also fully in-repo). V4 is in-repo only for the **directly-invoked
processor**; its live legs are deferred. The 🔶 cross-system legs of V1/V2/V3 run
**after** the connector + a staging ERPNext are available (ERPNext-major staging
validation is the gating open-arc item) — they are **not** runnable or claimable from
this repo.
