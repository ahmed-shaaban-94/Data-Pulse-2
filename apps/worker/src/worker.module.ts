/**
 * WorkerModule — slice 6 (T091) + PR-D audit wiring.
 *
 * Wires the worker side of two pipelines:
 *
 *   EmailWorker
 *     ├─ EmailProcessor                           (PR #15)
 *     │    └─ EMAIL_ADAPTER                       (NoOpEmailAdapter — PR #15)
 *     └─ WORKER_FACTORY                           (shared with AuditWorker)
 *
 *   AuditWorker                                   (PR-D)
 *     ├─ AuditFanoutProcessor                     (T232)
 *     │    └─ AUDIT_DB                            (DrizzleAuditDbAdapter or NoOpAuditDbAdapter)
 *     │          └─ AuditDbPool                   (Nest-managed wrapper around pg.Pool|null)
 *     │                └─ pg.Pool                 (built from DATABASE_URL)
 *     └─ WORKER_FACTORY                           (shared with EmailWorker)
 *
 * Why a wrapper class instead of a raw `pg.Pool` provider?
 * --------------------------------------------------------
 * NestJS only fires `onModuleDestroy` on providers whose resolved value
 * is a class instance with that hook. A `useFactory` that returned a
 * raw `Pool` would be a value-typed provider — Nest has no contract to
 * call `pool.end()` on it during `app.close()`. Under SIGTERM the
 * worker process would hang on open Postgres connections until forced.
 *
 * `AuditDbPool` is a thin Nest-aware wrapper that owns the pool's
 * lifecycle: it implements `OnModuleDestroy` and calls `pool.end()`
 * exactly once on shutdown. The `AUDIT_DB` provider injects the
 * wrapper, reads `wrapper.pool`, and never sees the raw `Pool`
 * factory output.
 *
 * WORKER_FACTORY rule (existing, unchanged)
 * -----------------------------------------
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throws at boot.
 *     Silently consuming nothing while the producer fills the queue
 *     is a safety hazard; we fail loud instead.
 *   - non-production + `REDIS_URL` missing → falls back to
 *     `NoOpWorkerFactory` so dev / CI machines without Redis still
 *     boot. Same fallback policy as `apps/api`'s `AuthModule`.
 *   - `REDIS_URL` set → builds a real `BullMqWorkerFactory` that
 *     constructs `new bullmq.Worker(name, handler, { connection })`.
 *
 * PG_POOL × AUDIT_DB rule (PR-D — consume-without-persist guard)
 * --------------------------------------------------------------
 *   - `NODE_ENV=production` + `DATABASE_URL` missing → throws at boot.
 *   - `REDIS_URL` set + `DATABASE_URL` missing → throws at boot
 *     **regardless of `NODE_ENV`**. A worker that consumes real BullMQ
 *     jobs but cannot persist them would ack-and-drop audit events,
 *     which is strictly worse than not consuming at all.
 *   - non-production + `REDIS_URL` unset + `DATABASE_URL` unset →
 *     `NoOpAuditDbAdapter`. Safe because the worker is also no-op
 *     (`NoOpWorkerFactory`); no jobs flow.
 *   - `DATABASE_URL` set → real `pg.Pool` and `DrizzleAuditDbAdapter`,
 *     regardless of `REDIS_URL` (a worker with DB but no Redis is fine
 *     — it just doesn't consume anything at runtime).
 *
 * The `NoOpAuditDbAdapter` is permitted ONLY when the
 * `WORKER_FACTORY` is also a `NoOpWorkerFactory`. The two factories
 * read `REDIS_URL` and `DATABASE_URL` independently, but the guard
 * above ensures a real Redis worker is never paired with a no-op DB.
 *
 * Tests substitute fakes via `Test.createTestingModule(...)
 * .overrideProvider(...)`. No Redis, no BullMQ runtime, no Postgres,
 * no provider SDK is loaded under test.
 *
 * What is NOT in this module
 * --------------------------
 *   - Retry / backoff / DLQ defaults — T092 (queue.config.ts).
 *   - Session-revoke worker — T302.
 *   - OTel propagation from API → worker — T303.
 *   - Real provider SDK — PQ-1.
 */
import { Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Worker as BullMqWorker, type WorkerOptions } from "bullmq";
import { Pool } from "pg";

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
import { AuditFanoutProcessor, AUDIT_DB, type AuditDbLike } from "./audit/audit-fanout.processor";
import { AuditWorker } from "./audit/audit.worker";
import {
  DrizzleAuditDbAdapter,
  NoOpAuditDbAdapter,
} from "./audit/drizzle-audit-db.adapter";

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

