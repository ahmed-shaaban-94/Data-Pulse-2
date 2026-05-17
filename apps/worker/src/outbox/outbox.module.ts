/**
 * T581 — OutboxModule: outbox primitives consumed by the worker drainer.
 *
 * Provides the pool-independent half of the drainer pipeline:
 *   - `OUTBOX_AUDIT_QUEUE` — BullMQ queue seam (or NoOp without REDIS_URL)
 *   - `OutboxConsumerRegistry` — maps event_type → consumer
 *   - `AuditEventCreatedConsumer` — T584 consumer (registered into the registry)
 *
 * The `DrainerProcessor` (which owns the poll loop and claims rows from the
 * outbox via `AuditDbPool.pool`) and the Nest-lifecycle `OutboxDrainerRunner`
 * are NOT declared here. They live in `WorkerModule` because they depend on
 * `AuditDbPool`, which is itself a `WorkerModule`-scoped provider. Nest only
 * lets providers see siblings declared in the same module (or exported from
 * imports it pulls in). Since `WorkerModule imports [OutboxModule]`, the
 * dependency flows downstream — `OutboxModule` cannot inject `AuditDbPool`.
 *
 * Pool reuse
 * ----------
 * `WorkerModule` constructs the drainer with the existing `AuditDbPool`
 * (PG_POOL) so no new Postgres pool is created. Pool lifecycle stays on
 * `AuditDbPool.onModuleDestroy`.
 *
 * BullMQ Queue seam
 * -----------------
 * The audit consumer needs to enqueue to BullMQ "audit" queue. We wire a
 * local `Queue` instance here (mirroring `AuditEnqueuerModule` on the API side)
 * under the `OUTBOX_AUDIT_QUEUE` token. In dev/test with no REDIS_URL, a
 * NoOpAuditQueue is used.
 *
 * Worker bootstrap
 * ----------------
 * The drainer does NOT use `BullMqWorkerFactory` — it is a DB-polling loop,
 * not a BullMQ consumer. `OutboxDrainerRunner.onModuleInit` starts the loop;
 * `onModuleDestroy` stops it. Both live in `worker.module.ts`.
 */
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Module,
  type Provider,
} from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { OutboxConsumerRegistry } from "./registry";
import {
  AuditEventCreatedConsumer,
  type AuditQueueLike,
  OUTBOX_AUDIT_QUEUE_NAME,
} from "./consumers/audit-event-created.consumer";
import type { DrainerProcessor } from "./drainer.processor";

// ---------------------------------------------------------------------------
// DI tokens
// ---------------------------------------------------------------------------

export const OUTBOX_AUDIT_QUEUE = "OUTBOX_AUDIT_QUEUE";

// ---------------------------------------------------------------------------
// NoOp queue — dev/test without Redis
// ---------------------------------------------------------------------------

/**
 * No-op BullMQ queue for dev/test environments without REDIS_URL.
 * Matches the `AuditQueueLike` interface so `AuditEventCreatedConsumer`
 * can be constructed normally. No shutdown is needed — there is no
 * underlying connection to close.
 */
export class NoOpAuditQueue implements AuditQueueLike {
  async add(_name: string, _data: unknown, _opts?: Record<string, unknown>): Promise<unknown> {
    // intentionally empty — dev/test environments without REDIS_URL
    return null;
  }
}

// ---------------------------------------------------------------------------
// OutboxAuditQueue — Nest-aware wrapper with lifecycle
// ---------------------------------------------------------------------------

/**
 * Class-token wrapper around the underlying queue (real BullMQ `Queue` or
 * `NoOpAuditQueue`) so Nest can fire `onModuleDestroy` on shutdown.
 *
 * Why a wrapper class
 * -------------------
 * Nest only invokes `onModuleDestroy` on providers whose resolved value is
 * a class instance with that hook. A `useFactory` returning a raw `Queue`
 * is opaque to Nest — `app.close()` would not call `queue.close()`, and on
 * SIGTERM the worker process would hang on the open Redis connection until
 * forced. Mirrors the `AuditDbPool` pattern in `worker.module.ts`.
 *
 * The NoOp path passes a null `closeFn` so `onModuleDestroy` is itself a
 * no-op — there is no Redis connection to release.
 */
