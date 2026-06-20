/**
 * settlement.module.rate-limit-wiring.spec.ts — ADR 0009 W2.
 *
 * DI-resolution proof for PosWriteRateLimitGuard in SettlementModule's scope
 * (mirror of the SalesModule wiring spec). Pins that the guard + its deps
 * (RateLimiter exported from AuthModule, OPERATOR_CONTEXT_RESOLVER, Reflector,
 * @Optional ROOT_LOGGER) all resolve in the settlement module graph — the boot-
 * time check a direct-construction unit test cannot give.
 */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { PG_POOL } from "../../src/auth/auth.module";
import { SettlementModule } from "../../src/settlement/settlement.module";
import { PosWriteRateLimitGuard } from "../../src/auth/pos-write-rate-limit.guard";

describe("SettlementModule — PosWriteRateLimitGuard DI resolution (ADR 0009 W2)", () => {
  it("resolves PosWriteRateLimitGuard from the compiled module graph", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SettlementModule],
    })
      .overrideProvider(PG_POOL)
      .useValue({} as Pool)
      .compile();

    const guard = moduleRef.get(PosWriteRateLimitGuard, { strict: false });
    expect(guard).toBeInstanceOf(PosWriteRateLimitGuard);
    await moduleRef.close();
  });
});
