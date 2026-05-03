/**
 * BullMQ default options — slice 7 (T092).
 *
 * Publishes the canonical retry / backoff / retention defaults that
 * every queue (email today; audit-fanout, session-revoke later) shares.
 *
 * This module is *only* the policy — the values. Wiring these defaults
 * into the producer (`apps/api/src/auth/auth.module.ts`) and the worker
 * factory (`apps/worker/src/worker.module.ts`) lands in T301; that PR
 * will also add per-queue DLQ metrics. Splitting the policy from the
 * wiring keeps each PR reviewable for what it is: this one is "are
 * these the right numbers?", T301 is "do we apply them everywhere?"
 *
 * On "DLQ"
 * --------
 * BullMQ has no separate dead-letter queue. When a job exhausts its
 * `attempts`, BullMQ marks it failed and keeps it in the failed-jobs
 * Redis set with full retry history (timestamps, stack traces, the
 * original payload). The failed-jobs set IS the DLQ. The "DLQ
 * defaults" referenced in the task list are really the *retention
 * policy* for that set — `removeOnFail` below. T301 will add metrics
 * over the failed-set count.
 *
 * On idempotency
 * --------------
 * Every consumer handler in this codebase is required to be idempotent
 * because BullMQ retries can re-deliver a job. The `EmailQueueProducer`
 * (`apps/api/src/auth/email-queue.producer.ts`) sets `jobId` from a
 * deterministic hash of the raw token, so the queue dedupes upstream;
 * the processor's payload validation (PR #15) is also idempotent on
 * malformed input. These defaults assume that contract.
 *
 * Tunings
 * -------
 * Numbers below reflect "transactional infrastructure" traffic patterns:
 * low job rate, low cost-per-retry, must-not-lose-jobs. Per-queue
 * overrides (e.g., higher concurrency for audit-fanout) belong in T301.
 */
import type { JobsOptions, WorkerOptions } from "bullmq";

/**
 * Default per-job options. Applied at the producer side via
 * `new Queue(name, { defaultJobOptions: DEFAULT_JOB_OPTIONS, ... })`.
 * The producer decides per-job retry policy; the worker cannot override
 * this from its side once a job is enqueued.
 *
 * Sequence: 1 initial attempt + 4 retries at 1s, 2s, 4s, 8s
 * (exponential, base 1000ms). Total wait ≈ 15s before a job lands in
 * the failed set; long enough for transient Redis blips, short enough
 * that a poison message is visible within a minute.
 */
export const DEFAULT_JOB_OPTIONS: Readonly<JobsOptions> = deepFreeze({
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1_000,
  },
  removeOnComplete: {
    age: 24 * 3600, // 24h — keep successful jobs visible for support tickets
    count: 1_000, // cap on retained successful jobs (oldest dropped first)
  },
  removeOnFail: {
    age: 7 * 24 * 3600, // 7d — failed-set retention; this IS the DLQ
    count: 10_000, // higher cap than completed: failures are forensic record
  },
});

/**
 * Default worker-side options. Applied at every `new Worker(name, h, opts)`
 * once T301 wires `BullMqWorkerFactory` to read this constant.
 *
 * Single source of truth for: how many jobs in flight at once, how
 * long a handler can hold the lock, when stalled jobs are reclaimed.
 */
export const DEFAULT_WORKER_OPTIONS: Readonly<
  Pick<
    WorkerOptions,
    "concurrency" | "lockDuration" | "stalledInterval" | "maxStalledCount"
  >
> = deepFreeze({
  concurrency: 4, // 4 in-flight jobs per worker process; conservative default
  lockDuration: 30_000, // 30s — handlers must finish or extend within this
  stalledInterval: 30_000, // 30s — how often the worker checks for stalled jobs
  maxStalledCount: 1, // a stalled job gets one re-pickup before failing
});

/**
 * Recursively `Object.freeze` an object and any plain-object children.
 * Cheap runtime safety belt: TypeScript's `Readonly<>` is structural
 * only and lets `(opts as JobsOptions).attempts = 1` slip through. This
 * makes such a mutation throw in strict mode and silently no-op in
 * sloppy mode — either way, the bug is loud.
 *
 * Exported for the spec; not consumed by production code.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}
