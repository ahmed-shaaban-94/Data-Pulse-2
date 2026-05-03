/**
 * WorkerModule — slice 6 (T091).
 *
 * Wires the worker side of the email pipeline:
 *
 *   EmailWorker
 *     ├─ EmailProcessor                           (PR #15)
 *     │    └─ EMAIL_ADAPTER                       (NoOpEmailAdapter — PR #15)
 *     └─ WORKER_FACTORY
 *           - production:  BullMqWorkerFactory(REDIS_URL)
 *           - dev / test:  NoOpWorkerFactory       (no Redis required)
 *
 * Production wiring (current state)
 * ---------------------------------
 *   - `EMAIL_ADAPTER` defaults to `NoOpEmailAdapter` (provider deferred,
 *     PQ-1). The class name is loud on purpose; production deploys MUST
 *     override this provider before going live.
 *   - `WORKER_FACTORY` reads `REDIS_URL`:
 *       * `NODE_ENV=production` + `REDIS_URL` missing → throws at boot.
 *         Silently consuming nothing while the producer fills the queue
 *         is a safety hazard; we fail loud instead.
 *       * non-production + `REDIS_URL` missing → falls back to
 *         `NoOpWorkerFactory` so dev / CI machines without Redis still
 *         boot. Same fallback policy as `apps/api`'s `AuthModule`.
 *       * `REDIS_URL` set → builds a real `BullMqWorkerFactory` that
 *         constructs `new bullmq.Worker(name, handler, { connection })`.
 *
 * Tests substitute fakes via `Test.createTestingModule(...)
 * .overrideProvider(...)`. No Redis, no BullMQ runtime, no provider
 * SDK is loaded under test.
 *
 * What is NOT in this module
 * --------------------------
 *   - Retry / backoff / DLQ defaults — T092 (queue.config.ts).
 *   - Audit-fanout / session-revoke workers — T232, T302.
 *   - OTel propagation from API → worker — T303.
 *   - Real provider SDK — PQ-1.
 */
import { Module } from "@nestjs/common";
import { Worker as BullMqWorker, type WorkerOptions } from "bullmq";

import {
  EMAIL_ADAPTER,
  type EmailAdapter,
  NoOpEmailAdapter,
} from "./email/email.adapter";
import { EmailProcessor } from "./email/email.processor";
import {
  type EmailJobHandler,
  EmailWorker,
  type WorkerFactory,
  type WorkerLike,
  type WorkerStartOptions,
  WORKER_FACTORY,
} from "./email/email.worker";

/**
 * Real BullMQ-backed factory. Constructs a `bullmq.Worker` that
 * subscribes to the named queue and delegates each job to `handler`.
 *
 * Connection: `{ url: REDIS_URL }`. We do NOT eagerly construct an
 * `ioredis` client here — BullMQ owns its own connection lifecycle and
 * the URL form is the simplest production-safe wiring.
 *
 * `options` are spread into the `new Worker(...)` call so the shared
 * `DEFAULT_WORKER_OPTIONS` (concurrency, lockDuration, stalled-job
 * tuning) flow through unchanged.
 */
export class BullMqWorkerFactory implements WorkerFactory {
  constructor(private readonly redisUrl: string) {}

  create(
    queueName: string,
    handler: EmailJobHandler,
    options: WorkerStartOptions,
  ): WorkerLike {
    const workerOpts: WorkerOptions = {
      connection: { url: this.redisUrl },
      ...options,
    };
    return new BullMqWorker(
      queueName,
      async (job) => handler({ name: job.name, data: job.data }),
      workerOpts,
    );
  }
}

/**
 * Dev / test fallback. `start()` and `close()` are no-ops; no jobs are
 * ever consumed. The class name is loud so a deployment that ships
 * with this active is obvious in the dependency graph.
 *
 * Accepts the same options arg as `BullMqWorkerFactory` for interface
 * parity, then ignores it.
 */
export class NoOpWorkerFactory implements WorkerFactory {
  create(
    _queueName: string,
    _handler: EmailJobHandler,
    _options: WorkerStartOptions,
  ): WorkerLike {
    return {
      on: () => undefined,
      close: async () => {
        // intentionally empty — no underlying worker exists
      },
    };
  }
}

/**
 * Factory for the `WORKER_FACTORY` provider. Exported so tests can
 * call it directly and assert the production-vs-dev branch behavior.
 */
export function workerFactoryProviderFactory(): WorkerFactory {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "WorkerModule: REDIS_URL is required in production " +
          "(BullMQ Worker cannot be created without it).",
      );
    }
    return new NoOpWorkerFactory();
  }
  return new BullMqWorkerFactory(url);
}

@Module({
  providers: [
    {
      provide: EMAIL_ADAPTER,
      useFactory: (): EmailAdapter => new NoOpEmailAdapter(),
    },
    EmailProcessor,
    {
      provide: WORKER_FACTORY,
      useFactory: workerFactoryProviderFactory,
    },
    EmailWorker,
  ],
  exports: [EmailWorker, EmailProcessor],
})
export class WorkerModule {}
