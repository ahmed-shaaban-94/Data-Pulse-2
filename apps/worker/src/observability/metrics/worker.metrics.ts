/**
 * Worker / queue / Redis metric definitions — T472 / Track B / P4.
 *
 * Registers every worker-side signal from `docs/observability/signals.md` §3
 * with the OTel global Meter and exposes typed emission helpers.
 *
 * Label-policy enforcement (two layers, identical to api.metrics.ts /
 * db.metrics.ts):
 *   1. `assertMetricLabels` is called at module load for each signal.
 *      A forbidden or unregistered label throws immediately — it cannot
 *      reach a live SDK (FR-B-006, FR-B-012).
 *   2. Helper parameter types admit only the declared label keys. A call
 *      site cannot pass `tenant_id`, `store_id`, `user_id`, `actor_id`,
 *      `job_id`, `correlation_id`, or any forbidden key because the
 *      helpers' TypeScript signatures exclude them (compile-time
 *      enforcement of FR-B-006).
 *
 * Outbox signals (signals.md §3.4):
 *   - `outbox_dead_letter_total` and `outbox_drain_duration_seconds` are
 *     emitted from `DrainerProcessor.processRow` (T595 PR-B-1). Helpers
 *     `recordOutboxDeadLetter` / `recordOutboxDrainDuration` are exposed.
 *   - `outbox_pending_total` remains **registered as definition only** —
 *     the ObservableGauge needs an `addCallback` against a live DB pool,
 *     deferred to a follow-on slice (T595 PR-B-2).
 *
 * Per `docs/observability/p4-worker-instrumentation-plan.md` §6, registering
 * the placeholders here lets dashboards-as-code and alerts-as-code refer
 * to canonical signal names ahead of the emission slice. Adding emission
 * for the remaining outbox signal will not change this module's
 * registered names.
 *
 * Emission wiring (per-processor call sites) is intentionally deferred —
 * this slice ships definitions + helpers + a presence test only. The
 * worker `/metrics` HTTP scrape endpoint (T483 worker subset) requires
 * `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`,
 * which is a separate package-gated slice (plan §11).
 *
 * Instruments are no-op until a MetricReader is registered. Tests
 * exercise the helpers safely without a live SDK.
 *
 * No API or DB signals — those are T470 / T471 (apps/api).
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / FR-B-012.
 */
import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Bounded queue / job names (signals.md §3, plan §7)
// ---------------------------------------------------------------------------
// Bounded sets — adding a queue or job_name requires a cardinality review
// (FR-B-012) and a follow-on update here. The plan §7 enumerates the
// expected members; emission sites MUST stick to these values.
//
// These constants are exported so emission sites (deferred to a follow-on
// slice) and test fixtures consume a single source of truth.

/** Bounded queue label values. Mirrors plan §7 table row "queue_lag_seconds". */
export const WORKER_QUEUE_NAMES = [
  "email",
  "audit-fanout",
  "audit-retention",
  "session-revoke",
  "soft-delete-sweep",
] as const satisfies readonly string[];
export type WorkerQueueName = (typeof WORKER_QUEUE_NAMES)[number];

/**
 * Bounded job_name label values. Mirrors the queue set 1:1 today — the
 * label name differs (`job_name`) for catalogue consistency with BullMQ
 * conventions, but the allowed values are the same as `WORKER_QUEUE_NAMES`.
 */
export const WORKER_JOB_NAMES = WORKER_QUEUE_NAMES;
export type WorkerJobName = (typeof WORKER_JOB_NAMES)[number];

// ---------------------------------------------------------------------------
// error_class allowlist (plan §7.1)
// ---------------------------------------------------------------------------
// Unbounded class names blow cardinality (FR-B-006). Error MESSAGES are
// PII-suspect (redaction matrix §4.1 rule 4). The class NAME is the safe
// substitute, but only via a closed allowlist — anything else maps to
// "UnknownError" before the metric is recorded. The log still carries the
// precise class + sanitized summary; the metric is intentionally coarse.

/** Closed allowlist of worker-side error class labels. */
export const WORKER_ERROR_CLASSES = [
  "TenantContextMissingError",
  "ZodValidationError",
  "PostgresUniqueViolation",
  "RedisConnectionError",
  "Timeout",
  "UnknownError",
] as const satisfies readonly string[];
export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

const WORKER_ERROR_CLASS_SET: ReadonlySet<string> = new Set(WORKER_ERROR_CLASSES);

