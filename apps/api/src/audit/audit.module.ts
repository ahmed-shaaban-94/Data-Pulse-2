/**
 * AuditModule — Scope A wiring.
 *
 * Provides the `AUDIT_JOB_ENQUEUER` token and registers
 * `AuditEmitterInterceptor` as a global interceptor via the `APP_INTERCEPTOR`
 * DI token.
 *
 * APP_INTERCEPTOR vs useGlobalInterceptors
 * ----------------------------------------
 * `AuditEmitterInterceptor` is registered through `APP_INTERCEPTOR` (not via
 * `app.useGlobalInterceptors(new X(...))` in `main.ts`) because:
 *   1. The interceptor has a DI dependency on `AUDIT_JOB_ENQUEUER`.
 *   2. Integration tests need `overrideProvider(AUDIT_JOB_ENQUEUER)` to
 *      work — that only functions when the interceptor is DI-managed.
 *   Manual construction bypasses the DI container and breaks overrideProvider.
 *
 * Factory wiring policy (mirrors `emailJobEnqueuerFactory` in AuthModule)
 * -----------------------------------------------------------------------
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throw at boot.
 *     Silently dropping audit jobs in production is a governance hazard.
 *   - non-production + `REDIS_URL` missing → fall back to
 *     `NoOpAuditJobEnqueuer` so dev / CI machines without Redis still boot.
 *   - `REDIS_URL` set → build an `AuditQueueProducer` backed by a BullMQ Queue.
 *
 * The optional `queueFactory` parameter is a test seam: unit specs inject a
 * `FakeQueue` so the factory can be exercised without a live Redis connection.
 *
 * Operational note
 * ----------------
 * If `REDIS_URL` is set but the audit fan-out worker (Scope B) is not yet
 * deployed, every `@Auditable` request enqueues a BullMQ job that accumulates
 * in Redis. Jobs drain normally once the worker starts — no data loss. However,
 * flushing Redis before deploying the worker loses those audit records permanently.
 * Deploy the audit-fanout worker (Scope B) or keep `NODE_ENV` non-production to
 * use `NoOpAuditJobEnqueuer` until the worker is ready.
 */
import { Module, type Provider } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Reflector } from "@nestjs/core";
import { Queue, type JobsOptions } from "bullmq";

import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { AuditEmitterInterceptor } from "./audit-emitter.interceptor";
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

export function auditJobEnqueuerFactory(
  queueFactory?: (url: string) => AuditQueueLike,
): AuditJobEnqueuer {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
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

const auditJobEnqueuerProvider: Provider = {
  provide: AUDIT_JOB_ENQUEUER,
  useFactory: auditJobEnqueuerFactory,
};

const auditInterceptorProvider: Provider = {
  provide: APP_INTERCEPTOR,
  useFactory: (reflector: Reflector, enqueuer: AuditJobEnqueuer) =>
    new AuditEmitterInterceptor(reflector, enqueuer),
  inject: [Reflector, AUDIT_JOB_ENQUEUER],
};

@Module({
  providers: [auditJobEnqueuerProvider, auditInterceptorProvider],
  exports: [AUDIT_JOB_ENQUEUER],
})
export class AuditModule {}
