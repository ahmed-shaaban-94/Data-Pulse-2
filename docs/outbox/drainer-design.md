# Outbox Drainer Design

**Ref**: 004-platform-production-readiness (T548)
**Status**: Draft — Phase 6 design choice. Spike findings (T550–T552) will be recorded here when they run, BUT no spike has been performed yet (gated). Section "Empirical findings" is currently empty.
**Date**: 2026-05-16

**Cross-references**:
- [lifecycle.md](./lifecycle.md)
- [event-types.md](./event-types.md)
- [dead-letter-triage.md](./dead-letter-triage.md)
- [research §9 storage / drainer choice](../../specs/004-platform-production-readiness/research.md)
- [plan §3.3 Track C](../../specs/004-platform-production-readiness/plan.md)

---

## 1. Storage / drainer mechanism (locked per research §9)

### 1.1 Choice

**DB-table polling with `SELECT ... FOR UPDATE SKIP LOCKED`.**

The future `outbox_events` table is read by a BullMQ-orchestrated drainer worker that claims a batch of `pending` (or `failed` past their `next_attempt_at`) rows on each poll tick and hands them to consumers.

### 1.2 Rationale

| Property | Why DB polling wins |
|---|---|
| **Durability** | The event row is written in the **same transaction** as the business state change. If the transaction commits, the event exists. If it rolls back, the event never exists. There is no "publish failed mid-flight" class of bug. |
| **Horizontal scaling** | `FOR UPDATE SKIP LOCKED` lets multiple drainer worker replicas claim disjoint row batches without coordinating. Adding capacity is a deployment knob, not a code change. |
| **No new infra** | PostgreSQL is already a Foundation 001 dependency. No new broker, no new operational surface. |
| **RLS-compatible** | The runtime DB role does not bypass RLS (Constitution §II). The outbox table's policy is designed to fit within that constraint. |
| **Operationally inspectable** | Operators can run a read-only query against the table to inspect backlog, retry counts, and dead-letter rows. No proprietary tooling required. |

### 1.3 Defaults (tunable)

| Knob | Default | Notes |
|---|---|---|
| Poll interval | **1 second** | Trade-off: lower interval → lower end-to-end latency, higher idle DB load. 1s is the starting point; spike (T550–T552) will measure under load. |
| Batch size per claim | **50 rows** | Balances claim-query cost against per-row processing parallelism. |
| Concurrent consumers per worker | **TBD (likely 8–16)** | Pinned during the spike. Each consumer holds one row at a time. |
| Claim heartbeat / reclaim threshold | **TBD** | Rows stuck in `claimed` past this threshold are reclaimed (worker crash recovery). Likely 5× poll interval as a starting point. |

---

## 2. Claim mechanism — illustrative query shape

> **Illustrative, not runnable SQL.** This is design documentation, not a migration. The exact statement is authored in the spike (T550) and in the future schema work (T570/T571), both gated.

```sql
-- illustrative, not a migration, not executable
UPDATE outbox_events
   SET delivery_state = 'claimed',
       attempts = attempts + 1
 WHERE event_id IN (
   SELECT event_id
     FROM outbox_events
    WHERE delivery_state IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY occurred_at ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
 )
RETURNING event_id,
          event_type,
          tenant_id,
          store_id,
          payload,
          correlation_id,
          occurred_at,
          attempts;
```

Key properties:

- **`FOR UPDATE SKIP LOCKED`** in the inner SELECT — peer drainer replicas never block on each other; they walk past locked rows.
- **`ORDER BY occurred_at ASC`** — preserves business event order at the head of the queue. UUIDv7 `event_id` is also time-ordered, so the index on `occurred_at` (or on `event_id`) supports the scan efficiently.
- **`UPDATE ... RETURNING`** — claim and read in one round trip.
- **`delivery_state IN ('pending', 'failed')`** with the `next_attempt_at` guard — pending rows are immediately eligible; failed rows wait for their backoff window.

---

## 3. Rejected alternatives