@Injectable()
export class OutboxAuditQueue implements AuditQueueLike, OnModuleDestroy {
  private destroyed = false;

  constructor(
    private readonly inner: AuditQueueLike,
    private readonly closeFn: (() => Promise<void>) | null,
  ) {}

  async add(
    name: string,
    data: unknown,
    opts?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.inner.add(name, data, opts);
  }

  /**
   * Nest lifecycle hook — fires on `app.close()` from `main.ts`.
   *
   * Idempotent: a second invocation is a no-op (the `destroyed` flag flips
   * before awaiting `closeFn`, mirroring `AuditDbPool.onModuleDestroy`).
   *
   * For the real `Queue` path this calls `Queue.close()`, which drains the
   * internal connection pool. For the NoOp path `closeFn` is null and this
   * is a no-op.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.closeFn !== null) {
      await this.closeFn();
    }
  }
}

/**
 * Factory for the OutboxAuditQueue / OUTBOX_AUDIT_QUEUE providers.
 * Uses the same Redis URL guard as the API's `AuditEnqueuerModule`.
 *
 * Returns an `OutboxAuditQueue` (the lifecycle-aware wrapper) — never a
 * raw `Queue` — so Nest's `onModuleDestroy` hook fires on shutdown.
 */
export function outboxAuditQueueFactory(): OutboxAuditQueue {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "OutboxModule: REDIS_URL is required in production " +
          "(audit consumer cannot enqueue without it).",
      );
    }
    return new OutboxAuditQueue(new NoOpAuditQueue(), null);
  }
  const queue = new Queue(OUTBOX_AUDIT_QUEUE_NAME, {
    connection: { url },
    defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
  });
  return new OutboxAuditQueue(queue, () => queue.close());
}

// ---------------------------------------------------------------------------
// OutboxDrainerRunner — Nest lifecycle integration
// ---------------------------------------------------------------------------

/**
 * Thin Nest-aware wrapper that starts and stops the `DrainerProcessor`
 * on module init/destroy. Not a NestJS injectable in the usual sense —
 * constructed via useFactory with explicit deps.
 */
@Injectable()
export class OutboxDrainerRunner implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly drainer: DrainerProcessor) {}

  onModuleInit(): void {
    this.drainer.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.drainer.stop();
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

// OutboxAuditQueue is registered as a CLASS-token provider so Nest tracks
// it for lifecycle hooks (mirrors the `AuditDbPool` pattern in worker.module.ts).
// The string token OUTBOX_AUDIT_QUEUE aliases the same instance via
// useExisting, preserving a stable injection identifier for downstream
// consumers (`AuditEventCreatedConsumer`).
const outboxAuditQueueClassProvider: Provider = {
  provide: OutboxAuditQueue,
  useFactory: outboxAuditQueueFactory,
};

const outboxAuditQueueTokenProvider: Provider = {
  provide: OUTBOX_AUDIT_QUEUE,
  useExisting: OutboxAuditQueue,
};

const outboxConsumerRegistryProvider: Provider = {
  provide: OutboxConsumerRegistry,
  useFactory: (auditQueue: AuditQueueLike): OutboxConsumerRegistry => {
    const registry = new OutboxConsumerRegistry();
    registry.register(new AuditEventCreatedConsumer(auditQueue));
    return registry;
  },
  inject: [OUTBOX_AUDIT_QUEUE],
};

@Module({
  imports: [],
  providers: [
    outboxAuditQueueClassProvider,
    outboxAuditQueueTokenProvider,
    outboxConsumerRegistryProvider,
  ],
  exports: [
    OutboxAuditQueue,
    OUTBOX_AUDIT_QUEUE,
    OutboxConsumerRegistry,
  ],
})
export class OutboxModule {}
