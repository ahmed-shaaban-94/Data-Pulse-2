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
import { Injectable } from "@nestjs/common";
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
 */
export interface AuditQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

@Injectable()
export class AuditQueueProducer implements AuditJobEnqueuer {
  constructor(private readonly queue: Queue | AuditQueueLike) {}

  async enqueue(payload: AuditJobPayload): Promise<void> {
    // No jobId — every emission must produce a distinct BullMQ job entry.
    await this.queue.add(AUDIT_FANOUT_JOB_NAME_API, { ...payload, traceContext: injectTraceContext() });
  }
}
