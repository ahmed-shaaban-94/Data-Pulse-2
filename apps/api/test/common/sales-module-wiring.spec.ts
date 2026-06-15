/**
 * SalesModule DI wiring regression — guards the PosOperatorEnvelopeSaleGuard
 * bootstrap crash. The guard is consumed via @UseGuards(...) by class, so Nest
 * instantiates it from reflected constructor metadata; its deps had been imported
 * with `import type` (erased at compile -> design:paramtypes emits undefined),
 * so AppModule failed to bootstrap. The sibling module-wiring.spec.ts never
 * imported SalesModule, letting this class of bug ship green.
 *
 * Hermetic: PG_POOL overridden with a fake (no Testcontainers, no DB, no network),
 * matching module-wiring.spec.ts so the DI assertion does not depend on DATABASE_URL.
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";

import { PG_POOL } from "../../src/auth/auth.module";
import { SalesModule } from "../../src/catalog/sales/sales.module";

const fakePool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };

describe("SalesModule DI graph", () => {
  it("compiles without unresolved dependencies (covers PosOperatorEnvelopeSaleGuard)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SalesModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
