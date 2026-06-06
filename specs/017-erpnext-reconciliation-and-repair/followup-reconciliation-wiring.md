# Follow-up Slice Spec — `017-RECON-WIRING` (live trigger → queue → processor)

**Status:** PROPOSED — spec only, **no code authored**. Closes the "live trigger→queue→processor wiring" deferral (017 wave-status "Deferrals carried" line 28; `017-VERIFY` V4 🔶 leg). **Touches production worker code and — on the recommended path — a `[GATED]` `packages/db` surface. STOP for explicit owner approval before any implementation.**

**Author date:** 2026-06-06. **Base:** `main @ da19d58` (post-`017-VERIFY` merge #510).

---

## 1. Problem (verified from source, not assumed)

A stock-reconciliation run today is **created but never executed in a running system**:

- **API** `erpnext-reconciliation.service.ts:349 triggerRun()` inserts an `erpnext_reconciliation_run` row with `status='running'` + a `audit_events` row, **in one transaction**, and returns it. Its own docstring (lines 342–346) states: *"It does NOT enqueue/emit — the live trigger→queue→processor wiring (an outbox event-type / a BullMQ queue) touches gated/cross-cutting [scope]… a triggered run stays `running` (the processor is invoked directly in tests)."*
- **Worker** `erpnext-reconciliation/reconciliation-run.processor.ts:70 ReconciliationRunProcessor` is a **directly-invokable class** (`process({runId, tenantId})`) and is **NOT registered in `worker.module.ts`** (verified: no `Reconciliation*` reference in the module; `017-VERIFY` confirmed).

**Net:** in production, `POST …/runs` returns a `running` run that **never advances to `completed`** — there is nothing wired to call `process()`. The processor's classification logic is proven (V4 16/16) but only via direct invocation in tests.

This slice builds the missing transport. It is **DP2-internal only** — it does **NOT** make the ERPNext-Bin read live (that stays the stub-tolerant `EMPTY_BIN_VIEW` seam, deferred to the future `[GATED]` `017-STOCK-VIEW-CONTRACT`). A wired run over the empty Bin view classifies every DP2-on-hand item as `dp2_only` and completes — which is correct, observable, and a real end-to-end advance from `running`.

---

## 2. Two candidate mechanisms (the gate decision)

### Option A — Outbox event-type (RECOMMENDED)

`triggerRun` emits an `erpnext.reconciliation.requested` outbox event **in the same transaction** as the run insert (the exact 015 `erpnext.posting.requested` precedent). A `ReconciliationRequestedConsumer` registers into the **already-wired** `OutboxConsumerRegistry` inside `drainerProcessorProviderFactory` (worker.module.ts:434–450, where the 015 `PostingRequestedConsumer` already registers — it holds both the pool and the mutable registry, and runs **before** `OutboxDrainerRunner.onModuleInit` starts the poll loop, so there is no register-after-drain race). The consumer constructs `ReconciliationRunProcessor(pool, EMPTY_BIN_VIEW)` and calls `process()`.

- **Gate:** **`[GATED]` `packages/db`** — adds `erpnext.reconciliation.requested` to `OUTBOX_EVENT_TYPES` (per `docs/outbox/event-types.md`; the 015 EVENT-TYPE / T541-style approval).
- **Blast radius:** small. Reuses the existing drain loop + registry seam; no new queue, no new worker class, no new `WORKER_QUEUE_NAMES` entry (so the lag-gauge guard spec that pins the count is untouched).
- **Idempotency:** at-least-once drain is safe — the processor's terminal write is already guarded (`UPDATE … SET status='completed' WHERE id=$1 AND status='running'`, processor lines 208–215); a redelivery is a 0-row no-op (`status:'skipped'`).

### Option B — Dedicated BullMQ queue

`triggerRun` enqueues a job onto a new `erpnext-reconciliation` queue; a new `ReconciliationRunWorker` (mirroring `SaleWorker`) consumes it.

- **Gate:** no `packages/db` gate, BUT adds a `WORKER_QUEUE_NAMES` entry in the **forbidden** `worker.metrics.ts` (the lag-gauge guard spec pins the exact count — same constraint that deferred the 008 lag-gauge entry, worker.module.ts:646–651) + a new queue-config DLQ entry. More cross-cutting test churn; a second consumption path alongside the outbox drainer.

**Recommendation: Option A.** Lower blast radius despite the `packages/db` gate, because the drain loop and registry seam already exist and the idempotency guard is already in place — it is the smallest correct transport. Option B duplicates a consumption mechanism the worker already runs.

---

## 3. Minimal slice (Option A) — files & order

| Step | File | Gate | Change |
|---|---|---|---|
| 1 | `packages/db` `OUTBOX_EVENT_TYPES` (+ event-types doc) | **`[GATED]` `packages/db`** | register `erpnext.reconciliation.requested` |
| 2 | `apps/api/.../erpnext-reconciliation.service.ts` | app code | `triggerRun` emits the event in-tx (mirror the 008 `SaleProcessingProcessor` posting emit / 015) |
| 3 | `apps/worker/.../erpnext-reconciliation/reconciliation-requested.consumer.ts` | app code | new consumer: parse payload → `new ReconciliationRunProcessor(pool, EMPTY_BIN_VIEW).process(...)` |
| 4 | `apps/worker/src/worker.module.ts` | app code (NOT gated) | register the consumer inside `drainerProcessorProviderFactory` (alongside `PostingRequestedConsumer`, lines 442–448) |

**Forbidden / out of scope (do NOT expand into these):** the live ERPNext-Bin read (`017-STOCK-VIEW-CONTRACT`); scheduled runs (`017-SCHEDULED-RUNS`); any 012 contract change; the lag-gauge / DLQ-config entries (a monitoring follow-up owns those files — same carve as 008 WIRING).

---

## 4. TDD plan (RED → GREEN, WSL Testcontainers)

1. **Event-type registry test** — `erpnext.reconciliation.requested` present (the 015 registry-spec idiom).
2. **API emit test** — `triggerRun` writes the run row + the outbox event **atomically** (one transaction; roll back → neither persists).
3. **Consumer test** — given a `running` run + an emitted event, the consumer calls `process()` and the run flips `running→completed`; redelivery is an idempotent no-op (`skipped`).
4. **Worker-module wiring test** — `drainerProcessorProviderFactory` registers the reconciliation consumer (assert via the registry, the 015 wiring-spec precedent); no-DB path still boots (consumer not registered when `pool === null`).
5. **(Optional) Docker-gated e2e** — trigger via API → drain → run `completed` over `EMPTY_BIN_VIEW` (all items `dp2_only`); mirrors `dp-008-liveloop.e2e.spec.ts`. *If a new e2e harness file is needed beyond extending an existing one, STOP and confirm first.*

**Verify each PR:** `pnpm -r run build` + `wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- catalog/erpnext-reconciliation"` + `wsl -e bash -lc "WORKER_INCLUDE_DB_TESTS=1 pnpm --filter @data-pulse-2/worker test -- erpnext-reconciliation"`.

---

## 5. Stop conditions

- **STOP before any code** — this spec authorizes nothing. Implementation needs explicit owner approval, and Step 1 is a **separate `[GATED]` `packages/db` approval** (dispatching it = approving that surface).
- Do **NOT** make the ERPNext-Bin read live, add scheduled runs, touch a 012 contract, or add `WORKER_QUEUE_NAMES` / DLQ-config entries — all out of scope.
- If the work wants a brand-new e2e harness file (vs. extending an existing spec), STOP and report.
- Honesty boundary unchanged: this wires the **DP2-internal** run end-to-end (trigger→drain→`completed`); it does **NOT** make the cross-system connector→ERPNext leg live. `017-VERIFY` V4's 🔶 live Bin read stays deferred.

---

## 6. What this delivers when merged

A `POST …/runs` in a running system advances `running → completed` with classified results — the DP2-internal reconciliation loop is live and observable, closing the V4 wiring deferral. The connector-fed live Bin read remains the only thing standing between this and a true cross-system reconciliation, gated on `017-STOCK-VIEW-CONTRACT` + the connector repo + staging ERPNext.
