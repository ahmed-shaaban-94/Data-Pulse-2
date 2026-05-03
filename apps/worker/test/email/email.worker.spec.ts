/**
 * T090 — EmailWorker spec.
 *
 * Pure unit-level. The collaborators are:
 *   - `EmailProcessor` (faked — we only check that the registered
 *     BullMQ handler delegates to `process(job.name, job.data)`),
 *   - `WorkerFactory` (faked — captures the registered handler and
 *     produces a `FakeWorker` whose `close()` we can observe).
 *
 * No real BullMQ runtime, no Redis, no `ioredis-mock`, no provider SDK.
 *
 * Coverage:
 *   - registers a handler against queue name `"email"`
 *   - dispatches `(job.name, job.data)` to `EmailProcessor.process`
 *   - subscribes to the `"error"` event for diagnostic logging
 *   - error events write a single JSON line to stderr (no PII)
 *   - `start()` is idempotent (second call is a no-op)
 *   - `close()` closes the underlying worker
 *   - `close()` before `start()` is a tolerated no-op
 *   - `close()` is idempotent
 *   - `onModuleDestroy` invokes `close()`
 *   - `EMAIL_QUEUE_NAME` is the literal `"email"` (cross-app contract
 *     pin with `apps/api/src/auth/auth.module.ts`)
 */
import {
  EMAIL_QUEUE_NAME,
  EmailWorker,
  type EmailJobHandler,
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  type WorkerStartOptions,
} from "../../src/email/email.worker";
import { EmailProcessor } from "../../src/email/email.processor";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

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
    handler: EmailJobHandler;
    options: WorkerStartOptions;
  }> = [];
  workers: FakeWorker[] = [];
  create(
    queueName: string,
    handler: EmailJobHandler,
    options: WorkerStartOptions,
  ): WorkerLike {
    this.calls.push({ queueName, handler, options });
    const w = new FakeWorker();
    this.workers.push(w);
    return w;
  }
}

class FakeProcessor {
  calls: Array<{ jobName: string; data: unknown }> = [];
  reject?: Error;
  async process(jobName: string, data: unknown): Promise<void> {
    this.calls.push({ jobName, data });
    if (this.reject) throw this.reject;
  }
}

let factory: FakeWorkerFactory;
let processor: FakeProcessor;
let worker: EmailWorker;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  factory = new FakeWorkerFactory();
  processor = new FakeProcessor();
  // EmailWorker only needs the `process` method on its processor arg
  worker = new EmailWorker(
    processor as unknown as EmailProcessor,
    factory,
  );
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("EmailWorker.start", () => {
  it("registers a worker against the 'email' queue", () => {
    worker.start();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe("email");
    expect(factory.calls[0]!.queueName).toBe(EMAIL_QUEUE_NAME);
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

  it("registers a handler that delegates (job.name, job.data) to EmailProcessor.process", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    const job: JobLike = {
      name: "auth.password-reset",
      data: { email: "x@example.com", rawToken: "tok", userId: "u" },
    };
    await handler(job);
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]).toEqual({
      jobName: "auth.password-reset",
      data: job.data,
    });
  });

  it("propagates handler errors so BullMQ can retry", async () => {
    processor.reject = new Error("boom");
    worker.start();
    const handler = factory.calls[0]!.handler;
    await expect(
      handler({ name: "auth.password-reset", data: {} }),
    ).rejects.toThrow("boom");
  });

  it("subscribes to the 'error' event for diagnostic logging", () => {
    worker.start();
    const fake = factory.workers[0]!;
    expect(fake.errorListeners).toHaveLength(1);
  });

  it("writes a single structured JSON line to stderr on error events", () => {
    worker.start();
    const fake = factory.workers[0]!;
    fake.emitError(new Error("redis ECONNREFUSED"));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(written.trim()) as Record<string, string>;
    expect(parsed["level"]).toBe("error");
    expect(parsed["component"]).toBe("email.worker");
    expect(parsed["message"]).toBe("redis ECONNREFUSED");
  });

  it("is idempotent — second start is a no-op", () => {
    worker.start();
    worker.start();
    expect(factory.calls).toHaveLength(1);
  });
});

describe("EmailWorker.close", () => {
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

describe("EMAIL_QUEUE_NAME — cross-app contract pin", () => {
  // Mirrors `EMAIL_QUEUE_NAME` in `apps/api/src/auth/auth.module.ts`.
  // If either side drifts, this test fails and prompts moving the
  // constant to `packages/shared`.
  it("is the literal 'email'", () => {
    expect(EMAIL_QUEUE_NAME).toBe("email");
  });
});
