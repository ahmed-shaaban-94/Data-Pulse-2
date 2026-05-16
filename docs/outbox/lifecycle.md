# Outbox Event Lifecycle

**Ref**: 004-platform-production-readiness (T540, T542–T547)
**Status**: Draft — Phase 6 design artifact (docs only, no spike/migration on main)
**Constitution**: v3.0.0 (esp. §V Async Work Belongs in Workers, §VII Observable Systems, §XIV PII & Data Lifecycle Discipline)
**Date**: 2026-05-16

**Cross-references**:
- [spec §8 Track C](../../specs/004-platform-production-readiness/spec.md)
- [plan §3.3 Track C](../../specs/004-platform-production-readiness/plan.md)
- [research §8 dead-letter triage, §9 storage/drainer choice](../../specs/004-platform-production-readiness/research.md)
- [redaction matrix](../../.specify/memory/redaction-matrix.md)
- [event type registry](./event-types.md)
- [drainer design](./drainer-design.md)
- [dead-letter triage](./dead-letter-triage.md)

---

## 1. End-to-end lifecycle (T540)

A single outbox event travels through five mandatory stages and an optional sixth (dead-lettering). The whole flow exists to make event emission **atomic with the business state change** while keeping consumer-side work safely asynchronous and retryable.

### 1.1 ASCII flow

```
   +-------------+      +----------+      +-----------+      +----------+      +-----------+
   | Producer    | ---> | outbox   | ---> | drainer   | ---> | consumer | ---> | delivered |
   | (in same    |      | (DB row, |      | (poll +   |      | (tenant  |      | (or dead- |
   |  tx as the  |      |  state = |      |  claim +  |      |  ctx +   |      |  lettered |
   |  business   |      |  pending)|      |  attempt) |      |  dedup)  |      |  after 8) |
   |  change)    |      +----------+      +-----------+      +----------+      +-----------+
   +-------------+            |                 |                  |                 |
                              |                 v                  v                 v
                              |          state = claimed     state = delivered  state = dead_
                              |                                                  lettered
                              v
                       retention sweep
                       (90d delivered /
                        365d failed/audit)
```

### 1.2 Stage-by-stage

| # | Stage | Who | What happens | Failure mode | Recovery |
|---|---|---|---|---|---|
| 1 | **Produce** | API handler / worker | Within the same DB transaction as the business write, insert one row into `outbox_events` with `delivery_state='pending'`. | Transaction rolls back → row never exists. **Correct behavior** — no event without state. | None needed. The producer never publishes outside the transaction. |
| 2 | **Claim** | Drainer worker | Polls the table, claims a batch via `FOR UPDATE SKIP LOCKED`, sets `delivery_state='claimed'` and `attempts = attempts + 1`. | Worker crashes mid-claim → row stays `claimed` past a heartbeat threshold → reclaim sweep restores it to `pending`. | Reclaim sweep (T549 design / future worker). |
| 3 | **Process** | Consumer (in worker) | Establishes tenant context from the event's `tenant_id`, performs the business side-effect, records `(consumer_id, event_id)` in the dedup projection. | Side-effect throws → row transitions to `failed`; `next_attempt_at` is set per backoff schedule. | Drainer re-claims when `next_attempt_at <= now()`. |
| 4 | **Deliver** | Consumer | Marks the row `delivered`, sets `processed_at = now()`. | None — terminal happy path. | n/a |
| 5 | **Retain or dead-letter** | Retention worker / drainer | Successful rows live 90 days, then are deleted. Failed/dead-lettered rows live 365 days. After 8 total attempts, a `failed` row transitions to `dead_lettered`. | Dead-letter row stays visible to operators. | Triage (see [dead-letter-triage.md](./dead-letter-triage.md)). |

The lifecycle is at-least-once. Exactly-once is the consumer's responsibility, achieved via §5 below.

---

## 2. Durable event field set (T542)

