/**
 * module-boot.spec.ts — 035 T030 (DI graph, infra-free).
 *
 * Proves the REAL `SettlementModule` provider graph resolves — in particular
 * the `PosOperatorEnvelopeSaleGuard` factory wiring (SessionRepository +
 * AuthTokenRepository + the OPERATOR_CONTEXT_RESOLVER reverifier). This is the
 * exact class of failure that crashed boot in `48f954f` ("import type erased
 * metadata"); tsc + a guard-overridden integration test cannot see it because
 * they never instantiate the real module.
 *
 * `.compile()` instantiates every factory provider. AuthModule's PG_POOL
 * factory requires DATABASE_URL to construct a `pg.Pool` — but `new Pool(...)`
 * is lazy (it opens no socket until the first query), so a dummy URL is enough
 * to exercise the full real graph without a live DB. REDIS_CLIENT falls back to
 * the no-op stub when REDIS_URL is unset. This is a pure dependency-injection
 * assertion — no container, no connection.
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";

// pg.Pool construction is lazy; a dummy URL lets AuthModule's factory build the
// pool without connecting. Set BEFORE the module is compiled.
process.env["DATABASE_URL"] ??=
  "postgres://boot:boot@127.0.0.1:5432/settlement_boot_check";

import { PosOperatorEnvelopeSaleGuard } from "../../../src/auth/pos-operator-envelope-sale.guard";
import { ReceivableService } from "../../../src/settlement/receivable.service";
import { SettlementController } from "../../../src/settlement/settlement.controller";
import { SettlementModule } from "../../../src/settlement/settlement.module";

describe("035 T030 — SettlementModule DI graph", () => {
  it("compiles the real module + resolves the envelope guard + service", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SettlementModule],
    }).compile();

    // The high-risk component: the operator-envelope guard's factory graph
    // (the 48f954f boot-crash surface) must resolve.
    expect(moduleRef.get(PosOperatorEnvelopeSaleGuard, { strict: false })).toBeInstanceOf(
      PosOperatorEnvelopeSaleGuard,
    );
    expect(moduleRef.get(ReceivableService, { strict: false })).toBeInstanceOf(
      ReceivableService,
    );
    expect(moduleRef.get(SettlementController, { strict: false })).toBeInstanceOf(
      SettlementController,
    );

    await moduleRef.close();
  });
});