// ---------------------------------------------------------------------------
// Bounded outbox event_type values (T595, signals.md §3.4)
// ---------------------------------------------------------------------------
// Closed allowlist of event_type values the outbox metrics may be labelled
// with. The single member today mirrors the only registered consumer
// (`AuditEventCreatedConsumer.eventType` and `retention.policy.AUDIT_EVENT_TYPE`).
// Adding an event_type requires registering a corresponding `OutboxConsumer`
// AND extending this constant — both are gated by cardinality review
// (FR-B-012). The runtime emission sites pass `row.event_type as string`
// because the drainer receives untyped strings from Postgres; values outside
// this set still emit (no coercion in this slice) — keeping the label
// uncoerced preserves operator visibility into unrouted event types until a
// stricter sanitizer is approved.
export const WORKER_OUTBOX_EVENT_TYPES = [
  "audit.event.created",
] as const satisfies readonly string[];
export type WorkerOutboxEventType = (typeof WORKER_OUTBOX_EVENT_TYPES)[number];

/**
 * Coerce an arbitrary error-class name to the closed allowlist. Unknown
 * class names map to `"UnknownError"`. This is the only sanctioned path
 * to derive an `error_class` label value at an emission site.
 *
 * Callers MUST NOT pass `err.message` here — only `err.constructor.name`
 * (plan §7.1). Messages are PII-suspect.
 */
export function sanitizeErrorClass(
  className: string | undefined | null,
): WorkerErrorClass {
  if (typeof className !== "string" || !WORKER_ERROR_CLASS_SET.has(className)) {
    return "UnknownError";
  }
  return className as WorkerErrorClass;
}

// ---------------------------------------------------------------------------
// Module-load label-policy validation
// ---------------------------------------------------------------------------
// assertMetricLabels throws if a label is forbidden or not in the closed
// allowlist (ALLOWED_METRIC_LABELS in packages/shared). Called once at
// registration time; cannot be deferred to emit time.

assertMetricLabels("redis_command_duration_seconds", ["command"]);
assertMetricLabels("queue_lag_seconds", ["queue"]);
assertMetricLabels("queue_failed_total", ["queue", "error_class"]);
assertMetricLabels("queue_dead_letter_total", ["queue"]);
assertMetricLabels("queue_retry_total", ["queue"]);
assertMetricLabels("worker_job_duration_seconds", ["job_name"]);
assertMetricLabels("worker_processing_failure_total", ["job_name", "error_class"]);

// Track C outbox placeholders — registered as definitions only per
// plan §6. Emission helpers are NOT exposed; the outbox slice will add
// them when Track C P7 ships. Validating labels at module load now
// catches drift early.
assertMetricLabels("outbox_pending_total", ["event_type"]);
assertMetricLabels("outbox_dead_letter_total", ["event_type"]);
assertMetricLabels("outbox_drain_duration_seconds", ["event_type"]);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const meter = getMeter("worker");

// Redis
const _redisCommandDuration: Histogram = meter.createHistogram(
  "redis_command_duration_seconds",
  {
    description:
      "Redis command duration in seconds, labelled by the command verb " +
      "(get/set/del/hget/hset/...). NEVER labelled by the Redis key.",
    unit: "s",
  },
);

// BullMQ / queues
// queue_lag_seconds is an observable gauge — pool-style introspection
// (BullMQ getWaitingCount + oldest-waiting-job age) is sampled at the
// SDK collection cadence. The addCallback wiring is deferred to the
// emission slice; the instrument is registered now so signal-presence
// holds.
const _queueLag: ObservableGauge = meter.createObservableGauge("queue_lag_seconds", {
  description:
    "BullMQ queue lag in seconds, labelled by queue. Sampled by the metrics " +
    "SDK; never polled synchronously to avoid Redis pressure.",
  unit: "s",
});
const _queueFailed: Counter = meter.createCounter("queue_failed_total", {
  description: "Total failed jobs by queue and sanitized error_class.",
});
const _queueDeadLetter: Counter = meter.createCounter("queue_dead_letter_total", {
  description:
    "Total jobs that exhausted retries and landed in the BullMQ failed-jobs " +
    "set (acts as DLQ per shared queue.config), labelled by queue.",
});
const _queueRetry: Counter = meter.createCounter("queue_retry_total", {
  description:
    "Total retry attempts (failed + attemptsMade < attemptsLimit) by queue.",
});

// Workers
const _workerJobDuration: Histogram = meter.createHistogram(
  "worker_job_duration_seconds",
  {
    description:
      "Worker job processing duration in seconds, labelled by job_name. " +
      "Histogram — quantiles (p50/p95/p99) recovered at the query layer.",
    unit: "s",
  },
);
const _workerProcessingFailure: Counter = meter.createCounter(
  "worker_processing_failure_total",
  {
    description:
      "Total worker job processing failures by job_name and sanitized " +
      "error_class (closed allowlist; unknown classes coerced to UnknownError).",
  },
);

