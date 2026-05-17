/**
 * T581 — OutboxModule: drainer wiring in the worker.
 *
 * Wires the outbox drainer pipeline:
 *   - `OutboxConsumerRegistry` — maps event_type → consumer
 *   - `AuditEventCreatedConsumer` — T584 consumer
 *   - `DrainerProcessor` — poll loop (setInterval)
 *   - `OutboxDrainerRunner` — Nest lifecycle hook that starts/stops the drainer
 *
 * Pool reuse
 * ----------
 * The drainer reuses the existing `AuditDbPool` (PG_POOL) from `WorkerModule`
 * for its claim and state-transition queries. The pool lifecycle is already
 * managed by `AuditDbPool.onModuleDestroy`. No new pool is created.
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
 * `onModuleDestroy` stops it.
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

import { AuditDbPool, PG_POOL } from "../worker.module";
import { OutboxConsumerRegistry } from "./registry";
import {
  AuditEventCreatedConsumer,
  type AuditQueueLike,
  OUTBOX_AUDIT_QUEUE_NAME,
} from "./consumers/audit-event-created.consumer";
import { DrainerProcessor } from "./drainer.processor";

// ---------------------------------------------------------------------------
// DI tokens
// ---------------------------------------------------------------------------

export const OUTBOX_AUDIT_QUEUE = "OUTBOX_AUDIT_QUEUE";
export const OUTBOX_DRAINER = "OUTBOX_DRAINER";

// ---------------------------------------------------------------------------
// NoOp queue — dev/test without Redis
// ---------------------------------------------------------------------------

/**
 * No-op BullMQ queue for dev/test environments without REDIS_URL.
 * Matches the `AuditQueueLike` interface so `AuditEventCreatedConsumer`
 * can be constructed normally.
 */
export class NoOpAuditQueue implements AuditQueueLike {
  async add(_name: string, _data: unknown, _opts?: Record<string, unknown>): Promise<unknown> {
    // intentionally empty — dev/test environments without REDIS_URL
    return null;
  }
}

/**
 * Factory for the OUTBOX_AUDIT_QUEUE provider.
 * Uses the same Redis URL guard as the API's `AuditEnqueuerModule`.
 */
export function outboxAuditQueueFactory(): AuditQueueLike {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "OutboxModule: REDIS_URL is required in production " +
          "(audit consumer cannot enqueue without it).",
      );
    }
    return new NoOpAuditQueue();
  }
  return new Queue(OUTBOX_AUDIT_QUEUE_NAME, {
    connection: { url },
    defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
  });
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

const outboxAuditQueueProvider: Provider = {
  provide: OUTBOX_AUDIT_QUEUE,
  useFactory: outboxAuditQueueFactory,
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

const drainerProcessorProvider: Provider = {
  provide: OUTBOX_DRAINER,
  useFactory: (poolWrapper: AuditDbPool, registry: OutboxConsumerRegistry): DrainerProcessor | null => {
    const pool = poolWrapper.pool;
    if (pool === null) {
      // No-DB path: drainer can't run without a pool. Return null and let
      // OutboxDrainerRunner handle it gracefully.
      return null;
    }
    return new DrainerProcessor({ pool, registry });
  },
  inject: [AuditDbPool, OutboxConsumerRegistry],
};

const outboxDrainerRunnerProvider: Provider = {
  provide: OutboxDrainerRunner,
  useFactory: (drainer: DrainerProcessor | null): OutboxDrainerRunner => {
    // When pool is null (no-DB path), use a no-op DrainerProcessor-like object.
    if (drainer === null) {
      return new OutboxDrainerRunner({
        start: () => { /* no-op: no pool available */ },
        stop: () => { /* no-op */ },
        tick: async () => { /* no-op */ },
      } as unknown as DrainerProcessor);
    }
    return new OutboxDrainerRunner(drainer);
  },
  inject: [OUTBOX_DRAINER],
};

@Module({
  imports: [],
  providers: [
    outboxAuditQueueProvider,
    outboxConsumerRegistryProvider,
    drainerProcessorProvider,
    outboxDrainerRunnerProvider,
  ],
  exports: [
    OUTBOX_AUDIT_QUEUE,
    OutboxConsumerRegistry,
    OUTBOX_DRAINER,
    OutboxDrainerRunner,
  ],
})
export class OutboxModule {}
