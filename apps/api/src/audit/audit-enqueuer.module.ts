/**
 * AuditEnqueuerModule — shared write-side audit-job provider.
 *
 * Why this module exists
 * ----------------------
 * `AuditModule` imports `AuthModule` (read-side audit query controller mounts
 * `AuthGuard` / `RolesGuard`). To allow `AuthModule` to enqueue audit jobs
 * (T238 — `auth.signin.{ok|failed}` emission) without creating a circular
 * import (`AuthModule → AuditModule → AuthModule`), the `AUDIT_JOB_ENQUEUER`
 * provider is hoisted into this leaf module that depends on neither.
 *
 * Both `AuthModule` and `AuditModule` import this module; both consume the
 * same DI token, so a single `AuditQueueProducer` (or `NoOpAuditJobEnqueuer`
 * in dev/test) is shared across the request graph and tests can still call
 * `overrideProvider(AUDIT_JOB_ENQUEUER)` once to spy on every emission site.
 *
 * Wiring policy mirrors `auditJobEnqueuerFactory` previously inlined in
 * `AuditModule` (now imported from here) — production with `REDIS_URL`
 * unset throws; non-production falls back to `NoOpAuditJobEnqueuer`. The
 * BullMQ `Queue` constructor is identical, so the on-the-wire job contract
 * (queue name, default job options, no jobId) is preserved.
 */
import { Module, type Provider } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";

import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
  NoOpAuditJobEnqueuer,
} from "./audit-job.enqueuer";
import {
  AUDIT_QUEUE_NAME,
  AuditQueueProducer,
  type AuditQueueLike,
} from "./audit-queue.producer";

/**
 * Build the runtime `AuditJobEnqueuer`.
 *
 * Identical behaviour to the factory previously inlined in `AuditModule` —
 * only the call site has moved. The optional `queueFactory` parameter is
 * a unit-test seam so specs can construct a fake `Queue` without a live
 * Redis connection.
 */
export function auditJobEnqueuerFactory(
  queueFactory?: (url: string) => AuditQueueLike,
): AuditJobEnqueuer {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      // Error message intentionally retains the historical "AuditModule:"
      // prefix so existing operator runbooks and the
      // `audit-queue.producer.spec.ts` literal-string assertion remain
      // valid even though the factory has moved into this leaf module.
      throw new Error(
        "AuditModule: REDIS_URL is required in production " +
          "(AuditQueueProducer cannot be wired without it).",
      );
    }
    return new NoOpAuditJobEnqueuer();
  }
  const queue =
    queueFactory != null
      ? queueFactory(url)
      : new Queue(AUDIT_QUEUE_NAME, {
          connection: { url },
          defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
        });
  return new AuditQueueProducer(queue);
}

/**
 * Returns true when the outbox-backed audit path should be used in place of
 * direct BullMQ enqueueing. Slice 1B ships the OutboxAuditEnqueuer class and
 * this flag helper, but the live DI swap is intentionally deferred: doing it
 * in this module would require importing AuthModule (the holder of PG_POOL),
 * which would re-introduce the circular import this leaf module exists to
 * avoid (see the module docstring). The live swap will land alongside Slice
 * 1C's dead-letter admin endpoint, which already imports AuthModule for
 * RolesGuard — that's the natural place to wire it without a new circular.
 *
 * The flag accepts the literal strings "1", "true", or "yes" (case-insensitive).
 */
export function isOutboxAuditEnabled(): boolean {
  const raw = (process.env["OUTBOX_AUDIT_ENABLED"] ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const auditJobEnqueuerProvider: Provider = {
  provide: AUDIT_JOB_ENQUEUER,
  useFactory: auditJobEnqueuerFactory,
};

@Module({
  providers: [auditJobEnqueuerProvider],
  exports: [AUDIT_JOB_ENQUEUER],
})
export class AuditEnqueuerModule {}
