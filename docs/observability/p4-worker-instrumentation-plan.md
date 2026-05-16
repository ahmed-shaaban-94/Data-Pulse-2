# P4 Worker / Queue Observability Instrumentation — Pre-Flight Plan

**Feature**: 004-platform-production-readiness
**Phase**: P4 (Track B instrumentation, all `[GATED]`)
**Lane**: C — Worker / queue / Redis observability pre-flight
**Status**: Approval-ready plan. **DOCS-ONLY**. No runtime code, no tests, no
package changes authored by this PR.
**Constitution**: v3.0.0 (Principles V, VII, II, VIII)
**Created**: 2026-05-16
**Owner**: Track B Observability owner

> **Planning artifact only.** This document records the exact files, hooks,
> signals, and validation steps the future P4 worker-instrumentation slice
> will touch. Listing a future file here is **not approval to write it**.
> Per `specs/004-platform-production-readiness/plan.md §5` and `tasks.md
> §1.2`, every task this plan references is `[GATED]` and requires a
> separate, scoped, named approval PR before any commit lands.

---

## 1. Scope and tasks covered

This plan covers the **worker-side and queue/Redis-side** subset of P4.
API-side planning lives in **Lane A**; cross-cutting redaction and
cardinality planning lives in **Lane B**.

### Tasks covered by this plan

| Task | Description | Status |
|---|---|---|
| **T465** | Author worker signal-presence integration test (queue + worker metrics exposed) | Planned — file path locked |
| **T472** | Register worker / queue / Redis metric definitions in `apps/worker/src/observability/metrics/worker.metrics.ts` | Planned — file path locked |
| **T480 (worker subset)** | Validate worker P4 tests pass GREEN | Validation method documented |
| **T481 (worker subset)** | Validate existing worker tests still pass | Affected files identified |
| **T482 (worker subset)** | Validate no `package.json` change unless separately approved | Risk-assessed (see §11) |
| **T483 (worker subset)** | Operator validation: a worker `/metrics` endpoint or equivalent exposes every worker signal | Validation script documented |

**Track C future outbox signals** (`outbox_pending_total`,
`outbox_dead_letter_total`, `outbox_drain_duration_seconds`) are listed in
`docs/observability/signals.md` §3.4 and **MUST be registered as definitions
in this lane's metric module** even though no implementation emits them
until Track C's P7 outbox slice ships. See §6 of this plan.

---

## 2. Source-of-truth references

- **Signal catalogue**: `docs/observability/signals.md` §3 (Redis / BullMQ /
  Worker), §3.4 (Track C future outbox), §4 (structured-log fields), §6
  (rejected labels).
- **Redaction policy**: `.specify/memory/redaction-matrix.md` — §4 row
  "Worker failure handler" is the per-emit-site policy; this lane consumes
  it as a constraint.
- **Plan**: `specs/004-platform-production-readiness/plan.md` §3.2.1
  (signal table footer), §3.2.4 (vendor neutrality), §5 (gating).
- **Research**: `specs/004-platform-production-readiness/research.md` §4
  (Observability vendor & exporter target — Prometheus scrape + OTel
  Collector).
- **Spec**: `specs/004-platform-production-readiness/spec.md` §7.5
  (Redis/BullMQ/worker observability), §7.7 (cardinality discipline).
- **Constitution**: `.specify/memory/constitution.md` §V (Async Work
  Belongs in Workers), §VII (Observable Systems), §II (Multi-Tenant SaaS by
  Default).

---

## 3. Existing worker / queue / Redis hooks (discovered, do not edit)

### 3.1 Worker process bootstrap

