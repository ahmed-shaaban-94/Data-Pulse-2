/**
 * AuditModule — Scope A (write-side) + read-side query API wiring.
 *
 * Write side (Scope A — pre-existing)
 * -----------------------------------
 * Provides the `AUDIT_JOB_ENQUEUER` token and registers
 * `AuditEmitterInterceptor` as a global interceptor via the `APP_INTERCEPTOR`
 * DI token.
 *
 * Read side (T235)
 * ----------------
 * Registers `AuditController` (`GET /api/v1/audit/events`), `AuditService`,
 * and the `AUDIT_REPOSITORY` token bound to `DrizzleAuditRepository`.
 * Imports `AuthModule` + `ContextModule` so the controller's guard chain
 * (`AuthGuard` → `TenantContextGuard` → `RolesGuard`) and the
 * repository's `PG_POOL` injection resolve through normal NestJS module
 * imports — same pattern as `StoresModule` / `MembershipsModule`.
 *
 * `audit.module.spec.ts` overrides `PG_POOL` (and the other AuthModule
 * boot-time providers) before `.compile()` so its standalone
 * AuditModule build still works with no `DATABASE_URL` set.
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

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";

import { AuditController } from "./audit.controller";
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
import {
  AUDIT_REPOSITORY,
  DrizzleAuditRepository,
} from "./audit.repository";
import { AuditService } from "./audit.service";

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

const auditRepositoryProvider: Provider = {
  provide: AUDIT_REPOSITORY,
  useClass: DrizzleAuditRepository,
};

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [AuditController],
  providers: [
    auditJobEnqueuerProvider,
    auditInterceptorProvider,
    auditRepositoryProvider,
    AuditService,
    RolesGuard,
  ],
  exports: [AUDIT_JOB_ENQUEUER],
})
export class AuditModule {}
