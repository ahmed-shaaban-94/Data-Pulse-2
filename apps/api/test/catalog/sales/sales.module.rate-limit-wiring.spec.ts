/**
 * sales.module.rate-limit-wiring.spec.ts — ADR 0009 W2.
 *
 * DI-resolution proof for PosWriteRateLimitGuard in SalesModule's scope. A direct
 * `new PosWriteRateLimitGuard(...)` unit test cannot catch a boot-time resolution
 * failure (it bypasses DI); only compiling the real module and resolving the guard
 * does. This pins that:
 *   - the guard is a registered provider in SalesModule, and
 *   - its deps (RateLimiter exported from AuthModule + OPERATOR_CONTEXT_RESOLVER +
 *     @Optional ROOT_LOGGER) all resolve in that module's graph.
 *
 * PG_POOL is overridden with an unused stub so the module compiles without a DB
 * (mirrors audit.module.spec) — none of these providers touch the pool at resolve
 * time.
 */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { PG_POOL } from "../../../src/auth/auth.module";
import { SalesModule } from "../../../src/catalog/sales/sales.module";
import { PosWriteRateLimitGuard } from "../../../src/auth/pos-write-rate-limit.guard";

describe("SalesModule — PosWriteRateLimitGuard DI resolution (ADR 0009 W2)", () => {
  it("resolves PosWriteRateLimitGuard from the compiled module graph", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SalesModule],
    })
      .overrideProvider(PG_POOL)
      .useValue({} as Pool)
      .compile();

    const guard = moduleRef.get(PosWriteRateLimitGuard, { strict: false });
    expect(guard).toBeInstanceOf(PosWriteRateLimitGuard);
    await moduleRef.close();
  });
});
