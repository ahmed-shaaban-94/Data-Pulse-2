/**
 * SaleWorker spec — 008 WIRING slice.
 *
 * Pure unit-level. Mirrors `audit.worker.spec.ts`. Collaborators:
 *   - `SaleProcessingProcessor` (faked — we check the registered BullMQ
 *     handler delegates the ENVELOPE to `process(job.data)` and discards the
 *     result),
 *   - `WorkerFactory` (faked — captures the registered handler + options and
 *     produces a `FakeWorker` whose `close()` we observe).
 *
 * No real BullMQ runtime, no Redis, no Postgres — Docker-free, so this suite
 * runs in the fast CI job and is NOT added to `jest.config.cjs`'s Docker
 * exclusion list. The end-to-end tenant-context / idempotency proofs live in
 * the Testcontainers `processing.spec.ts` / `idempotent-processing.spec.ts`;
 * this spec proves the WIRING (delegation, queue name, lifecycle, self-start).
 *
 * Coverage:
 *   - registers a handler against queue name `"sale-processing"`
 *   - `SALE_PROCESSING_QUEUE_NAME` is the literal `"sale-processing"`
 *   - the handler forwards `job.data` (the envelope) to
 *     `SaleProcessingProcessor.process` and discards the result
 *   - subscribes to the `"error"` event for diagnostic logging
 *   - error events write a single JSON line to stderr with
 *     `component: "sale.worker"` (no PII)
 *   - propagates handler errors so BullMQ can retry
 *   - `start()` is idempotent; `close()` before start / twice is tolerated
 *   - `onModuleDestroy` invokes `close()`
 *   - `onModuleInit` self-starts the worker (the divergence from AuditWorker)
 */
import {
  SALE_PROCESSING_QUEUE_NAME,
  SaleWorker,
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
} from "../../src/sales/sale.worker";
import {
  SaleProcessingProcessor,
  type SaleProcessingJob,
  type SaleProcessingResult,
} from "../../src/sales/sale-processing.processor";
import {
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

class FakeWorker implements WorkerLike {
  errorListeners: Array<(err: Error) => void> = [];
  closed = 0;
  on(event: "error", listener: (err: Error) => void): unknown {
    if (event === "error") this.errorListeners.push(listener);
    return this;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

class FakeWorkerFactory implements WorkerFactory {
  calls: Array<{
    queueName: string;
    handler: (job: JobLike) => Promise<void>;
    options: DefaultWorkerOptionsShape;
  }> = [];
  workers: FakeWorker[] = [];
  create(
    queueName: string,
    handler: (job: JobLike) => Promise<void>,
    options: DefaultWorkerOptionsShape,
  ): WorkerLike {
    this.calls.push({ queueName, handler, options });
    const w = new FakeWorker();
    this.workers.push(w);
    return w;
  }
}

/** Matches the processor's envelope→result shape (NOT audit's (name,data)). */
class FakeProcessor {
  calls: SaleProcessingJob[] = [];
  reject?: Error;
  async process(job: SaleProcessingJob): Promise<SaleProcessingResult> {
    this.calls.push(job);
    if (this.reject) throw this.reject;
    return {
      saleId: job.saleId,
      mismatchFlag: false,
      processedAt: "2026-05-31T00:00:00.000Z",
      applied: true,
    };
  }
}

const ENVELOPE: SaleProcessingJob = {
  saleId: "5a1e0000-0000-7000-8000-0000000000d1",
  tenantId: "5a1e0000-0000-7000-8000-0000000000a1",
  storeId: "5a1e0000-0000-7000-8000-0000000000b1",
  correlationId: "corr-1",
};

let factory: FakeWorkerFactory;
let processor: FakeProcessor;
let worker: SaleWorker;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  factory = new FakeWorkerFactory();
  processor = new FakeProcessor();
  // SaleWorker only needs the `process` method on its processor arg.
  worker = new SaleWorker(
    processor as unknown as SaleProcessingProcessor,
    factory,
  );
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("SaleWorker.start — queue-name", () => {
  it("registers a worker against the 'sale-processing' queue", () => {
    worker.start();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe("sale-processing");
    expect(factory.calls[0]!.queueName).toBe(SALE_PROCESSING_QUEUE_NAME);
  });

  it("forwards DEFAULT_WORKER_OPTIONS from @data-pulse-2/shared to the factory", () => {
    worker.start();
    expect(factory.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
  });

  it("forwards exactly the shared concurrency / lock / stalled defaults", () => {
    worker.start();
    const opts = factory.calls[0]!.options;
    expect(opts.concurrency).toBe(DEFAULT_WORKER_OPTIONS.concurrency);
    expect(opts.lockDuration).toBe(DEFAULT_WORKER_OPTIONS.lockDuration);
    expect(opts.stalledInterval).toBe(DEFAULT_WORKER_OPTIONS.stalledInterval);
    expect(opts.maxStalledCount).toBe(DEFAULT_WORKER_OPTIONS.maxStalledCount);
  });
});

describe("SaleWorker.start — handler delegation", () => {
  it("forwards job.data (the envelope) to SaleProcessingProcessor.process", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    await handler({ name: "sale-processing", data: ENVELOPE });
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]).toEqual(ENVELOPE);
  });

  it("discards the processor result — handler resolves to void", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    await expect(
      handler({ name: "sale-processing", data: ENVELOPE }),
    ).resolves.toBeUndefined();
  });

  it("propagates handler errors so BullMQ can retry / DLQ", async () => {
    processor.reject = new Error("transient db error");
    worker.start();
    const handler = factory.calls[0]!.handler;
    await expect(
      handler({ name: "sale-processing", data: ENVELOPE }),
    ).rejects.toThrow("transient db error");
  });
});

