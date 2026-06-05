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
import {
  SaleCapturedConsumer,
  type SaleProcessingQueueLike,
  OUTBOX_SALE_PROCESSING_QUEUE_NAME,
} from "./consumers/sale-captured.consumer";
import type { DrainerProcessor } from "./drainer.processor";

// ---------------------------------------------------------------------------
// DI tokens
// ---------------------------------------------------------------------------

export const OUTBOX_AUDIT_QUEUE = "OUTBOX_AUDIT_QUEUE";
export const OUTBOX_SALE_PROCESSING_QUEUE = "OUTBOX_SALE_PROCESSING_QUEUE";

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
// Sale-processing BullMQ Queue seam — DP-008-LIVELOOP
// ---------------------------------------------------------------------------

/**
 * No-op BullMQ queue for dev/test environments without REDIS_URL. Matches the
 * `SaleProcessingQueueLike` interface so `SaleCapturedConsumer` can be
 * constructed normally. Mirrors `NoOpAuditQueue`.
 */
export class NoOpSaleProcessingQueue implements SaleProcessingQueueLike {
  async add(_name: string, _data: unknown, _opts?: Record<string, unknown>): Promise<unknown> {
    // No Redis → the captured sale is NOT enqueued. Unlike the audit NoOp,
    // a dropped sale.captured enqueue silently breaks the live loop, so we
    // emit a structured stderr warn so the dropped enqueue is visible in
    // dev/staging (prod still throws in the factory). Diagnostic only — the
    // line carries a STATIC message, NO job data / sale row / line amounts
    // (FR-042 / FR-092). Keep returning null; tests rely on the NoOp.
    const line = JSON.stringify({
      level: "warn",
      component: "outbox.sale-processing-queue",
      message:
        "sale.captured enqueue dropped — REDIS_URL not configured (NoOp queue)",
    });
    process.stderr.write(line + "\n");
    return null;
  }
}

/**
 * Class-token wrapper around the underlying queue (real BullMQ `Queue` or
 * `NoOpSaleProcessingQueue`) so Nest can fire `onModuleDestroy` on shutdown.
 * Mirrors `OutboxAuditQueue` exactly — see that class for why a wrapper is
 * required (Nest only fires lifecycle hooks on class-instance providers, so a
 * raw `Queue` from a `useFactory` would leak its Redis connection on SIGTERM).
 */
@Injectable()
export class OutboxSaleProcessingQueue
  implements SaleProcessingQueueLike, OnModuleDestroy
{
  private destroyed = false;

  constructor(
    private readonly inner: SaleProcessingQueueLike,
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
   * Nest lifecycle hook — fires on `app.close()` from `main.ts`. Idempotent;
   * the NoOp path passes a null `closeFn` so this is itself a no-op. Mirrors
   * `OutboxAuditQueue.onModuleDestroy`.
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
 * Factory for the OutboxSaleProcessingQueue / OUTBOX_SALE_PROCESSING_QUEUE
 * providers. Uses the same Redis URL guard as `outboxAuditQueueFactory`.
 *
 * Returns an `OutboxSaleProcessingQueue` (the lifecycle-aware wrapper) — never a
 * raw `Queue` — so Nest's `onModuleDestroy` hook fires on shutdown.
 */
export function outboxSaleProcessingQueueFactory(): OutboxSaleProcessingQueue {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "OutboxModule: REDIS_URL is required in production " +
          "(sale.captured consumer cannot enqueue without it).",
      );
    }
    return new OutboxSaleProcessingQueue(new NoOpSaleProcessingQueue(), null);
  }
  const queue = new Queue(OUTBOX_SALE_PROCESSING_QUEUE_NAME, {
    connection: { url },
    defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
  });
  return new OutboxSaleProcessingQueue(queue, () => queue.close());
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

// OutboxSaleProcessingQueue is registered as a CLASS-token provider (lifecycle
// tracking) with the string token OUTBOX_SALE_PROCESSING_QUEUE aliasing the same
// instance via useExisting — mirrors the OutboxAuditQueue provider pair above.
const outboxSaleProcessingQueueClassProvider: Provider = {
  provide: OutboxSaleProcessingQueue,
  useFactory: outboxSaleProcessingQueueFactory,
};

const outboxSaleProcessingQueueTokenProvider: Provider = {
  provide: OUTBOX_SALE_PROCESSING_QUEUE,
  useExisting: OutboxSaleProcessingQueue,
};

const outboxConsumerRegistryProvider: Provider = {
  provide: OutboxConsumerRegistry,
  useFactory: (
    auditQueue: AuditQueueLike,
    saleProcessingQueue: SaleProcessingQueueLike,
  ): OutboxConsumerRegistry => {
    const registry = new OutboxConsumerRegistry();
    registry.register(new AuditEventCreatedConsumer(auditQueue));
    registry.register(new SaleCapturedConsumer(saleProcessingQueue));
    return registry;
  },
  inject: [OUTBOX_AUDIT_QUEUE, OUTBOX_SALE_PROCESSING_QUEUE],
};

@Module({
  imports: [],
  providers: [
    outboxAuditQueueClassProvider,
    outboxAuditQueueTokenProvider,
    outboxSaleProcessingQueueClassProvider,
    outboxSaleProcessingQueueTokenProvider,
    outboxConsumerRegistryProvider,
  ],
  exports: [
    OutboxAuditQueue,
    OUTBOX_AUDIT_QUEUE,
    OutboxSaleProcessingQueue,
    OUTBOX_SALE_PROCESSING_QUEUE,
    OutboxConsumerRegistry,
  ],
})
export class OutboxModule {}
