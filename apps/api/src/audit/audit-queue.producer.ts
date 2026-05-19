/**
 * AuditQueueProducer — Scope A audit wiring.
 *
 * Concrete `AuditJobEnqueuer` backed by a BullMQ `Queue` named "audit".
 * The matching fan-out processor (`AuditFanoutProcessor`) already lives in
 * `apps/worker/src/audit/audit-fanout.processor.ts` (T233); this file ships
 * the producer side so `AuditEmitterInterceptor` can enqueue real jobs.
 *
 * No-dedup by design
 * ------------------
 * Unlike `EmailQueueProducer`, this producer MUST NOT set a deterministic
 * `jobId`. Every `@Auditable` action must produce a distinct row in
 * `audit_events` — deduplication via jobId would silently suppress audit
 * records when an HTTP request is retried, violating FR-AUDIT-1.
 *
 * Cross-app constant mirror
 * -------------------------
 * `AUDIT_FANOUT_JOB_NAME_API` intentionally mirrors
 * `AUDIT_FANOUT_JOB_NAME` in `apps/worker/src/audit/audit-fanout.processor.ts`.
 * `apps/api` MUST NOT import that constant directly — cross-app imports
 * violate the monorepo app boundary. A future shared-package slice will
 * consolidate both into `@data-pulse-2/shared/queues/audit-config`.
 * Until then, keep the two in sync manually; the literal-equality tests
 * in `audit-queue.producer.spec.ts` pin both to `"audit-fanout"`.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Queue } from "bullmq";
import { injectTraceContext } from "@data-pulse-2/shared/observability/otel";
import type { AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";

/** BullMQ queue name for audit jobs. */
export const AUDIT_QUEUE_NAME = "audit";

/**
 * BullMQ job name used by both this producer and the audit fan-out worker.
 *
 * API-local mirror of `AUDIT_FANOUT_JOB_NAME` in
 * `apps/worker/src/audit/audit-fanout.processor.ts`.
 * See module docstring for the cross-app boundary rationale.
 */
export const AUDIT_FANOUT_JOB_NAME_API = "audit-fanout";

/**
 * Minimal `Queue` surface this producer relies on. Keeping it narrow lets
 * unit specs pass an in-memory fake without any BullMQ runtime.
 *
 * `close()` is OPTIONAL so existing in-memory test doubles continue to
 * work without a no-op stub; the producer's `onModuleDestroy` checks for
 * the method before invoking it (see class below). Real `bullmq.Queue`
 * always exposes `close()`.
 */
export interface AuditQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * AuditQueueProducer owns the underlying BullMQ `Queue`'s background
 * connection lifetime in production (`auditJobEnqueuerFactory` constructs
 * the Queue and hands it in here, with no other owner). Nest's
 * `OnModuleDestroy` lifecycle hook lets us close that connection cleanly
 * when the module shuts down -- without this hook, the queue's background
 * ioredis client survives Nest's `app.close()` and Jest reports
 * "worker process has failed to exit gracefully" at suite teardown,
 * which CI's exit-code aggregation flips from warning to error past a
 * leak-count threshold (observed on PR #240). See branch
 * `fix/api-queue-producers-close-on-destroy`.
 */
@Injectable()
export class AuditQueueProducer
  implements AuditJobEnqueuer, OnModuleDestroy
{
  private closed = false;

  constructor(private readonly queue: Queue | AuditQueueLike) {}

  async enqueue(payload: AuditJobPayload): Promise<void> {
    // No jobId — every emission must produce a distinct BullMQ job entry.
    await this.queue.add(AUDIT_FANOUT_JOB_NAME_API, { ...payload, traceContext: injectTraceContext() });
  }

  /**
   * Close the underlying BullMQ Queue on module shutdown.
   *
   * Idempotent: a second call is a no-op (Nest's lifecycle CAN fire
   * close cycles more than once in some `Test.createTestingModule`
   * teardown patterns; bullmq's own `Queue.close()` is itself
   * idempotent, but the guard avoids double-await and keeps the
   * intent obvious).
   *
   * Defensive: optional-chain on `close` so in-memory test doubles
   * that omit the method continue to work. Errors from `close()` are
   * swallowed -- shutdown is best-effort and a failed close on a
   * already-disconnected client is exactly the noise we don't want
   * to log at process exit.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeFn = (this.queue as AuditQueueLike).close;
    if (typeof closeFn === "function") {
      try {
        await closeFn.call(this.queue);
      } catch {
        // Best-effort: a failing close on a queue we're tearing down
        // anyway shouldn't crash the shutdown path.
      }
    }
  }
}
