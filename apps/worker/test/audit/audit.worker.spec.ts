/**
 * AuditWorker spec — PR-D wiring slice.
 *
 * Pure unit-level. Mirrors `email.worker.spec.ts`. The collaborators are:
 *   - `AuditFanoutProcessor` (faked — we only check that the registered
 *     BullMQ handler delegates to `process(job.name, job.data)`),
 *   - `WorkerFactory` (faked — captures the registered handler and
 *     produces a `FakeWorker` whose `close()` we can observe).
 *
 * No real BullMQ runtime, no Redis, no `ioredis-mock`, no Postgres.
 *
 * Coverage:
 *   - registers a handler against queue name `"audit"` (NOT `"audit-fanout"`)
 *   - `AUDIT_QUEUE_NAME` is the literal `"audit"` (cross-app contract pin
 *     with `apps/api/src/audit/audit-queue.producer.ts`)
 *   - dispatches `(job.name, job.data)` to `AuditFanoutProcessor.process`
 *     verbatim — worker does NOT validate `job.name`
 *   - subscribes to the `"error"` event for diagnostic logging
 *   - error events write a single JSON line to stderr with
 *     `component: "audit.worker"` (no PII)
 *   - `start()` is idempotent (second call is a no-op)
 *   - `close()` closes the underlying worker
 *   - `close()` before `start()` is a tolerated no-op
 *   - `close()` is idempotent
 *   - `onModuleDestroy` invokes `close()`
 */
import {
  AUDIT_QUEUE_NAME,
  AuditWorker,
  type AuditJobHandler,
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
} from "../../src/audit/audit.worker";
import { AuditFanoutProcessor } from "../../src/audit/audit-fanout.processor";
import { DEFAULT_WORKER_OPTIONS, type DefaultWorkerOptionsShape } from "@data-pulse-2/shared/queues/queue-config";

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
    handler: AuditJobHandler;
    options: DefaultWorkerOptionsShape;
  }> = [];
  workers: FakeWorker[] = [];
  create(
    queueName: string,
    handler: AuditJobHandler,
    options: DefaultWorkerOptionsShape,
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
let worker: AuditWorker;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  factory = new FakeWorkerFactory();
  processor = new FakeProcessor();
  // AuditWorker only needs the `process` method on its processor arg
  worker = new AuditWorker(
    processor as unknown as AuditFanoutProcessor,
    factory,
  );
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("AuditWorker.start — queue-name pin", () => {
  it("registers a worker against the 'audit' queue (NOT 'audit-fanout')", () => {
    worker.start();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe("audit");
    expect(factory.calls[0]!.queueName).toBe(AUDIT_QUEUE_NAME);
    // Defensive — the worker MUST NOT be subscribed to the job-name string.
    expect(factory.calls[0]!.queueName).not.toBe("audit-fanout");
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

describe("AuditWorker.start — handler delegation", () => {
  it("delegates (job.name, job.data) to AuditFanoutProcessor.process verbatim", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    const job: JobLike = {
      name: "audit-fanout",
      data: { action: "context.switch.tenant", tenant_id: null },
    };
    await handler(job);
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]).toEqual({
      jobName: "audit-fanout",
      data: job.data,
    });
  });

  it("forwards job.name unchanged — does NOT hardcode 'audit-fanout'", async () => {
    // The worker MUST NOT validate the job name itself; the processor owns
    // that. Forwarding an unknown name reaches the processor, which is then
    // free to throw UnknownAuditJobError. This test pins the seam.
    worker.start();
    const handler = factory.calls[0]!.handler;
    await handler({ name: "audit-other-future", data: {} });
    expect(processor.calls[0]!.jobName).toBe("audit-other-future");
  });

  it("propagates handler errors so BullMQ can retry", async () => {
    processor.reject = new Error("transient db error");
    worker.start();
    const handler = factory.calls[0]!.handler;
    await expect(
      handler({ name: "audit-fanout", data: {} }),
    ).rejects.toThrow("transient db error");
  });
});

describe("AuditWorker.start — error logging", () => {
  it("subscribes to the 'error' event for diagnostic logging", () => {
    worker.start();
    const fake = factory.workers[0]!;
    expect(fake.errorListeners).toHaveLength(1);
  });

  it("writes a single structured JSON line to stderr on error events with component 'audit.worker'", () => {
    worker.start();
    const fake = factory.workers[0]!;
    fake.emitError(new Error("redis ECONNREFUSED"));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(written.trim()) as Record<string, string>;
    expect(parsed["level"]).toBe("error");
    expect(parsed["component"]).toBe("audit.worker");
    expect(parsed["message"]).toBe("redis ECONNREFUSED");
  });
});

describe("AuditWorker.start — idempotency", () => {
  it("is idempotent — second start is a no-op", () => {
    worker.start();
    worker.start();
    expect(factory.calls).toHaveLength(1);
  });
});

describe("AuditWorker.close", () => {
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

describe("AUDIT_QUEUE_NAME — cross-app contract pin", () => {
  // Mirrors `AUDIT_QUEUE_NAME` in
  // `apps/api/src/audit/audit-queue.producer.ts`. If either side drifts,
  // this test fails and prompts moving the constant to `packages/shared`.
  it("is the literal 'audit'", () => {
    expect(AUDIT_QUEUE_NAME).toBe("audit");
  });

  it("is intentionally NOT the same as the job name 'audit-fanout'", () => {
    // One queue can carry many job-name message types over time. This pin
    // prevents anyone from collapsing the two strings during a refactor.
    expect(AUDIT_QUEUE_NAME).not.toBe("audit-fanout");
  });
});