The columns below are the **design contract** for the future `outbox_events` table. This document is not a migration. Schema work is gated per plan §5 and tasks.md §9.

| Column | Type | Nullable | Intent |
|---|---|---|---|
| `event_id` | UUIDv7 | NOT NULL | Primary key. Time-ordered so the claim query scans the head of the index efficiently. Also the **consumer dedup key** (see §5). |
| `event_type` | TEXT | NOT NULL | Registry-controlled name (see [event-types.md](./event-types.md)). First registered type: `audit.event.created`. |
| `tenant_id` | UUID | NOT NULL | Tenant scope of the event. The consumer uses this to establish tenant context (see §6). RLS scopes reads to this column. |
| `store_id` | UUID | NULLABLE | Store scope when the event is store-level. Tenant-level events leave this NULL. |
| `payload` | JSONB | NOT NULL | Event-type-specific body. Subject to redaction at the logger boundary (see §7). Never logged in full. |
| `correlation_id` | UUID | NOT NULL | End-to-end trace id from the originating request or job. Carries through the consumer's downstream calls. |
| `occurred_at` | TIMESTAMPTZ | NOT NULL | Business event timestamp (UTC). Distinct from `created_at` for events that record a past moment. |
| `delivery_state` | TEXT | NOT NULL | Enum: `pending`, `claimed`, `delivered`, `failed`, `dead_lettered`. |
| `attempts` | INT | NOT NULL | Default 0. Incremented on every claim. Budget is 8 (see §4). |
| `last_error` | TEXT | NULLABLE | Redacted error class + identifiers. **Never** the full exception string when it could embed payload values. **Never** PII. |
| `created_at` | TIMESTAMPTZ | NOT NULL | Row insert time, equal to the producer's transaction commit time. |
| `processed_at` | TIMESTAMPTZ | NULLABLE | Set when the row transitions to `delivered` or `dead_lettered`. |

A `next_attempt_at` column (TIMESTAMPTZ NULLABLE) is also expected to support the backoff schedule (§4); it is added to the schema in future tasks T570/T571.

---

## 3. Retention windows (T543) — Q2 locked decision

Per spec §1.5 Q2 (clarified 2026-05-16):

| Class | Window | Notes |
|---|---|---|
| `delivered` | **90 days** | Successful events. After 90 days the row is deleted by the retention worker. |
| `failed`, `dead_lettered`, audit-relevant | **365 days** | Investigation surface. Audit-relevant events (e.g. `audit.event.created`) inherit the longer window regardless of final state. |
| Right-to-erasure target | **Overrides both** | FR-C-004 / spec §14.12. When a right-to-erasure flow tombstones a subject, PII fields in matching outbox rows are tombstoned regardless of which retention class the row falls under. The row's metadata (state, timestamps, redacted error class) MAY remain to preserve audit immutability. |

Cleanup is **not** the drainer's job. A separate `apps/worker/src/outbox/retention.processor.ts` (T590, future, gated) runs on a daily schedule. The drainer never deletes rows.

---

## 4. Poison / dead-letter behavior (T544)

### 4.1 Retry budget
- **8 attempts total**: 1 initial + 7 retries. There is no 9th attempt.
- The drainer increments `attempts` on every claim, regardless of outcome.
- On the 8th failure the row transitions from `failed` to `dead_lettered` and `processed_at` is set.

### 4.2 Backoff schedule (bounded exponential, capped)

| Attempt | Wait before next claim |
|---|---|
| 1 (initial) | — |
| 2 | 30s |
| 3 | 2m |
| 4 | 10m |
| 5 | 1h |
| 6 | 1h |
| 7 | 1h |
| 8 | 1h (then → `dead_lettered`) |

The cap at 1h keeps poison rows visible on operator timescales without overwhelming the queue when many rows pile up.

