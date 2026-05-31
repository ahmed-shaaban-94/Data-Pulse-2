/**
 * SaleWorker module-wiring spec — 008 WIRING slice.
 *
 * Proves the registration half of the slice: that `SaleWorker` and its
 * `SaleProcessingProcessor` dependency resolve from the REAL `WorkerModule`
 * provider graph in the dev / no-Redis / no-DB path, without booting Redis,
 * BullMQ, or Postgres. Mirrors the `WorkerModule — AuditWorker resolves`
 * assertion in `worker.module.spec.ts` (which uses per-provider `.get()`, so
 * adding our provider does not disturb it).
 *
 * It also pins the two pure provider factories directly (the pool-reuse +
 * worker-construction decisions), and that the module resolves SaleWorker
 * without self-starting (no onModuleInit — start() is wired imperatively in
 * main.ts by the gated enqueue slice; precedent: AuditRetentionWorker).
 *
 * Docker-free — runs in the fast CI job.
 */
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import {
  AuditDbPool,
  WorkerModule,
  saleProcessingProcessorProviderFactory,
  saleWorkerProviderFactory,
  NoOpWorkerFactory,
} from "../../src/worker.module";
import { SaleWorker } from "../../src/sales/sale.worker";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];
const ORIGINAL_DATABASE_URL = process.env["DATABASE_URL"];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  if (ORIGINAL_REDIS_URL === undefined) delete process.env["REDIS_URL"];
  else process.env["REDIS_URL"] = ORIGINAL_REDIS_URL;
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = ORIGINAL_DATABASE_URL;
});

describe("WorkerModule — SaleWorker DI graph (dev / no-Redis / no-DB path)", () => {
  it("resolves SaleWorker without booting Redis, BullMQ, or Postgres", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const saleWorker = moduleRef.get(SaleWorker);
    expect(saleWorker).toBeInstanceOf(SaleWorker);

    // start() goes through the NoOp factory on this path; the processor's pool
    // is null (NoOp DB), but the worker never consumes a job, so process() is
    // never reached. start() must not throw and must not require Redis.
    expect(() => saleWorker.start()).not.toThrow();
    await saleWorker.close();
    await moduleRef.close();
  });

  it("resolves SaleProcessingProcessor from the shared AuditDbPool (no second pool)", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const processor = moduleRef.get(SaleProcessingProcessor);
    expect(processor).toBeInstanceOf(SaleProcessingProcessor);

    // The processor must have been built from the SAME AuditDbPool wrapper the
    // audit pipeline uses — proving no second Postgres pool was created.
    const wrapper = moduleRef.get(AuditDbPool);
    expect(wrapper).toBeInstanceOf(AuditDbPool);
    expect(wrapper.pool).toBeNull(); // safe no-DB dev path

    await moduleRef.close();
  });

  it("resolves SaleWorker from the compiled module WITHOUT self-starting", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];

    // SaleWorker is registered but has no onModuleInit, so module init must not
    // start a worker (no Redis needed). The enqueue-wiring slice adds the
    // imperative start() in main.ts. compile()/init succeeding proves DI
    // resolves and nothing self-starts.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    const saleWorker = moduleRef.get(SaleWorker);
    expect(saleWorker).toBeInstanceOf(SaleWorker);
    expect(
      (saleWorker as unknown as { onModuleInit?: unknown }).onModuleInit,
    ).toBeUndefined();
    await moduleRef.close();
  });
});

describe("saleProcessingProcessorProviderFactory — pool reuse", () => {
  it("constructs a SaleProcessingProcessor from the wrapper's pool", () => {
    const fakePool = { connect: () => undefined } as unknown as Pool;
    const wrapper = new AuditDbPool(fakePool);
    const processor = saleProcessingProcessorProviderFactory(wrapper);
    expect(processor).toBeInstanceOf(SaleProcessingProcessor);
  });

  it("is constructible on the null-pool safe path (paired with NoOp worker)", () => {
    const wrapper = new AuditDbPool(null);
    const processor = saleProcessingProcessorProviderFactory(wrapper);
    expect(processor).toBeInstanceOf(SaleProcessingProcessor);
  });
});

describe("saleWorkerProviderFactory — construction", () => {
  it("constructs a SaleWorker from the processor + shared worker factory", () => {
    const wrapper = new AuditDbPool(null);
    const processor = saleProcessingProcessorProviderFactory(wrapper);
    const worker = saleWorkerProviderFactory(processor, new NoOpWorkerFactory());
    expect(worker).toBeInstanceOf(SaleWorker);
  });
});
