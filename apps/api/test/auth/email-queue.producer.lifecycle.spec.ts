/**
 * email-queue.producer.lifecycle.spec.ts
 *
 * Pins `EmailQueueProducer`'s Nest `OnModuleDestroy` lifecycle contract.
 * Mirror of `audit-queue.producer.lifecycle.spec.ts`; see that file's
 * header docstring for the full rationale.
 *
 * Coverage:
 *   1. onModuleDestroy() -> queue.close() exactly once.
 *   2. Second onModuleDestroy() is a no-op.
 *   3. Queue without close() (test doubles) is tolerated.
 *   4. Errors from close() are swallowed.
 *   5. Nest moduleRef.close() reaches the hook in the DI container.
 *
 * No bullmq runtime, no ioredis. The producer accepts `Queue | QueueLike`
 * and we exercise both shapes via tiny hand-written doubles.
 */
import { Test } from "@nestjs/testing";
import {
  EmailQueueProducer,
  type QueueLike,
} from "../../src/auth/email-queue.producer";

// ---------------------------------------------------------------------------
// Hand-written doubles
// ---------------------------------------------------------------------------

class FakeQueueWithClose implements QueueLike {
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

class FakeQueueNoClose implements QueueLike {
  async add(): Promise<unknown> {
    return {};
  }
}

class FakeQueueCloseThrows implements QueueLike {
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

describe("EmailQueueProducer.onModuleDestroy", () => {
  it("calls queue.close() exactly once when the underlying queue exposes it", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(queue);
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("is idempotent: a second onModuleDestroy() does not re-close", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new EmailQueueProducer(queue);
    await producer.onModuleDestroy();
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("tolerates a queue without close() (in-memory test doubles)", async () => {
    const queue = new FakeQueueNoClose();
    const producer = new EmailQueueProducer(queue);
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("swallows errors from queue.close() (best-effort shutdown)", async () => {
    const queue = new FakeQueueCloseThrows();
    const producer = new EmailQueueProducer(queue);
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
    expect(queue.closeAttempts).toBe(1);
  });

  it("Nest moduleRef.close() invokes the producer's onModuleDestroy which calls queue.close()", async () => {
    const queue = new FakeQueueWithClose();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: "EMAIL_QUEUE", useValue: queue },
        {
          provide: EmailQueueProducer,
          useFactory: (q: QueueLike) => new EmailQueueProducer(q),
          inject: ["EMAIL_QUEUE"],
        },
      ],
    }).compile();

    const producer = moduleRef.get(EmailQueueProducer);
    expect(producer).toBeInstanceOf(EmailQueueProducer);

    await moduleRef.close();

    expect(queue.closeCalls).toBe(1);
  });
});