// Track C outbox — outbox_pending_total remains a PLACEHOLDER (no helper)
// because the ObservableGauge needs an addCallback wired to a live DB pool;
// that DB/module lifecycle wiring is the deferred T595 follow-on slice.
const _outboxPending: ObservableGauge = meter.createObservableGauge(
  "outbox_pending_total",
  {
    description:
      "Pending outbox events by event_type. PLACEHOLDER — registered for " +
      "dashboard/alert authoring ahead of the addCallback wiring slice; " +
      "no values emitted yet.",
  },
);

// T595 (PR-B-1): outbox_dead_letter_total and outbox_drain_duration_seconds
// are emitted from DrainerProcessor's existing per-row branches. Helpers
// exposed below mirror the recordQueue* / recordWorker* shape used by
// PR-A's T596 emission.
const _outboxDeadLetter: Counter = meter.createCounter("outbox_dead_letter_total", {
  description:
    "Outbox events that exhausted drain retries (row.attempts >= MAX_ATTEMPTS), " +
    "labelled by event_type.",
});
const _outboxDrainDuration: Histogram = meter.createHistogram(
  "outbox_drain_duration_seconds",
  {
    description:
      "Outbox per-row drain duration in seconds, labelled by event_type. " +
      "Wall-clock from claim-dispatch to consumer return (success or failure).",
    unit: "s",
  },
);

// Silence TS "unused variable" warnings — _queueLag is consumed by a future
// addCallback wiring; _outboxPending stays a placeholder pending its own
// addCallback slice.
void _queueLag;
void _outboxPending;

// ---------------------------------------------------------------------------
// Attribute types — TypeScript compile-time label enforcement (FR-B-006)
// ---------------------------------------------------------------------------
// Each type admits ONLY the allowed label keys for its signal. A call site
// that adds `tenant_id`, `store_id`, `user_id`, `actor_id`, `job_id`,
// `correlation_id`, or any other forbidden key won't compile.

export interface RedisCommandDurationAttrs {
  command: string;
}

export interface QueueLagAttrs {
  queue: WorkerQueueName;
}

export interface QueueFailedAttrs {
  queue: WorkerQueueName;
  error_class: WorkerErrorClass;
}

export interface QueueDeadLetterAttrs {
  queue: WorkerQueueName;
}

export interface QueueRetryAttrs {
  queue: WorkerQueueName;
}

export interface WorkerJobDurationAttrs {
  job_name: WorkerJobName;
}

export interface WorkerProcessingFailureAttrs {
  job_name: WorkerJobName;
  error_class: WorkerErrorClass;
}

/**
 * Label shape for `outbox_dead_letter_total` and `outbox_drain_duration_seconds`.
 *
 * The drainer receives `row.event_type` from Postgres as an untyped string —
 * the row may carry an event_type the worker has no consumer for (the
 * "UnroutableEventType" path in DrainerProcessor.processRow). Typing this as
 * `string` rather than `WorkerOutboxEventType` keeps that diagnostic
 * visibility intact. Operators can spot unexpected event_type labels on the
 * dashboard rather than seeing the metric silently coerce away the signal.
 *
 * Cardinality control comes from the consumer-registry invariant: only event
 * types with a registered consumer (or an explicit unroutable-test fixture)
 * ever reach this label. A separate cardinality review (FR-B-012) gates any
 * new registered event_type.
 */
export interface OutboxDeadLetterAttrs {
  event_type: string;
}

