/**
 * audit-queue.producer.lifecycle.spec.ts
 *
 * Pins `AuditQueueProducer`'s Nest `OnModuleDestroy` lifecycle contract:
 *
 *   1. onModuleDestroy() calls the underlying queue.close() exactly once.
 *   2. A second onModuleDestroy() call is a no-op (idempotency guard).
 *   3. A queue without a close() method (in-memory test doubles) is
 *      tolerated -- no throw.
 *   4. Errors from queue.close() are swallowed (best-effort shutdown).
 *   5. Booting the producer through Nest's Test.createTestingModule and
 *      calling moduleRef.close() invokes the producer's
 *      onModuleDestroy AND the underlying queue.close().
 *
 * Why this spec exists -- defence against the CI leak symptom
 * -----------------------------------------------------------
 * Before this hook, the BullMQ Queue's background ioredis client
 * survived Nest's `app.close()`. Jest then reported "worker process
 * has failed to exit gracefully" at suite teardown, which CI flipped
 * from warning to exit-1 once the cumulative leak count crossed a
 * threshold (PR #240 db-integration). The hook is the architecturally
 * correct fix; this spec pins it so a future refactor that removes
 * the hook fails LOUDLY.
 *
 * No bullmq runtime, no ioredis. The producer accepts `Queue | AuditQueueLike`
 * and we exercise both shapes via tiny hand-written doubles.
 */
import { Test } from "@nestjs/testing";
import {
  AuditQueueProducer,
  type AuditQueueLike,
} from "../../src/audit/audit-queue.producer";

// ---------------------------------------------------------------------------
// Hand-written doubles
// ---------------------------------------------------------------------------

class FakeQueueWithClose implements AuditQueueLike {
  addCalls = 0;
  closeCalls = 0;
  async add(): Promise<unknown> {
    this.addCalls += 1;
    return {};
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeQueueNoClose implements AuditQueueLike {
  async add(): Promise<unknown> {
    return {};
  }
  // Intentionally NO close() -- exercises the optional-method branch.
}

class FakeQueueCloseThrows implements AuditQueueLike {
  closeAttempts = 0;
  async add(): Promise<unknown> {
    return {};
  }
  async close(): Promise<void> {
    this.closeAttempts += 1;
    throw new Error("close failed (simulated)");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditQueueProducer.onModuleDestroy", () => {
  it("calls queue.close() exactly once when the underlying queue exposes it", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(queue);
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("is idempotent: a second onModuleDestroy() does not re-close", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(queue);
    await producer.onModuleDestroy();
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("tolerates a queue without close() (in-memory test doubles)", async () => {
    const queue = new FakeQueueNoClose();
    const producer = new AuditQueueProducer(queue);
    // Must not throw.
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("swallows errors from queue.close() (best-effort shutdown)", async () => {
    const queue = new FakeQueueCloseThrows();
    const producer = new AuditQueueProducer(queue);
    // Must not throw despite the underlying close() throwing.
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
    expect(queue.closeAttempts).toBe(1);
  });

  it("Nest moduleRef.close() invokes the producer's onModuleDestroy which calls queue.close()", async () => {
    const queue = new FakeQueueWithClose();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: "AUDIT_QUEUE", useValue: queue },
        {
          provide: AuditQueueProducer,
          useFactory: (q: AuditQueueLike) => new AuditQueueProducer(q),
          inject: ["AUDIT_QUEUE"],
        },
      ],
    }).compile();

    // Resolve so the provider is constructed.
    const producer = moduleRef.get(AuditQueueProducer);
    expect(producer).toBeInstanceOf(AuditQueueProducer);

    // Nest's container teardown should reach onModuleDestroy.
    await moduleRef.close();

    expect(queue.closeCalls).toBe(1);
  });
});
