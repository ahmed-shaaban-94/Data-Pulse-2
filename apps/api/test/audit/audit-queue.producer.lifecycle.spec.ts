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

// ---------------------------------------------------------------------------
// Lazy-init mode -- the override-orphan leak fix
// ---------------------------------------------------------------------------
//
// The production `auditJobEnqueuerFactory` now returns a producer in LAZY
// mode -- it accepts a `() => Queue` thunk instead of an eager Queue.
// This shifts BullMQ Queue construction from Nest module-init time to
// first `enqueue()`. The test cases below pin:
//
//   L-1: lazy producer does NOT call the provider thunk at construction.
//   L-2: first `enqueue()` invokes the thunk exactly once.
//   L-3: second `enqueue()` reuses the materialised queue (no re-build).
//   L-4: onModuleDestroy on a never-enqueued producer is a clean no-op
//        (the leak fix -- nothing to close because nothing was built).
//   L-5: onModuleDestroy AFTER an enqueue closes the materialised queue.
//
describe("AuditQueueProducer.lazy mode (override-orphan leak fix)", () => {
  it("L-1: lazy producer does NOT call the provider thunk at construction", () => {
    let calls = 0;
    new AuditQueueProducer(() => {
      calls += 1;
      return new FakeQueueWithClose();
    });
    expect(calls).toBe(0);
  });

  it("L-2: first enqueue() invokes the thunk exactly once", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(() => {
      calls += 1;
      return queue;
    });
    await producer.enqueue({
      actor_user_id: null,
      actor_label: null,
      tenant_id: "00000000-0000-7000-8000-000000000001",
      store_id: null,
      action: "test.lazy",
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: null,
    });
    expect(calls).toBe(1);
    expect(queue.addCalls).toBe(1);
  });

  it("L-3: second enqueue() reuses the materialised queue", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(() => {
      calls += 1;
      return queue;
    });
    const payload = {
      actor_user_id: null,
      actor_label: null,
      tenant_id: "00000000-0000-7000-8000-000000000001",
      store_id: null,
      action: "test.lazy",
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: null,
    };
    await producer.enqueue(payload);
    await producer.enqueue(payload);
    expect(calls).toBe(1);
    expect(queue.addCalls).toBe(2);
  });

  it("L-4: onModuleDestroy on a never-enqueued lazy producer is a clean no-op", async () => {
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(() => {
      calls += 1;
      return queue;
    });
    // Crucial: enqueue was NEVER called. The producer was effectively
    // orphaned (this is exactly what happens when overrideProvider replaces
    // the binding before any code path used the original).
    await expect(producer.onModuleDestroy()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(queue.closeCalls).toBe(0);
  });

  it("L-5: onModuleDestroy AFTER enqueue closes the materialised queue", async () => {
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(() => queue);
    await producer.enqueue({
      actor_user_id: null,
      actor_label: null,
      tenant_id: "00000000-0000-7000-8000-000000000001",
      store_id: null,
      action: "test.lazy",
      target_type: null,
      target_id: null,
      request_id: null,
      metadata: null,
    });
    await producer.onModuleDestroy();
    expect(queue.closeCalls).toBe(1);
  });

  it("L-6: enqueue AFTER onModuleDestroy rejects and never materialises the queue", async () => {
    // CodeRabbit review on PR #242: symmetric mirror of the L-6 case
    // in email-queue.producer.lifecycle.spec.ts. The old
    // `this.queue ?? (this.queue = this.queueProvider!())` would let
    // a late audit emission invoke the thunk on a destroyed producer
    // and build a fresh BullMQ Queue -- exactly the kind of leak the
    // lazy refactor was supposed to prevent.
    //
    // L-6 pins the no-resurrection guarantee for the audit side:
    //   - the producer is destroyed BEFORE any enqueue,
    //   - the late enqueue rejects with the "is closed" sentinel,
    //   - the provider thunk was NEVER invoked (calls === 0),
    //   - no FakeQueueWithClose was built (closeCalls === 0).
    let calls = 0;
    const queue = new FakeQueueWithClose();
    const producer = new AuditQueueProducer(() => {
      calls += 1;
      return queue;
    });

    await producer.onModuleDestroy();

    await expect(
      producer.enqueue({
        actor_user_id: null,
        actor_label: null,
        tenant_id: "00000000-0000-7000-8000-000000000001",
        store_id: null,
        action: "test.lazy.post-destroy",
        target_type: null,
        target_id: null,
        request_id: null,
        metadata: null,
      }),
    ).rejects.toThrow(/AuditQueueProducer is closed/);
    expect(calls).toBe(0);
    expect(queue.closeCalls).toBe(0);
  });
});
