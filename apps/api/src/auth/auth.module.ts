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
 * Two seams that aren't real yet:
 *
 *   - REDIS_CLIENT defaults to `AlwaysAllowRedis`, an in-process stub
 *     whose `incr` always returns 1 — i.e. rate limits NEVER trigger
 *     until a later slice provides an ioredis-backed implementation.
 *     The class name is deliberately blunt so anyone reading the wiring
 *     graph in code review will catch that production needs an override.
 *
 *   - EMAIL_JOB_ENQUEUER defaults to `NoOpEmailJobEnqueuer`. T112/T113
 *     replaces it with a BullMQ producer.
 *
 * Tests substitute working fakes for both via
 * `Test.createTestingModule(...).overrideProvider(...)`.
 */
import { Module } from "@nestjs/common";
import { Pool } from "pg";

import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { AuthTokenRepository } from "./auth-token.repository";
import {
  EMAIL_JOB_ENQUEUER,
  type EmailJobEnqueuer,
  NoOpEmailJobEnqueuer,
} from "./email-job.enqueuer";
import { RateLimiter, type RedisLike } from "./rate-limit";
import { SessionRepository } from "./session.repository";

export const PG_POOL = "PG_POOL";
export const REDIS_CLIENT = "REDIS_CLIENT";

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
      useClass: NoOpEmailJobEnqueuer,
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
  exports: [AuthService, AuthGuard, SessionRepository, AuthTokenRepository],
})
export class AuthModule {}