| File | Role |
|---|---|
| `apps/worker/src/main.ts` | NestJS standalone bootstrap. Starts the worker module. **This is the natural place to start the OTel SDK + metrics exporter** for the worker process (mirroring the API's `main.ts`). |
| `apps/worker/src/worker.module.ts` | Composes audit/email/auth/cleanup processors. T472 registers the metrics module here (or via a feature module that exports the meter provider). |

### 3.2 Existing workers (BullMQ consumers)

| Worker / queue | File | Role for P4 |
|---|---|---|
| Email worker | `apps/worker/src/email/email.worker.ts` + `email.processor.ts` + `email.adapter.ts` + `templates.ts` | Emits `worker_job_duration_seconds{job_name="email"}`, `worker_processing_failure_total{job_name,error_class}`, `queue_lag_seconds{queue=EMAIL_QUEUE_NAME}`. |
| Audit fan-out | `apps/worker/src/audit/audit-fanout.processor.ts` + `audit.worker.ts` + `drizzle-audit-db.adapter.ts` | Emits the audit-worker variant of the same set. |
| Audit retention | `apps/worker/src/audit/audit-retention.processor.ts` + `audit-retention.worker.ts` + `audit-retention.scheduler.ts` + `audit-retention.policy.ts` + `drizzle-audit-retention.repository.ts` | Emits the same set; scheduler is the natural site for `queue_lag_seconds` since it manages the cadence. |
| Auth session-revoke | `apps/worker/src/auth/session-revoke.processor.ts` | Emits `worker_job_duration_seconds{job_name="session-revoke"}`. |
| Soft-delete sweep | `apps/worker/src/cleanup/soft-delete-sweep.processor.ts` | Same. |

### 3.3 Queue registry (already exists — important context)

`apps/worker/src/queues/queue.config.ts` already defines:

```
DLQ_METRIC_REGISTRY: readonly DlqMetricDescriptor[] = [
  { queueName: EMAIL_QUEUE_NAME, metricKey: 'queue.email.dlq' },
  { queueName: AUDIT_QUEUE_NAME, metricKey: 'queue.audit-fanout.dlq' },
  { queueName: SESSION_REVOKE_JOB_NAME, metricKey: 'queue.session-revoke.dlq' },
]
```

**This registry pre-dates P4 and uses a dotted-lowercase metric key
convention (`queue.<name>.dlq`)**. The signal catalogue
(`docs/observability/signals.md`) standardizes on Prometheus-flavored names
(`queue_dead_letter_total{queue=...}`). The two are not equivalent — the
registry's `metricKey` was a placeholder for "where DLQ metric goes" before
the catalogue locked the name.

**Decision for the gated slice**:
- Keep `DLQ_METRIC_REGISTRY` as the source-of-truth list of queue names
  (it correctly enumerates every active queue).
- Map `metricKey` is reframed as `dlq.label.queue` (the value of the
  `queue` label on `queue_dead_letter_total`), not as a separate metric
  name. The signal name is fixed by the catalogue.
- The slice will rename `DlqMetricDescriptor` either in-place or via a new
  type `QueueDescriptor`; the existing tests on `queue.config.spec.ts` MUST
  be updated to track the rename. This rename is a behavior-preserving
  refactor.

### 3.4 BullMQ trace propagation (already wired)

`packages/shared/src/observability/bullmq-propagation.ts` exposes
`injectTraceContext(carrier)` / `extractTraceContext(carrier)`. The worker
test `apps/worker/test/observability/otel-propagation.spec.ts` proves the
producer→worker trace continuation contract. **T472's worker metric module
inherits this trace context** to set the `correlation_id` field on emitted
**logs** (FR-B-004) — but metric labels never carry `correlation_id` (it's
unbounded; logs+traces only).

### 3.5 Shared OTel SDK (currently trace-only)

`packages/shared/src/observability/otel.ts` exposes `startOtel({ serviceName, ... })`. **No metrics SDK is currently registered.** This is the same gap Lane A flags — the worker side needs the same metrics SDK extension. Single shared addition; both processes consume it.

### 3.6 Existing worker tests (regression protection — must keep passing)

| File | Role for P4 |
|---|---|
| `apps/worker/test/audit/audit.worker.spec.ts` | Job lifecycle; MUST stay GREEN. |
| `apps/worker/test/audit/audit-fanout.processor.spec.ts` | Processor logic; MUST stay GREEN. |
| `apps/worker/test/audit/audit-retention.scheduler.spec.ts` | Scheduler cadence; MUST stay GREEN — relevant because the scheduler also emits `queue_lag_seconds`. |
| `apps/worker/test/audit/audit-retention.worker.spec.ts` | MUST stay GREEN. |
| `apps/worker/test/audit/drizzle-audit-db.adapter.spec.ts` | DB adapter; MUST stay GREEN. |
| `apps/worker/test/audit/drizzle-audit-retention.repository.spec.ts` | Retention repo; MUST stay GREEN. |
| `apps/worker/test/audit/retention.spec.ts` | Retention behavior; MUST stay GREEN. |
| `apps/worker/test/audit/redaction.spec.ts` (if exists — N/A in current tree, but Lane B's T462 worker counterpart may add it) | New file path. |
| `apps/worker/test/auth/session-revoke.processor.spec.ts` | MUST stay GREEN. |
| `apps/worker/test/cleanup/soft-delete-sweep.spec.ts` | MUST stay GREEN. |
| `apps/worker/test/email/email.processor.spec.ts` | MUST stay GREEN. |
| `apps/worker/test/email/email.worker.spec.ts` | MUST stay GREEN. |
| `apps/worker/test/main.spec.ts` | Bootstrap test; if T472 starts the OTel SDK in `main.ts`, this test gains an assertion. |
| `apps/worker/test/observability/otel-propagation.spec.ts` | Trace-context propagation; MUST stay GREEN — the new directory neighbor (`worker-signals.spec.ts`) lives alongside it. |
| `apps/worker/test/queues/queue.config.spec.ts` | If T472 renames `DlqMetricDescriptor`, this spec updates. Currently asserts the three-entry registry. |
| `apps/worker/test/worker.module.spec.ts` | Module composition; MUST stay GREEN unless T472 adds a metrics module (then the assertion updates). |

---

## 4. Future test files (T465)

> Test-first per Constitution §VI. T465 MUST be RED before any T472 wiring
> lands.

### 4.1 `apps/worker/test/observability/worker-signals.spec.ts` — T465

Asserts every worker signal in `docs/observability/signals.md` §3 is
**registered** and **exposed** when the worker process runs.

| What | How |
|---|---|
| Test type | Integration; **does NOT require Testcontainers Postgres** for signal-presence (no DB-bound metric on the worker side requires a real DB to assert presence); **does require an in-memory Redis or a Testcontainers Redis** if the test triggers a real job. The minimum path: assert registration without enqueueing a job. |
| Boot strategy | `Test.createTestingModule({ imports: [WorkerModule] })`; the worker module starts the metrics SDK as part of its bootstrap (T472). |
| Signal-presence check | Two complementary assertions: (a) iterate the OTel metric reader's registered instruments; assert each name from the catalogue §3 appears; (b) scrape a worker-side metrics endpoint (Prometheus text format) and grep for each name. The worker process's metrics endpoint is either a sidecar HTTP listener (recommended) or a periodic OTLP push (only if the operator does not run scrape). |
| Required signal names asserted present | `queue_lag_seconds`, `worker_job_duration_seconds`, `queue_retry_total`, `queue_dead_letter_total`, `queue_failed_total`, `worker_processing_failure_total`, `redis_command_duration_seconds`, plus the Track C future outbox signals (registered as zero-value placeholders — see §6). |
| Label-set assertion | For each signal, the registered allowed-label set is **a subset** of the catalogue §3 labels. (Equality is too strict — a signal may register a subset if the slice doesn't yet exercise every label value.) |
| Cardinality consistency with Lane B / T461 | This test is structurally tied to the same `ALLOWED_METRIC_LABELS` registry (Lane B §10.2). A worker-side signal that registers a forbidden label fails this test **and** Lane B's static check — two gates, single source of truth. |
| Stop condition | If the worker process cannot expose a metrics endpoint (no Prometheus exporter), STOP. The slice cannot ship without an operator-visible scrape target — pushing OTLP without an alternative validation surface is rejected as untestable in T483. |
| Track C outbox signals | Registered but **not emitted** by P4. The presence check asserts the metric *definitions* exist (zero-value gauge/counter); no value assertion. See §6 for the durability rationale. |

### 4.2 Reuse of existing test harness

The new test file co-locates with `apps/worker/test/observability/otel-propagation.spec.ts`. The propagation spec already establishes:
- `createTestTracerProvider()` for in-memory trace assertions.
- Fake BullMQ Job/Queue shapes (`FakeJob`, `FakeWorker`) that avoid Redis.
- Patterns for asserting cross-boundary contracts without live infrastructure.

T465 uses the same minimal approach: avoid live Redis where signal-presence
alone can be asserted via the metric reader. Where queue-lag / worker-failure
must be observed under a real Redis (e.g., for a follow-on
operator-validation test), the **`@testcontainers/postgresql`** harness's
Redis counterpart (`@testcontainers/redis`) is the recommended addition —
but that's a **package addition** (see §11) and is gated.

---

## 5. Future implementation files (T472)

> Written only after T465 is RED.

### 5.1 `apps/worker/src/observability/metrics/worker.metrics.ts` — T472

Registers the worker / queue / Redis metric family. Pattern mirrors Lane A's
`api.metrics.ts`: a single file per process role, typed helpers as the only
public surface, raw `meter.createCounter(...)` not exposed to call sites.

| Concern | Decision |
|---|---|
| Meter source | The same shared metrics factory introduced for the API side (see §11 — `packages/shared/src/observability/metrics.ts`, single new file). The worker process calls `startOtel({ serviceName: 'worker', ... })` from `apps/worker/src/main.ts`, which now accepts the metrics exporter argument. |
| Emission API | Typed helpers: `recordWorkerJobDuration({ job_name, duration_seconds })`, `recordWorkerProcessingFailure({ job_name, error_class })`, `recordQueueRetry({ queue })`, `recordQueueDeadLetter({ queue })`, `recordQueueFailed({ queue, error_class })`, `observeQueueLag({ queue, lag_seconds })`, `recordRedisCommandDuration({ command, duration_seconds })`. |
| Forbidden-label guardrail | Same TypeScript-signature enforcement as Lane A. The helpers' parameter types do not admit `tenant_id` / `store_id` / `user_id` / `actor_id` / unbounded `error.message` / raw Redis keys. Compile-time arm of FR-B-006. |
| Endpoint exposure | The worker process exposes a small HTTP listener (port configurable via env, recommended a non-API port like `9091`) serving `/metrics` in Prometheus text format. **This is a new public-ish surface on the worker process** and is the operator validation target (T483). Bound to localhost or an internal-only interface by default; ops infra terminates internally. |

### 5.2 Emission call sites

| Signal | Emission site | Mechanism |
|---|---|---|
| `worker_job_duration_seconds{job_name}` | Each processor's `process(job)` method, wrapped in a try/finally that captures `Date.now()` deltas. **OR** a NestJS BullMQ worker interceptor (preferred — single boundary). Today there is no such interceptor; T472 may introduce a minimal one in `apps/worker/src/observability/job-instrumentation.interceptor.ts` (file path lockable now). |
| `worker_processing_failure_total{job_name, error_class}` | The catch branch of the same job-instrumentation interceptor. `error_class` = `err.constructor.name`, sanitized to a known allowlist (see §7 for the allowlist policy). |
| `queue_retry_total{queue}` | BullMQ exposes a `failed`+`attemptsMade < attemptsLimit` event on the queue events emitter; T472 subscribes once at worker bootstrap and emits the counter. |
| `queue_dead_letter_total{queue}` | BullMQ exposes `failed`+`attemptsMade >= attemptsLimit` (the move to the DLQ). Same subscription site; emits when the retry budget exhausts. **`DLQ_METRIC_REGISTRY` becomes the queue-list source.** |
| `queue_failed_total{queue, error_class}` | Per-failure emission inside the same subscription. `error_class` shares the worker-side allowlist. |
| `queue_lag_seconds{queue}` (gauge) | Observable gauge with a callback that queries BullMQ for `getWaitingCount()` + oldest-waiting-job age. Sampled at the metrics SDK's collection cadence. |
| `redis_command_duration_seconds{command}` | The shared OTel `RedisInstrumentation` (already registered in `packages/shared/src/observability/otel.ts`) emits spans; the metrics SDK can derive a histogram from those spans via the `view` API. **Alternative**: a manual `node-redis` v4 command hook. Decision deferred to instrumentation PR (research §4 noted both paths). |

### 5.3 Track C outbox signals — definitions only

| Signal | Type | Registered by T472? | Emitted by P4? |
|---|---|---|---|
| `outbox_pending_total{event_type}` | gauge | **YES** (definition + zero-value baseline) | No |
| `outbox_dead_letter_total{event_type}` | counter | **YES** (definition only) | No |
| `outbox_drain_duration_seconds{event_type}` | histogram | **YES** (definition only) | No |

**Why register without emission**: see §6.

---

## 6. Track C future outbox signals — register but do not emit

### 6.1 The rationale

Track C's outbox implementation (Phase 7 — `outbox_events` table + drainer
worker + consumer) is `[GATED]` independently of P4 and may not ship for
weeks or months after P4. Registering the three outbox signals in P4 makes
them **visible in the signal catalogue's runtime presence** before
implementation, with two operational benefits:

1. **Dashboards-as-code in `ops/`** (per `docs/observability/dashboards/README.md`) can author the outbox panels in advance, reading from a known-named gauge/counter/histogram that exists at scrape time. The panels show zero / no-data and become live the moment Track C P7 wires emission. No dashboard-redeploy is needed when emission starts.

2. **Alerts-as-code in `ops/`** (per `docs/observability/alerts/README.md` "Outbox dead-letter — any non-zero") can be authored against a real signal, not a planned one. The alert is dormant (zero value) until Track C P7 emits — at which point it becomes a meaningful detector.

### 6.2 Constraints on the placeholder registration

- The three signals are registered with their canonical names from
  `docs/observability/signals.md` §3.4.
- The labels are bounded — `event_type` is a closed enum. **No placeholder
  emits `event_type` values that don't yet exist** (so no `event_type="audit.event.created"` increment from P4); the metric is registered with **no observed data points** until Track C P7.
- The placeholder MUST NOT make a metric report values from a different
  source (e.g., reusing `queue_dead_letter_total` data under an
  `outbox_dead_letter_total` name). Misleading metrics violate FR-B-007
  (vendor-neutral observability semantics).

### 6.3 What happens when Track C P7 lands

The Track C P7 slice adds emission **inside the outbox drainer worker**
(future file: `apps/worker/src/outbox/drainer.processor.ts`). The drainer
calls the existing helpers from `worker.metrics.ts` for the three outbox
signals; **no metric registration change** is needed in P7. This is
intentional — P4 absorbs the registration cost so P7 can ship as an
emission-only slice that does not modify the metrics module.

---

## 7. Allowed labels (low-cardinality only)

Cross-reference: `docs/observability/signals.md` §3, §6.

| Signal | Allowed labels |
|---|---|
| `redis_command_duration_seconds` | `command` (Redis verb: `get`/`set`/`del`/`hget`/`hset`/...) |
| `queue_lag_seconds` | `queue` (bounded set: `email`, `audit-fanout`, `audit-retention`, `session-revoke`, `soft-delete-sweep`) |
| `queue_failed_total` | `queue`, `error_class` (worker-side allowlist) |
| `queue_dead_letter_total` | `queue` |
| `queue_retry_total` | `queue` |
| `worker_job_duration_seconds` | `job_name` (bounded set; mirrors `queue` set; mapping defined by `DLQ_METRIC_REGISTRY`) |
| `worker_processing_failure_total` | `job_name`, `error_class` |
| `outbox_pending_total` | `event_type` (bounded set; first member when emitted: `audit.event.created`) |
| `outbox_dead_letter_total` | `event_type` |
| `outbox_drain_duration_seconds` | `event_type` |

### 7.1 `error_class` allowlist

`error_class` MUST be a sanitized class name from a closed allowlist
maintained alongside the metric module. Examples:
`TenantContextMissingError`, `ZodValidationError`, `PostgresUniqueViolation`,
`RedisConnectionError`, `Timeout`, `UnknownError` (the catch-all).

Why an allowlist:
- Unbounded class names (e.g., dynamically-generated subclass names) can
  blow cardinality (per FR-B-006).
- Error class **messages** are PII-suspect (matrix §4.1 rule 4) — the
  class **name** is the safe substitute.
- A new error class added without allowlist update is silently mapped to
  `UnknownError` for the metric, while the **log** still carries the
  precise class + sanitized message (logger boundary applies). The slice
  does not block on every new error class.

---

## 8. Forbidden labels (FR-B-006 — non-negotiable)

These MUST NOT appear as labels on any worker / queue / Redis signal:

| Forbidden label | Why | Where it does live |
|---|---|---|
| `tenant_id` | Unbounded cardinality. | Logs (worker-side, always when established per FR-B-010); traces. |
| `store_id` | Unbounded. | Logs; traces. |
| `user_id` / `actor_id` | Unbounded; PII-adjacent. | Logs; traces. |
| `event_id` (worker outbox) | Unbounded — every event has a unique id. | Logs and the event row itself; never a metric label. |
| `job_id` (BullMQ) | Unbounded. | Logs as `request_id` equivalent; trace span attribute. |
| Raw Redis key | Unbounded; PII-suspect (keys may carry tenant ids). | Logs only at sanitized boundary; never as label. |
| Raw exception message | PII-suspect + unbounded. | Logged via per-emit-site serializer (matrix §4 row "Worker failure handler"). |
| `correlation_id` | Unbounded (one per request). | Logs (always for workers — FR-B-004). |
| Rendered queue name with tenant suffix (if any) | Unbounded — never bake `tenant_id` into queue names. | Use a fixed queue set; tenant isolation lives in the consumer's `runWithTenantContext`. |

The worker-side metric helpers (§5.1) enforce these at compile time via
TypeScript signatures, paralleling the API side.

---

## 9. How to validate no PII in queue / worker logs

### 9.1 Logger-boundary redaction (Lane B owns the wiring; this lane consumes)

Worker-side logs flow through `packages/shared/src/logger/pino.ts` —
the same logger primitive the API uses. Lane B's T473 expands the
`DEFAULT_REDACT_PATHS` and registers per-emit-site serializers (matrix §4).
The "Worker failure handler" row of the matrix is the per-emit-site rule:

| Emitted (allowed) | Redacted (must not emit) | Mechanism |
|---|---|---|
| `correlation_id`, `tenant_id`, `store_id`, `job_name`, `queue_name`, `attempt`, `error_class`, `error_code` | full `job.data` payload (PII-suspect), credentials, PII fields, raw exception message | `worker-failure.serializer.ts` redacts `job.data` to a fingerprint; replaces `err` with `{ error_class, sanitized_summary }`. |

### 9.2 PII canary in worker logs (T462 worker counterpart)

Lane B's T462 establishes the PII canary pattern with
`pii-canary@example.test`. If a worker job is enqueued with that canary
value in its payload, scanning captured worker pino output MUST NOT find
the literal canary string. **This lane's plan does not duplicate T462 —
it confirms the worker side is in scope.**

### 9.3 Reviewer checklist for worker P4 PRs

- `git grep -nE "logger\.(info|warn|error).*job\.data" apps/worker/src` →
  any hit on `job.data` without a serializer-applied transformation is a
  defect (matrix §4 row).
- `git grep -nE "logger\..*\\$\\{" apps/worker/src` → template-literal
  interpolation of unknown values into log messages is reviewer-flagged.
  Structured fields are preferred over string interpolation.

---

## 10. Structured-log fields (FR-B-004, FR-B-010)

Cross-reference: `docs/observability/signals.md` §4. Worker logs MUST carry:

| Field | Required when | Source |
|---|---|---|
| `request_id` | Always | `job.id` |
| `tenant_id` | Once worker establishes tenant context (FR-B-010) | The consumer's `runWithTenantContext(...)` call carries this; ALS-equivalent on the worker side. |
| `store_id` | When established | Same. |
| `actor_id` | When the job carries an actor (audit fan-out does; auth session-revoke may) | From job payload (post-Zod-validated, never raw `job.data`). |
| `correlation_id` | Always for async work | `extractTraceContext(job.data.traceContext).traceparent.traceId`. |
| `job_name`, `queue_name` | Always | Static; bounded set. |
| `outcome` | At job completion | `success`/`failure`/`partial`. |

T474 (owned by Lane B) wires these on the worker side. This lane confirms
the worker is in T474's scope; no separate task here.

---

## 11. `package.json` change assumption

### 11.1 Likely package additions

| Package | Why | Lane that introduces it |
|---|---|---|
| `@opentelemetry/sdk-metrics` | Metrics SDK (shared with API). | **Same single addition as Lane A**. |
| `@opentelemetry/exporter-prometheus` | Prometheus scrape endpoint for the worker process. | **Same addition as Lane A**. |
| **Possibly** `@testcontainers/redis` | If T465 or follow-on operator validation needs a live Redis to observe queue lag. | **REJECTED for P4** — start without; signal-presence is achievable without live Redis. |
| **Possibly** `bullmq-otel` (BullMQ author's OTel package) | Native BullMQ instrumentation. | **DEFERRED** — `packages/shared/src/observability/otel.ts` header explicitly defers BullMQ instrumentation. P4 emits the four queue metrics via the existing BullMQ queue-events emitter (no plugin needed). |

### 11.2 What MUST NOT be added without separate approval

- `@opentelemetry/auto-instrumentations-node` — rejected (over-broad; FR-B-007).
- Any managed-vendor SDK — rejected (FR-B-007).
- `bullmq-otel` — deferred (per `otel.ts` header decision); revisit when BullMQ-side trace instrumentation is needed beyond the carrier-based propagation we already have.

### 11.3 T482 reviewer obligation (worker subset)

- `git diff package.json apps/worker/package.json packages/shared/package.json` → expect only the metrics-SDK + Prometheus-exporter deltas (shared between Lane A and Lane C; **single addition**, not two).
- `git diff pnpm-lock.yaml` → expect deltas tied to those two packages only.

---

## 12. Worker `/metrics` endpoint exposure

### 12.1 Why the worker needs its own scrape endpoint

The API and the worker are **separate processes**. Each has its own OTel
SDK, its own metric registry, and emits its own series. Ops infra must scrape
both. The worker currently has **no HTTP listener at all** (it's a BullMQ
consumer + scheduler). P4 introduces a minimal HTTP listener for `/metrics`
on a separate port from the API.

### 12.2 Listener policy

| Concern | Decision |
|---|---|
| Port | Configurable via `WORKER_METRICS_PORT` env; default `9091`. Different from API's default `3000`. |
| Bind interface | Localhost or an internal interface by default. Production binding is ops-side concern; default is restrictive. |
| Auth | None at the application layer — `/metrics` endpoints are conventionally unauthenticated and scraped by trusted Prometheus collectors. Ops infra terminates internally. **Reviewer-flagged**: this is consistent with the API's `/metrics` from Lane A; both stand or fall together. |
| Liveness/readiness | Reserved for a future ops PR. P4 only exposes `/metrics`. |

### 12.3 Operator validation (T483 worker subset)

```bash
# Start worker
pnpm --filter @data-pulse-2/worker start  &
WORKER_PID=$!

# Wait for it to register
sleep 5

# Scrape
curl -sS http://localhost:9091/metrics > /tmp/worker_metrics.txt

# Assert every worker-side signal present
for sig in queue_lag_seconds worker_job_duration_seconds queue_retry_total queue_dead_letter_total queue_failed_total worker_processing_failure_total redis_command_duration_seconds outbox_pending_total outbox_dead_letter_total outbox_drain_duration_seconds; do
  grep -q "^${sig}" /tmp/worker_metrics.txt || { echo "MISSING: ${sig}"; exit 1; }
done

# PII canary absence (mirror of Lane B's API-side check)
grep -i 'pii-canary@example.test' /tmp/worker_metrics.txt && { echo "LEAK"; exit 1; }

kill $WORKER_PID
```

---

## 13. Stop conditions

The P4 worker instrumentation slice STOPS and re-plans if:

1. The shared metrics SDK (`@opentelemetry/sdk-metrics` + Prometheus
   exporter) is not approved alongside this slice. The worker cannot expose
   `/metrics` without it.
2. The proposed worker HTTP listener is rejected (operations or security
   review objects to opening a worker-side HTTP port even on localhost).
   **Fallback**: OTLP push to an OTel Collector — but this loses the simple
   curl-based operator validation (T483); requires alternative validation.
   STOP and re-plan validation.
3. BullMQ does not expose the queue events needed for `queue_retry_total` /
   `queue_dead_letter_total` / `queue_failed_total` in the project's pinned
   version (`bullmq@5.76.5`). **Pre-flight check**: the slice's first step
   is a 5-minute confirmation that `QueueEvents` is available on this
   version (research §4 referenced this surface). If absent, the slice
   re-evaluates emission via `bullmq-otel` (gated package addition).
4. `queue_lag_seconds` cannot be observed cheaply (requires a per-second
   BullMQ poll that overloads Redis). **Fix**: throttle the gauge callback
   to the metrics SDK collection cadence (60s default). Do not poll
   independently.
5. A worker signal cannot be emitted without a forbidden label. The
   emission site is removed before merge; the metric is registered as
   defined-but-not-yet-emitted (paralleling the Track C placeholder
   pattern).
6. The `DLQ_METRIC_REGISTRY` rename collides with the `queue.config.spec.ts`
   test in a way that requires breaking the existing contract. **Fix**:
   preserve the registry, deprecate `metricKey` (still emit it), introduce
   the new `queueLabel` field alongside; remove `metricKey` in a later
   cleanup slice.
7. Track C outbox signal placeholders create noise in dashboards (zero-value
   gauges that look like "missing data"). **Fix**: dashboard-side
   `or vector(0)` patterns in `ops/`; the placeholder behavior is correct
   here.

---

## 14. Cross-references to other lanes

| Companion lane | Topic | Interface |
|---|---|---|
| **Lane A — API instrumentation** | API metric registration, emission, presence/RLS/cross-tenant/auth-failure tests | **Same shared metrics SDK extension** — single addition to `packages/shared/src/observability/otel.ts`. Both lanes consume; only one PR adds the dependency. |
| **Lane B — Redaction + cardinality** | Per-emit-site serializers, redact paths, structured-log fields, cardinality static check | **Worker-side log redaction is in Lane B's T473/T474 scope** (the matrix §4 "Worker failure handler" row). Worker-side cardinality is in Lane B's T461. This lane consumes both. |

This plan's scope ends at the worker process boundary. The OpenAPI
contract changes, the API signal emission sites, and the cross-cutting
logger redaction policy live in their respective lanes.

---

## 15. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BullMQ `QueueEvents` API drift between versions silently changes event shape | MEDIUM | Wrong / missing queue metrics | Pin assertions in T465 to the events the worker subscribes; a version bump triggers test failures that surface the drift. |
| `queue_lag_seconds` gauge callback overloads Redis | LOW–MEDIUM | Worker outage under load | Throttle to metrics SDK collection cadence; never poll synchronously. |
| Worker process metric endpoint exposed to a network ops did not expect | MEDIUM | Information disclosure | Default-bind to localhost; ops infra terminates internally; document in `docs/observability/dashboards/README.md`'s ops-side scrape section. |
| Track C outbox placeholders mislead future Track C reviewers ("the metric exists, why isn't it emitting?") | LOW | Confusion | Track C P7's PR description references this lane's plan §6.3 explicitly; reviewers verify the emission-only nature. |
| Renaming `DLQ_METRIC_REGISTRY` field breaks downstream consumers | LOW | Test regression | Preserve the existing field; add the new field; deprecate the old one explicitly in a separate cleanup slice. |
| The worker-side OTel SDK boot order races BullMQ Worker initialization | MEDIUM | Missing initial spans / counters on the first jobs | `startOtel(...)` runs FIRST in `apps/worker/src/main.ts`, **before** `WorkerModule` bootstraps. This mirrors the API's `main.ts` pattern. Test in T465 by asserting the SDK has started before module init. |
| `error_class` allowlist misses a new error type | LOW | Metric falls into `UnknownError` bucket | Acceptable — the **log** still carries the precise class. The metric is intentionally coarse for cardinality. Add to allowlist in a follow-up slice if the unknown bucket gets dominant. |

---

## 16. Discovered hooks summary (one-line per hook)

| File | Role this slice plays |
|---|---|
| `apps/worker/src/main.ts` | Add `startOtel({ serviceName: 'worker', metricsExporter })`. Boot the metrics endpoint listener. |
| `apps/worker/src/worker.module.ts` | Provide the typed metric helpers via DI. |
| `apps/worker/src/observability/metrics/worker.metrics.ts` (new) | Register worker / queue / Redis metrics + Track C placeholders. |
| `apps/worker/src/observability/job-instrumentation.interceptor.ts` (new — optional) | Wrap every `process(job)` to emit `worker_job_duration_seconds` + `worker_processing_failure_total`. |
| `apps/worker/src/queues/queue.config.ts` | `DLQ_METRIC_REGISTRY` becomes the canonical queue-name source; rename or extend `DlqMetricDescriptor` (behavior-preserving). |
| `apps/worker/src/audit/audit.worker.ts` and friends | Subscribe to BullMQ `QueueEvents` once at bootstrap for `queue_retry_total` / `queue_dead_letter_total` / `queue_failed_total` emission. |
| `apps/worker/src/email/email.worker.ts` and friends | Same. |
| `apps/worker/src/auth/session-revoke.processor.ts` | Same job-instrumentation interceptor coverage. |
| `apps/worker/src/cleanup/soft-delete-sweep.processor.ts` | Same. |
| `packages/shared/src/observability/otel.ts` | Extend to accept `metricsExporter` argument (shared with Lane A). |
| `packages/shared/src/observability/metrics.ts` (new — gated) | Meter factory + Prometheus exporter wiring (shared). |
| `packages/shared/src/observability/bullmq-propagation.ts` | Read-only; trace propagation is already correct. |
| `packages/shared/src/logger/pino.ts` | Modified by Lane B (not this lane); this lane consumes. |

---

## 17. Mergeability of this PR

**This PR (the Lane C pre-flight) is mergeable as docs-only.** It changes
exactly one file (`docs/observability/p4-worker-instrumentation-plan.md`)
and introduces no:

- runtime code change,
- test file,
- package.json change,
- pnpm-lock.yaml change,
- OpenAPI contract change,
- DB schema or migration change,
- CI workflow change,
- generated file,
- `apps/**` change,
- `packages/**` change,
- `.specify/**` change,
- `loadtests/**` change.

A reviewer can confirm by running `git diff --name-only` against this PR
and expecting **exactly one path**:
`docs/observability/p4-worker-instrumentation-plan.md`.

---

## 18. Recommended commit message (if later approved)

```
docs(observability): pre-flight plan for P4 worker / queue instrumentation
```

## 19. Recommended PR title (if later approved)

```
docs(observability): pre-flight plan for P4 worker / queue instrumentation
```

---

## 20. Next action

This plan is the approval gate for the future P4 worker instrumentation
slice. Recommended sequence:

1. **Now**: review this plan; merge as docs-only after reviewer agreement.
2. **After**: pre-flight a 5-minute spike on a feature branch confirming
   `bullmq@5.76.5`'s `QueueEvents` shape matches the emission plan. Do
   not merge the spike branch (per `tasks.md` §9.2 spike-task discipline).
3. **After spike confirmation**: open the gated P4 worker instrumentation
   PR, bundling T465 (test) + T472 (registration + emission wiring) + the
   approved shared `package.json` delta from §11.1. The PR title pattern
   is `feat(observability): instrument worker/queue/Redis signals [GATED]`.
4. **After that**: open the T483 worker operator-validation PR (or include
   the evidence in the slice's PR description).

This plan does NOT authorize step 2, 3, or 4. It establishes the surface
that those steps will operate on.

---

*End of Lane C pre-flight plan.*