describe("SaleWorker.start — error logging", () => {
  it("subscribes to the 'error' event for diagnostic logging", () => {
    worker.start();
    expect(factory.workers[0]!.errorListeners).toHaveLength(1);
  });

  it("writes a single structured JSON line to stderr on error events with component 'sale.worker'", () => {
    worker.start();
    factory.workers[0]!.emitError(new Error("redis ECONNREFUSED"));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(written.trim()) as Record<string, string>;
    expect(parsed["level"]).toBe("error");
    expect(parsed["component"]).toBe("sale.worker");
    expect(parsed["message"]).toBe("redis ECONNREFUSED");
  });

  it("error log carries NO sale row / amounts / payload (FR-042 / FR-092)", () => {
    worker.start();
    factory.workers[0]!.emitError(new Error("boom"));
    const written = String(stderrSpy.mock.calls[0]![0]);
    for (const forbidden of ["pos_total", "line_amount", "payload", "saleId", "sale_id"]) {
      expect(written).not.toContain(forbidden);
    }
  });
});

describe("SaleWorker.start — idempotency", () => {
  it("is idempotent — second start is a no-op", () => {
    worker.start();
    worker.start();
    expect(factory.calls).toHaveLength(1);
  });
});

describe("SaleWorker.close", () => {
  it("closes the underlying worker after start", async () => {
    worker.start();
    await worker.close();
    expect(factory.workers[0]!.closed).toBe(1);
  });

  it("is tolerated before start (no underlying worker yet)", async () => {
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it("is idempotent — second close does not re-close the underlying worker", async () => {
    worker.start();
    await worker.close();
    await worker.close();
    expect(factory.workers[0]!.closed).toBe(1);
  });

  it("onModuleDestroy invokes close()", async () => {
    worker.start();
    await worker.onModuleDestroy();
    expect(factory.workers[0]!.closed).toBe(1);
  });
});

describe("SaleWorker.onModuleInit — self-start (divergence from AuditWorker)", () => {
  it("starts the worker on module init (registration alone would never consume)", () => {
    worker.onModuleInit();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe(SALE_PROCESSING_QUEUE_NAME);
  });

  it("does not double-start when onModuleInit then start() are both called", () => {
    worker.onModuleInit();
    worker.start();
    expect(factory.calls).toHaveLength(1);
  });
});

describe("SALE_PROCESSING_QUEUE_NAME — defined literal (no producer to pin yet)", () => {
  it("is the literal 'sale-processing'", () => {
    expect(SALE_PROCESSING_QUEUE_NAME).toBe("sale-processing");
  });
});
