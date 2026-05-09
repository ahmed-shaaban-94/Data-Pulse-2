/**
 * T303 — OTel trace-context propagation: API → BullMQ payload → worker handler.
 *
 * This spec validates the propagation CONTRACT without any BullMQ runtime,
 * Redis, OTLP endpoint, Testcontainers, or live infrastructure.
 *
 * Architecture under test
 * -----------------------
 *
 *   [Fake Producer]                [BullMQ serialisation]   [Fake Worker]
 *   tracer.startSpan("producer")
 *     → injectTraceContext()       → job.data.traceContext  → extractTraceContext()
 *                                  → JSON.stringify/parse   → context.with(...)
 *                                                           → tracer.startSpan("handler")
 *
 * The "BullMQ serialisation" step is simulated by JSON round-tripping the
 * payload: `JSON.parse(JSON.stringify(payload))`. This mirrors what BullMQ
 * does when it enqueues/dequeues a job — the carrier must survive the
 * serialisation boundary.
 *
 * Key invariant: the handler span's traceId MUST equal the producer span's
 * traceId, proving that the single distributed trace crosses the queue boundary.
 *
 * Why job.data.traceContext (not job opts)?
 * -----------------------------------------
 * The Zod schemas used by EmailProcessor / AuditFanoutProcessor call
 * `schema.safeParse(data)` which STRIPS unknown keys. `traceContext` must
 * therefore be read from `job.data` BEFORE `safeParse` is called. Storing it
 * in `job.data` (rather than `job.opts`) also guarantees it survives the
 * JSON round-trip verbatim, since BullMQ job data is stored as-is in Redis.
 *
 * Production wiring note
 * ----------------------
 * This spec proves the propagation contract with fake Queue/Worker objects.
 * Wiring it into the real EmailQueueProducer and the BullMQ Worker callback
 * is a follow-on slice — the contract is stable and production wiring is
 * mechanical once the helpers are in place.
 */