/**
 * Nest-managed wrapper that owns the worker's `pg.Pool` lifecycle.
 *
 * Why this exists
 * ---------------
 * Nest only invokes `onModuleDestroy` on providers whose resolved value
 * is a class instance implementing the hook. A `useFactory` returning a
 * raw `Pool` would be opaque to Nest — `app.close()` would not call
 * `pool.end()`, and the worker process would hang on open Postgres
 * connections under SIGTERM. This wrapper makes pool teardown
 * explicit and Nest-aware.
 *
 * Field semantics
 * ---------------
 * - `pool === null` is the safe non-prod / no-Redis / no-DB path
 *   (paired with `NoOpAuditDbAdapter` downstream). `onModuleDestroy`
 *   is then a no-op.
 * - `pool !== null` is the real DB path. `onModuleDestroy` ends the
 *   pool exactly once; double-destroy is tolerated because we null the
 *   reference before awaiting `pool.end()`.
 *
 * Constructed by `pgPoolProviderFactory()` — never `new`-instantiated
 * directly outside that factory and tests.
 */
@Injectable()
export class AuditDbPool implements OnModuleDestroy {
  private _pool: Pool | null;

  constructor(pool: Pool | null) {
    this._pool = pool;
  }

  /** The underlying pool, or `null` on the safe no-DB path. */
  get pool(): Pool | null {
    return this._pool;
  }

  /**
   * Nest lifecycle hook — fires on `app.close()` from `main.ts`.
   * Idempotent: a second invocation is a no-op because we null the
   * reference before awaiting.
   */
  async onModuleDestroy(): Promise<void> {
    const p = this._pool;
    this._pool = null;
    if (p !== null) {
      await p.end();
    }
  }
}

/**
 * Factory for the `AuditDbPool` provider (PR-D).
 *
 * Implements the DATABASE_URL × REDIS_URL truth table at the module
 * docstring. Returns an `AuditDbPool` whose internal pool is `null`
 * only on the safe path. All other "missing DATABASE_URL" cases throw.
 *
 * Exported so tests can call it directly without booting Nest DI.
 */
export function pgPoolProviderFactory(): AuditDbPool {
  const dbUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];
  const isProd = process.env["NODE_ENV"] === "production";

  if (dbUrl) {
    return new AuditDbPool(new Pool({ connectionString: dbUrl }));
  }

  // dbUrl is missing from here on.
  if (isProd) {
    throw new Error(
      "WorkerModule: DATABASE_URL is required in production " +
        "(audit worker cannot persist events without it).",
    );
  }
  if (redisUrl) {
    throw new Error(
      "WorkerModule: DATABASE_URL is required when REDIS_URL is set " +
        "(consume-without-persist guard: a worker that ingests BullMQ jobs " +
        "but cannot write to the DB would silently drop audit events).",
    );
  }
  // Safe path: no Redis (no consumption) AND no DB. NoOpAuditDbAdapter pairs
  // with NoOpWorkerFactory; no audit events flow.
  return new AuditDbPool(null);
}

/**
 * Factory for the `AUDIT_DB` provider (PR-D).
 *
 * Reads `wrapper.pool`:
 * - non-null → `DrizzleAuditDbAdapter` (real persistence).
 * - null     → `NoOpAuditDbAdapter` (only reachable on the safe
 *              non-prod / no-Redis / no-DB path; the guard in
 *              `pgPoolProviderFactory` rejects every other
 *              missing-DATABASE_URL case).
 *
 * The factory does NOT take ownership of the pool — `AuditDbPool` owns
 * lifecycle. The adapter holds a reference for query-time use; teardown
 * is on the wrapper, not the adapter.
 */
export function auditDbProviderFactory(wrapper: AuditDbPool): AuditDbLike {
  const pool = wrapper.pool;
  if (pool === null) {
    return new NoOpAuditDbAdapter();
  }
  return new DrizzleAuditDbAdapter(pool);
}

/** DI token for the `AuditDbPool` Nest-managed wrapper. */
export const PG_POOL = "PG_POOL";

@Module({
  providers: [
    // ── Email pipeline (existing) ─────────────────────────────────────
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

    // ── Audit pipeline (PR-D) ─────────────────────────────────────────
    //
    // AuditDbPool is registered as a CLASS-token provider so Nest tracks
    // it for lifecycle hooks. The string token PG_POOL aliases the same
    // instance via useExisting, preserving a stable injection identifier
    // for the AUDIT_DB factory. A useFactory keyed on a string token
    // alone does NOT reliably receive `onModuleDestroy` calls — class
    // tokens do.
    {
      provide: AuditDbPool,
      useFactory: pgPoolProviderFactory,
    },
    {
      provide: PG_POOL,
      useExisting: AuditDbPool,
    },
    {
      provide: AUDIT_DB,
      useFactory: auditDbProviderFactory,
      inject: [AuditDbPool],
    },
    AuditFanoutProcessor,
    AuditWorker,
  ],
  exports: [EmailWorker, EmailProcessor, AuditWorker, AuditFanoutProcessor],
})
export class WorkerModule {}