export interface OutboxDrainDurationAttrs {
  event_type: string;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/**
 * Record a Redis command duration observation (seconds).
 *
 * Emission site (future): a node-redis / ioredis command hook, or derived
 * from the shared OTel `RedisInstrumentation` spans via the metrics view
 * API. Decision deferred to the wiring slice (plan §5.2).
 */
export function recordRedisCommandDuration(
  attrs: RedisCommandDurationAttrs,
  durationSeconds: number,
): void {
  _redisCommandDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Increment queue_failed_total for the given queue + sanitized error_class.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` subscription
 * at worker bootstrap (plan §5.2). `error_class` MUST be sourced via
 * `sanitizeErrorClass(err.constructor.name)` — never `err.message`.
 */
export function recordQueueFailed(attrs: QueueFailedAttrs): void {
  _queueFailed.add(1, attrs as unknown as Attributes);
}

/**
 * Increment queue_dead_letter_total for the given queue.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` where
 * `attemptsMade >= attemptsLimit` (the retry budget is exhausted; the
 * job is now in the BullMQ failed-jobs set, which acts as DLQ per
 * shared `queue.config`).
 */
export function recordQueueDeadLetter(attrs: QueueDeadLetterAttrs): void {
  _queueDeadLetter.add(1, attrs as unknown as Attributes);
}

/**
 * Increment queue_retry_total for the given queue.
 *
 * Emission site (future): BullMQ `QueueEvents.on("failed", ...)` where
 * `attemptsMade < attemptsLimit` (the job will be retried).
 */
export function recordQueueRetry(attrs: QueueRetryAttrs): void {
  _queueRetry.add(1, attrs as unknown as Attributes);
}

/**
 * Record a worker job duration observation (seconds).
 *
 * Emission site (future): a job-instrumentation interceptor that wraps
 * every processor's `process(job)` in a try/finally measuring wall-clock
 * duration (plan §5.2).
 */
export function recordWorkerJobDuration(
  attrs: WorkerJobDurationAttrs,
  durationSeconds: number,
): void {
  _workerJobDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/**
 * Increment worker_processing_failure_total for the given job_name +
 * sanitized error_class.
 *
 * Emission site (future): the catch branch of the same job-instrumentation
 * interceptor. `error_class` MUST be sourced via
 * `sanitizeErrorClass(err.constructor.name)`.
 */
export function recordWorkerProcessingFailure(
  attrs: WorkerProcessingFailureAttrs,
): void {
  _workerProcessingFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment outbox_dead_letter_total for the given event_type.
 *
 * Emission site: `DrainerProcessor.processRow` — the existing dead-letter
 * branch where `row.attempts >= MAX_ATTEMPTS` after a consumer throw.
 * Called BEFORE `safeMarkDeadLettered` (mirrors PR-A's D4 ordering) so the
 * metric reflects the drainer's decision regardless of persistence outcome.
 */
export function recordOutboxDeadLetter(attrs: OutboxDeadLetterAttrs): void {
  _outboxDeadLetter.add(1, attrs as unknown as Attributes);
}

/**
 * Record an outbox per-row drain duration observation (seconds).
 *
 * Emission site: `DrainerProcessor.processRow` finally — wall-clock from
 * the start of processing to the consumer's return (success path) or the
 * decision branch (failure / no-consumer paths). The histogram lets
 * operators recover p50/p95/p99 per event_type at the query layer.
 */
export function recordOutboxDrainDuration(
  attrs: OutboxDrainDurationAttrs,
  durationSeconds: number,
): void {
  _outboxDrainDuration.record(durationSeconds, attrs as unknown as Attributes);
}

// ---------------------------------------------------------------------------
// Signal-name registry — used by T465 signal-presence test
// ---------------------------------------------------------------------------

/**
 * Canonical names of all worker-side signals registered by this module
 * that ALSO have an emission helper exposed (i.e., the seven signals
 * the slice can emit today). Outbox placeholders are tracked separately
 * in `WORKER_OUTBOX_METRIC_NAMES` because no helper is exposed for them.
 *
 * Drift between this array and the actual instrument creation above
 * fails CI via the T465 presence test.
 */
export const WORKER_METRIC_NAMES = [
  "redis_command_duration_seconds",
  "queue_lag_seconds",
  "queue_failed_total",
  "queue_dead_letter_total",
  "queue_retry_total",
  "worker_job_duration_seconds",
  "worker_processing_failure_total",
  // T595 (PR-B-1): outbox dead-letter + drain-duration emitted from
  // DrainerProcessor.processRow. The ObservableGauge outbox_pending_total
  // remains a placeholder (see WORKER_OUTBOX_METRIC_NAMES) because its
  // addCallback wiring needs a live DB pool — deferred to a follow-on
  // slice.
  "outbox_dead_letter_total",
  "outbox_drain_duration_seconds",
] as const satisfies readonly string[];

export type WorkerMetricName = (typeof WORKER_METRIC_NAMES)[number];

/**
 * Canonical names of Track C outbox signals **registered** by this module
 * as definitions only — no emission helper exposed. Today only
 * outbox_pending_total remains here; outbox_dead_letter_total and
 * outbox_drain_duration_seconds graduated to WORKER_METRIC_NAMES in PR-B-1.
 * Adding outbox_pending_total's addCallback is the Track C follow-on slice.
 */
export const WORKER_OUTBOX_METRIC_NAMES = [
  "outbox_pending_total",
] as const satisfies readonly string[];

export type WorkerOutboxMetricName = (typeof WORKER_OUTBOX_METRIC_NAMES)[number];