import {
  injectTraceContext,
  extractTraceContext,
  createTestTracerProvider,
  context,
  trace,
  type TraceCarrier,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a BullMQ job as seen by a Worker process callback. */
interface FakeJob {
  name: string;
  data: {
    traceContext?: TraceCarrier;
    [key: string]: unknown;
  };
}

/** Minimal interface for a fake BullMQ Queue. */
interface FakeQueue {
  add(name: string, data: Record<string, unknown>): FakeJob;
}

// ---------------------------------------------------------------------------
// Fake Queue and Worker factories
// ---------------------------------------------------------------------------

/**
 * Fake BullMQ Queue.
 *
 * `add` injects the active trace context into a plain carrier, appends it
 * to `data.traceContext`, then JSON round-trips the whole payload to simulate
 * what BullMQ does when it serialises the job to Redis and deserialises it
 * on the worker side.
 */
function makeFakeQueue(): FakeQueue {
  return {
    add(name: string, data: Record<string, unknown>): FakeJob {
      const traceContext = injectTraceContext();
      const raw = { name, data: { ...data, traceContext } };
      // Simulate Redis round-trip
      return JSON.parse(JSON.stringify(raw)) as FakeJob;
    },
  };
}

/**
 * Fake BullMQ Worker process function.
 *
 * Extracts trace context from `job.data.traceContext` BEFORE any Zod
 * `safeParse` or business logic, then runs the handler inside
 * `context.with(...)` so spans started inside inherit the producer's trace.
 */
function processFakeJob(
  job: FakeJob,
  handler: () => void,
): void {
  const ctx = extractTraceContext(job.data.traceContext ?? {});
  context.with(ctx, handler);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OTel context propagation: fake Queue.add → fake worker handler", () => {
  let handle: TestTracerHandle;

  beforeEach(() => {
    handle = createTestTracerProvider();
  });

  afterEach(async () => {
    await handle.teardown();
  });

  it("worker-side handler span has the same traceId as the producer span", () => {
    const tracer = trace.getTracer("test-producer");

    // Producer: start a span and call Queue.add inside its context.
    const producerSpan = tracer.startSpan("api.email-queue.add");
    const producerCtx = trace.setSpan(context.active(), producerSpan);

    let job: FakeJob | undefined;
    const queue = makeFakeQueue();
    context.with(producerCtx, () => {
      job = queue.add("auth.password-reset", {
        tenantId: "tenant-01",
        email: "alice@example.com",
      });
    });
    producerSpan.end();

    const producerTraceId = producerSpan.spanContext().traceId;

    // Worker: process the job, starting a handler span inside restored context.
    let handlerSpan: ReturnType<typeof tracer.startSpan> | undefined;
    processFakeJob(job!, () => {
      handlerSpan = tracer.startSpan("worker.email.handler");
      handlerSpan.end();
    });

    const handlerTraceId = handlerSpan!.spanContext().traceId;

    expect(handlerTraceId).toBe(producerTraceId);
  });

  it("handler span is a different span (different spanId) from the producer span", () => {
    const tracer = trace.getTracer("test-producer");
    const producerSpan = tracer.startSpan("api.email-queue.add");
    const producerCtx = trace.setSpan(context.active(), producerSpan);

    let job: FakeJob | undefined;
    const queue = makeFakeQueue();
    context.with(producerCtx, () => {
      job = queue.add("auth.email-verify", { tenantId: "tenant-01" });
    });
    producerSpan.end();

    let handlerSpan: ReturnType<typeof tracer.startSpan> | undefined;
    processFakeJob(job!, () => {
      handlerSpan = tracer.startSpan("worker.email.handler");
      handlerSpan.end();
    });

    expect(handlerSpan!.spanContext().spanId).not.toBe(producerSpan.spanContext().spanId);
  });

  it("traceparent header survives the JSON round-trip (Redis simulation)", () => {
    const tracer = trace.getTracer("test");
    const producerSpan = tracer.startSpan("s");
    const ctx = trace.setSpan(context.active(), producerSpan);

    let job: FakeJob | undefined;
    const queue = makeFakeQueue();
    context.with(ctx, () => {
      job = queue.add("some-job", {});
    });
    producerSpan.end();

    // The carrier must be a plain object with at least a traceparent string.
    expect(job!.data.traceContext).toBeDefined();
    expect(typeof job!.data.traceContext!["traceparent"]).toBe("string");
    expect(job!.data.traceContext!["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
  });

  it("traceContext at job.data.traceContext is present before Zod would strip unknown keys", () => {
    const tracer = trace.getTracer("test");
    const producerSpan = tracer.startSpan("s");
    const ctx = trace.setSpan(context.active(), producerSpan);

    let job: FakeJob | undefined;
    const queue = makeFakeQueue();
    context.with(ctx, () => {
      job = queue.add("auth.password-reset", { userId: "u1", email: "a@b.c" });
    });
    producerSpan.end();

    // Simulate what Zod would do: strip unknown keys from the payload portion.
    // traceContext must still be extractable BEFORE this stripping occurs.
    const restoredCtx = extractTraceContext(job!.data.traceContext ?? {});
    const restoredSpanCtx = trace.getSpanContext(restoredCtx);

    expect(restoredSpanCtx?.traceId).toBe(producerSpan.spanContext().traceId);

    // Only now would production code call safeParse — and traceContext would
    // be stripped. The extraction already happened so that's fine.
    const { traceContext: _discarded, ...businessPayload } = job!.data;
    expect(businessPayload).toEqual({ userId: "u1", email: "a@b.c" });
  });

  it("a job with no traceContext (legacy producer) processes without error", () => {
    // Simulates a job enqueued before propagation was wired — worker must
    // handle missing carrier gracefully and start processing in ROOT_CONTEXT.
    const legacyJob: FakeJob = {
      name: "auth.password-reset",
      data: { userId: "u1" },
    };

    expect(() => {
      processFakeJob(legacyJob, () => {
        // no-op handler — just confirm no throw
      });
    }).not.toThrow();
  });

  it("multiple independent jobs propagate distinct traceIds", () => {
    const tracer = trace.getTracer("test");
    const queue = makeFakeQueue();
    const jobs: FakeJob[] = [];

    for (let i = 0; i < 3; i++) {
      const span = tracer.startSpan(`producer-${i}`);
      context.with(trace.setSpan(context.active(), span), () => {
        jobs.push(queue.add("job", { i }));
      });
      span.end();
    }

    const traceIds = jobs.map((j) => {
      const ctx = extractTraceContext(j.data.traceContext ?? {});
      return trace.getSpanContext(ctx)?.traceId;
    });

    // All three jobs must carry distinct traceIds.
    const uniqueIds = new Set(traceIds);
    expect(uniqueIds.size).toBe(3);
    for (const id of traceIds) {
      expect(id).toBeDefined();
    }
  });
});