| Alternative | Status | Reason |
|---|---|---|
| **LISTEN/NOTIFY** | **Deferred** as a later optimization. | NOTIFY is best-effort — it doesn't persist across worker restarts and doesn't fire for rows that were already in the table when a worker came up. We would still need the polling fallback for crash recovery. Adding NOTIFY in slice 1 adds complexity for a marginal latency win. May revisit after the spike measures real polling latency (research §9). |
| **BullMQ-only event publishing (no DB outbox)** | **Rejected.** | Publishing to BullMQ inside a DB transaction is unsafe: the DB transaction can roll back **after** the BullMQ `add()` call has succeeded, leaving the queue with a phantom event for a state change that never happened. The entire point of the outbox is to make the event durable in the **same atomic transaction** as the business write. |
| **Transaction-callback hooks (`pg-listen` style, `AFTER COMMIT` triggers)** | **Rejected** for durability. | Callbacks fire on commit; if the worker that registered the callback crashes between commit and callback delivery, the event is lost. There is no replay mechanism without the durable row. |
| **External event bus (Kafka, NATS, Pulsar)** | **Deferred** indefinitely. | No infra investment yet. DB-polling scales sufficiently for foundation traffic. Introducing a new infra service is a separate gated decision with its own ops surface (provisioning, monitoring, version compatibility). |
| **CDC (logical replication / Debezium against the business tables)** | **Rejected** for slice 1. | CDC would let us skip the outbox table entirely — but it removes the explicit `event_type` registry, makes redaction harder (CDC sees raw rows), and adds significant operational complexity. May revisit only if the outbox table becomes a hot-spot, which is unlikely at foundation traffic. |

---

## 4. Backoff and retry-budget (cross-link)

The drainer enforces the schedule defined in [lifecycle.md §4](./lifecycle.md):

| Attempt | Wait before reclaim |
|---|---|
| 1 | — (initial) |
| 2 | 30s |
| 3 | 2m |
| 4 | 10m |
| 5+ | 1h (plateau) |
| 8 | final — transition to `dead_lettered` |

`next_attempt_at` is the column that records when a failed row becomes claim-eligible again. It is set by the drainer when transitioning a row from `claimed` to `failed`. Schema for this column is added in T570/T571 (future, gated).

---

## 5. Observability

The drainer emits the named signals documented in [`docs/observability/signals.md`](../observability/signals.md), including (but not limited to):

- `outbox_pending_total{event_type, tenant_id}` — gauge of unclaimed rows.
- `outbox_claim_batch_size` — histogram of claim batch sizes.
- `outbox_processing_duration_seconds{event_type, outcome}` — histogram.
- `outbox_dead_letter_total{event_type}` — counter; alerts feed the triage flow.
- `db_rls_context_failure_total` — catches tenant-context regressions in consumers (see [lifecycle.md §6](./lifecycle.md)).

Logs follow the redaction matrix; payloads are never logged in full ([lifecycle.md §7](./lifecycle.md)).

---

## 6. Spike findings (T550–T552)

**Branch**: `spike/004-p6-outbox-drainer-validation` (DO NOT MERGE per tasks.md).
**Date**: 2026-05-17. Full measurements in `spikes/004-outbox-drainer-validation/findings.md`.
**Constitution refs**: Section V (Async Work Belongs in Workers), Section VII (Observable Systems),
Section XIV (PII & Data Lifecycle Discipline).

### T550 -- SKIP LOCKED concurrency (Constitution Section V)

Two concurrent drainer loops each claiming batches of 10 from 200 pending
rows produced zero overlap: drainer A claimed 100 rows, drainer B claimed
100 rows, intersection empty. Wall time ~1 285 ms. A 4-drainer / 2-event
run confirmed SKIP LOCKED returns immediately (non-blocking) when all
eligible rows are locked -- the two drainers that found nothing exited in
~47 ms total with no blocking, no deadlock, no advisory lock pressure.

**Evidence supports the horizontal-scaling claim in Section 1.2 above.**

### T551 -- Retry lifecycle and backoff (Constitution Section V)

The `attempts` counter advanced from 0 to 3 across 3 claim cycles on a
single event. `next_attempt_at` deltas were strictly increasing (114 ms,
209 ms with a compressed test schedule). Final status was `processed` with
`attempts=3`. The `last_error` field held only the sanitized error class
name (`TransientError`), never the raw exception message.

**Spike confirms `attempts` must be incremented at claim time (inside the
claim CTE), not in the failure handler. The production drainer (T570/T571)
must follow this pattern.**

### T552 -- Dead-letter and PII redaction (Constitution Section VII, Section XIV)

A poison event (consumer always throws `IntentionalError`) reached
`dead_lettered` after exactly 8 attempts. `processed_at` was set.
7 pending-retry transitions all had strictly increasing `next_attempt_at`.
8 pino log lines were captured; neither `pii-canary@example.test` nor
`hunter2` appeared in any log line. The canary values were confirmed present
in the `payload` DB column -- the redaction was applied at the logger
boundary as required by Constitution Section XIV and FR-C-008.

**The "never log payload" principle (Section VII) holds: pino redact.paths
catches structured field keys AND the spike code itself never emitted the
payload or any PII-suspect field.**

### Recommendation

Proceed to P7 implementation as designed. The SKIP LOCKED + claim-update
pattern is production-ready for the first outbox slice. See
`spikes/004-outbox-drainer-validation/findings.md` Section 4 for caveats
(statement-timeout interaction, last_error persistence, column naming delta).