### 4.3 Never silently drop
- Failed and dead-lettered rows **remain in the table** for the 365-day retention window.
- They surface to operators through the triage flow ([dead-letter-triage.md](./dead-letter-triage.md)) and through the `outbox_dead_letter_total` metric.
- `last_error` is mandatory on every transition to `failed` or `dead_lettered`. It stores a **redacted** error class and the `correlation_id`. It **never** stores the raw payload, raw exception string, or any PII.

---

## 5. Idempotent consumer contract (T545)

### 5.1 Dedup key
- The consumer treats `event_id` as the **dedup key**.
- Because the drainer guarantees at-least-once, the consumer MUST tolerate re-delivery.

### 5.2 Per-consumer projection

A separate table (designed but not migrated in this feature) records every successful processing:

```
processed_events
  consumer_id   TEXT NOT NULL
  event_id      UUIDv7 NOT NULL
  processed_at  TIMESTAMPTZ NOT NULL
  UNIQUE (consumer_id, event_id)
```

### 5.3 Re-delivery semantics
- On every processing attempt, the consumer inserts into `processed_events` **first** (or as part of the same transaction as the side-effect).
- A unique-constraint violation on `(consumer_id, event_id)` means the event has already been processed by this consumer. The consumer returns success without performing the side-effect. The drainer marks the row `delivered`.
- This protects against the at-least-once guarantee of the drainer: a claim that crashes after the side-effect but before marking `delivered` will be re-claimed; without the projection the consumer would double-execute.

### 5.4 What this is not
- This is not the HTTP idempotency contract (Track D). HTTP idempotency keys live in `idempotency_keys` and are scoped per `(tenantId, storeId, clientId, key)`. The outbox dedup projection is internal to consumers.

---

## 6. Tenant-context establishment (T546)

### 6.1 Drainer reads outbox
- The drainer reads its own `outbox_events` table to find claimable rows. This read is operationally cross-tenant — but RLS still applies. The runtime DB role does **not** bypass RLS (Constitution §II).
- The outbox table's RLS policy is designed so the drainer's DB role can see rows where the role has explicit operator-context — this is **table-level**, not row-level tenant context.

### 6.2 Consumer establishes tenant context
- Before any DB access **other than** reading or updating the outbox row itself, the consumer MUST call the tenant-context helper with the event's `tenant_id`.
- This is the same helper used by API request handlers and by all other workers (Constitution §V).
- Establishing the wrong tenant context is a bug. The `db_rls_context_failure_total` signal (see [observability/signals.md](../observability/signals.md)) catches the regression and the drainer's structured logger emits an error.

### 6.3 First adopter
- The `audit.event.created` consumer is the first proof-of-life adoption (FR-C-003). It validates that tenant context flows from the event row, into the consumer, into the consumer's downstream DB writes — without any human-supplied bypass.

---

## 7. Redaction obligation (T547)

### 7.1 Defer to the matrix
The single source of truth for redaction is [`.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md) (authored in T440). Outbox code does not duplicate the matrix; it complies with it.

### 7.2 Practical rules for outbox logging

**Always loggable** (cardinality-safe, non-PII):
- `event_id`
- `event_type`
- `tenant_id`
- `correlation_id`
- `delivery_state`
- `attempts`
- `last_error_class` (not the full string)

**Never logged**:
- The raw `payload` JSON.
- The full `last_error` string when it could embed payload data or PII.
- Any PII that happens to appear inside the payload (names, emails, phone numbers, addresses).

### 7.3 Where redaction is applied
Redaction is applied at the **pino transport boundary** (FR-B-005). Call sites do **not** decide what to redact — they hand pino the structured object and the transport drops or hashes fields per the matrix. This is non-negotiable: a call site that hand-redacts before logging is a bug, because the call site can't be exhaustive across future payload shapes.

### 7.4 What the dead-letter triage UI may return
The triage admin endpoint ([dead-letter-triage.md](./dead-letter-triage.md)) returns a strict allowlist of fields and **never** returns the raw `payload`. See §4 of that document.
