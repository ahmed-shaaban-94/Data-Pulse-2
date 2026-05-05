import { Injectable } from "@nestjs/common";
import type { AuditJobPayload } from "./audit-job.types";

/**
 * Seam for placing audit jobs onto the worker queue.
 *
 * Implementations MUST NOT block the request path — they enqueue and
 * return. Actual persistence happens in the audit fan-out worker (T233).
 *
 * Current implementations:
 *   - `NoOpAuditJobEnqueuer` — this file; used in dev / test before
 *     the BullMQ-backed implementation lands in T232/T233.
 *   - `AuditQueueProducer` — T232/T233; backed by a BullMQ `Queue`.
 *
 * DI token: `AUDIT_JOB_ENQUEUER`. Declared here so T232/T233 can
 * provide the production implementation without modifying this file.
 */
export interface AuditJobEnqueuer {
  enqueue(payload: AuditJobPayload): Promise<void>;
}

/**
 * `NoOpAuditJobEnqueuer` — explicitly does nothing.
 *
 * Wired by the test harness and used in dev environments before T232/T233
 * lands the BullMQ-backed `AuditQueueProducer`. The name is intentionally
 * explicit so a production wiring review will catch any lingering NoOp.
 */
@Injectable()
export class NoOpAuditJobEnqueuer implements AuditJobEnqueuer {
  async enqueue(_payload: AuditJobPayload): Promise<void> {
    // intentionally empty — no job is queued, no audit event is emitted
  }
}

/**
 * DI token for the enqueuer. T232/T233 binds it to `AuditQueueProducer`
 * when `REDIS_URL` is set; tests bind it to a Jest spy via
 * `overrideProvider(AUDIT_JOB_ENQUEUER)` or pass a spy directly to the
 * interceptor constructor.
 */
export const AUDIT_JOB_ENQUEUER = "AUDIT_JOB_ENQUEUER";
