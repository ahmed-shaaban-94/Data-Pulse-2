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
import type { Pool } from "pg";

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
import { OutboxAuditEnqueuer } from "./outbox-audit-enqueuer";

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
 * direct BullMQ enqueueing. Defaults OFF — production cutover is operator-
 * driven, not code-driven.
 *
 * The DI swap landed with slice 1C-B2 (T583): `outboxOrLegacyAuditJobEnqueuerFactory`
 * below consults this flag and returns either an OutboxAuditEnqueuer (flag on +
 * pool present) or the legacy AuditQueueProducer / NoOpAuditJobEnqueuer (flag
 * off, or flag on but pool unavailable).
 *
 * The live binding lives in `OutboxAuditEnqueuerModule` (a sibling leaf module
 * that imports AuthModule to inject PG_POOL). This module — `AuditEnqueuerModule`
 * — keeps its legacy provider so `AuthModule` can still resolve
 * AUDIT_JOB_ENQUEUER for the auth-signin emission path without picking up the
 * outbox dependency on PG_POOL (which would re-introduce the
 * `AuthModule → AuditEnqueuerModule → AuthModule` cycle this leaf module
 * exists to avoid).
 *
 * The flag accepts the literal strings "1", "true", or "yes" (case-insensitive).
 */
export function isOutboxAuditEnabled(): boolean {
  const raw = (process.env["OUTBOX_AUDIT_ENABLED"] ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pool-aware factory used by `OutboxAuditEnqueuerModule` (slice 1C-B2, T583).
 *
 * Decision matrix:
 *
 *   OUTBOX_AUDIT_ENABLED unset/off            → legacy `auditJobEnqueuerFactory`
 *                                               (direct BullMQ enqueueing).
 *   OUTBOX_AUDIT_ENABLED on  + pool present   → `OutboxAuditEnqueuer`
 *                                               (writes audit.event.created
 *                                               rows to outbox_events).
 *   OUTBOX_AUDIT_ENABLED on  + pool null      → fall back to legacy +
 *                                               emit a PII-safe stderr line
 *                                               so an operator can see the
 *                                               configuration mismatch.
 *
 * Safe-fallback rationale (matches task instruction "fall back to legacy
 * only if the existing architecture clearly supports safe fallback"):
 *   - The legacy path is exactly what runs when the flag is off, so it is
 *     guaranteed-safe steady-state.
 *   - A flag-on + null-pool combination is a misconfiguration, not a
 *     failure mode; failing loud would crash request handling for a
 *     misconfiguration the operator can fix at runtime.
 *   - The structured stderr line ensures the misconfiguration is
 *     observable. Mirrors the PII-safe logging policy used by the
 *     drainer (drainer.processor.ts lines 307-334) and the outbox
 *     retention worker (retention.worker.ts).
 *
 * The `queueFactory` parameter passes through to the legacy fallback so
 * unit tests can swap the BullMQ Queue out without booting Redis.
 */
export function outboxOrLegacyAuditJobEnqueuerFactory(
  pool: Pool | null,
  queueFactory?: (url: string) => AuditQueueLike,
): AuditJobEnqueuer {
  if (!isOutboxAuditEnabled()) {
    return auditJobEnqueuerFactory(queueFactory);
  }
  if (pool === null) {
    // Misconfiguration: flag is on but no DB pool is available. The
    // legacy BullMQ path keeps audit emissions flowing while the
    // operator investigates. NEVER silently drop audit events.
    const line = JSON.stringify({
      level: "warn",
      component: "audit.enqueuer",
      message:
        "OUTBOX_AUDIT_ENABLED=1 but PG_POOL is null; falling back to legacy " +
        "BullMQ audit enqueuer. Check DATABASE_URL configuration.",
    });
    process.stderr.write(line + "\n");
    return auditJobEnqueuerFactory(queueFactory);
  }
  return new OutboxAuditEnqueuer(pool);
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
