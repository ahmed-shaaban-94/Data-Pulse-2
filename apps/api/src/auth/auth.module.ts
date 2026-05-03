/**
 * AuthModule — slice 3c.
 *
 * Wires AuthController and its dependency graph:
 *
 *   AuthController
 *     ├─ AuthService
 *     │    ├─ Pool          (PG_POOL token)
 *     │    ├─ SessionRepository
 *     │    ├─ AuthTokenRepository
 *     │    └─ EmailJobEnqueuer (NoOpEmailJobEnqueuer until T112/T113)
 *     ├─ AuthGuard
 *     │    ├─ SessionRepository
 *     │    └─ AuthTokenRepository
 *     └─ RateLimiter
 *          └─ RedisLike      (REDIS_CLIENT — see notes below)
 *
 * Production wiring per slice (current state):
 *
 *   - REDIS_CLIENT — still defaults to `AlwaysAllowRedis`, an in-process
 *     stub whose `incr` always returns 1; rate limits NEVER trigger
 *     until a later slice provides an ioredis-backed implementation.
 *     The class name is deliberately blunt so anyone reading the wiring
 *     graph in code review will catch that production needs an override.
 *
 *   - EMAIL_JOB_ENQUEUER — slice 4 (T112/T113) wires the BullMQ-backed
 *     `EmailQueueProducer` when `REDIS_URL` is set. In production with
 *     `REDIS_URL` missing the factory throws (silently swallowing
 *     password-reset / email-verify jobs is a safety hazard); in dev /
 *     test it falls back to `NoOpEmailJobEnqueuer` so machines without
 *     Redis still boot. The matching email worker / processor lives in
 *     `apps/worker` and lands in T114/T115.
 *
 * Tests substitute working fakes for both seams via
 * `Test.createTestingModule(...).overrideProvider(...)`.
 */
import { Module } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { Pool } from "pg";

import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  EMAIL_JOB_ENQUEUER,
  type EmailJobEnqueuer,
  NoOpEmailJobEnqueuer,
} from "./email-job.enqueuer";
import { EmailQueueProducer } from "./email-queue.producer";
import { RateLimiter, type RedisLike } from "./rate-limit";
import { SessionRepository } from "./session.repository";

/** Name of the BullMQ queue both the producer and the (future) worker bind to. */
export const EMAIL_QUEUE_NAME = "email";

export const PG_POOL = "PG_POOL";
export const REDIS_CLIENT = "REDIS_CLIENT";

/**
 * Factory for the `EMAIL_JOB_ENQUEUER` provider. Extracted so a
 * focused unit test can verify the BullMQ `Queue` is constructed with
 * `defaultJobOptions: DEFAULT_JOB_OPTIONS` (T301-partial wiring),
 * mirroring the symmetric extraction `workerFactoryProviderFactory`
 * on the worker side.
 *
 * Production wiring policy:
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throw at boot.
 *     Silently dropping password-reset / email-verify jobs is a
 *     safety hazard.
 *   - non-production + `REDIS_URL` missing → fall back to
 *     `NoOpEmailJobEnqueuer` so dev / CI machines without Redis still
 *     boot.
 *   - `REDIS_URL` set → build a `Queue` with the shared default job
 *     options (single source of truth in `@data-pulse-2/shared`).
 */
export function emailJobEnqueuerFactory(): EmailJobEnqueuer {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: REDIS_URL is required in production " +
          "(EmailQueueProducer cannot be wired without it).",
      );
    }
    return new NoOpEmailJobEnqueuer();
  }
  const queue = new Queue(EMAIL_QUEUE_NAME, {
    connection: { url },
    defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
  });
  return new EmailQueueProducer(queue);
}

/**
 * Stub Redis used until a real client is wired. Every `incr` returns 1
 * so rate-limit decisions always come back "allowed". Production MUST
 * override this provider; the class name is intentionally loud.
 */
class AlwaysAllowRedis implements RedisLike {
  async incr(_key: string): Promise<number> {
    return 1;
  }
  async pexpireNx(_key: string, _ttlMs: number): Promise<number> {
    return 1;
  }
  async pttl(_key: string): Promise<number> {
    return -1;
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => {
        const url = process.env["DATABASE_URL"];
        if (!url) {
          throw new Error(
            "AuthModule: DATABASE_URL is not set; cannot create pg.Pool",
          );
        }
        return new Pool({ connectionString: url });
      },
    },
    {
      provide: REDIS_CLIENT,
      useFactory: (): RedisLike => new AlwaysAllowRedis(),
    },
    {
      provide: EMAIL_JOB_ENQUEUER,
      useFactory: emailJobEnqueuerFactory,
    },
    {
      provide: SessionRepository,
      useFactory: (pool: Pool): SessionRepository => new SessionRepository(pool),
      inject: [PG_POOL],
    },
    {
      provide: AuthTokenRepository,
      useFactory: (pool: Pool): AuthTokenRepository =>
        new AuthTokenRepository(pool),
      inject: [PG_POOL],
    },
    {
      provide: RateLimiter,
      useFactory: (redis: RedisLike): RateLimiter => new RateLimiter(redis),
      inject: [REDIS_CLIENT],
    },
    AuthGuard,
    {
      provide: AuthService,
      useFactory: (
        pool: Pool,
        sessions: SessionRepository,
        authTokens: AuthTokenRepository,
        emailJobs: EmailJobEnqueuer,
      ): AuthService => new AuthService(pool, sessions, authTokens, emailJobs),
      inject: [PG_POOL, SessionRepository, AuthTokenRepository, EMAIL_JOB_ENQUEUER],
    },
  ],
  exports: [
    AuthService,
    AuthGuard,
    SessionRepository,
    AuthTokenRepository,
    // PG_POOL is exported so downstream modules (ContextModule, future
    // tenant/store modules) can share the single connection pool
    // rather than provisioning their own.
    PG_POOL,
  ],
})
export class AuthModule {}
