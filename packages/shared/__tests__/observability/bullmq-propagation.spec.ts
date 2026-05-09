/**
 * Unit tests for the BullMQ W3C trace-context propagation helpers.
 *
 * No BullMQ runtime. No Redis. No OTLP endpoint. No Testcontainers.
 *
 * Each test bootstraps an in-memory NodeTracerProvider with the
 * W3CTraceContextPropagator set as the global propagator, exercises
 * `injectTraceContext` / `extractTraceContext`, and tears the provider
 * down before the next test.
 *
 * OTel test utilities are accessed via `@opentelemetry/sdk-node`'s
 * namespace re-exports (`sdk.tracing`, `sdk.core`, `sdk.node`) — no
 * additional packages are required beyond what shared already declares.
 */
import { context, propagation, trace, ROOT_CONTEXT } from "@opentelemetry/api";
import * as sdkNode from "@opentelemetry/sdk-node";

import {
  injectTraceContext,
  extractTraceContext,
  type TraceCarrier,
} from "../../src/observability/bullmq-propagation";

// ---------------------------------------------------------------------------
// Extract test utilities from sdk-node namespace exports.
// These are re-exported from @opentelemetry/sdk-trace-base / sdk-trace-node /
// @opentelemetry/core by sdk-node's index — no extra packages needed.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdkAny = sdkNode as any;
const { InMemorySpanExporter, SimpleSpanProcessor } = sdkAny.tracing as {
  InMemorySpanExporter: new () => { getFinishedSpans(): unknown[]; reset(): void };
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
};
const { W3CTraceContextPropagator } = sdkAny.core as {
  W3CTraceContextPropagator: new () => unknown;
};
const { NodeTracerProvider } = sdkAny.node as {
  NodeTracerProvider: new (opts: { spanProcessors: unknown[] }) => {
    register(opts: { propagator: unknown }): void;
    shutdown(): Promise<void>;
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupProvider() {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return { provider, exporter };
}

async function teardownProvider(
  provider: ReturnType<typeof setupProvider>["provider"],
) {
  await provider.shutdown();
  propagation.disable();
}

// ---------------------------------------------------------------------------
// injectTraceContext
// ---------------------------------------------------------------------------

describe("injectTraceContext", () => {
  let provider: ReturnType<typeof setupProvider>["provider"];

  beforeEach(() => {
    ({ provider } = setupProvider());
  });

  afterEach(async () => {
    await teardownProvider(provider);
  });

  it("writes a traceparent header into the carrier", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("producer");
    const ctx = trace.setSpan(context.active(), span);

    let carrier: TraceCarrier = {};
    context.with(ctx, () => {
      carrier = injectTraceContext();
    });
    span.end();

    expect(carrier["traceparent"]).toBeDefined();
    expect(typeof carrier["traceparent"]).toBe("string");
    expect(carrier["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it("mutates the passed-in carrier object and returns the same reference", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("s");
    const ctx = trace.setSpan(context.active(), span);
    const input: TraceCarrier = {};

    let returned: TraceCarrier | undefined;
    context.with(ctx, () => {
      returned = injectTraceContext(input);
    });
    span.end();

    expect(returned).toBe(input);
    expect(input["traceparent"]).toBeDefined();
  });

  it("returns an empty carrier when no active span exists", () => {
    // Outside any context.with() call → context.active() is ROOT_CONTEXT,
    // which has an invalid span context → W3C propagator emits nothing.
    const carrier = injectTraceContext();
    expect(carrier["traceparent"]).toBeUndefined();
  });

  it("embeds the active traceId inside the traceparent header", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("s");
    const spanCtx = span.spanContext();
    const ctx = trace.setSpan(context.active(), span);

    let carrier: TraceCarrier = {};
    context.with(ctx, () => {
      carrier = injectTraceContext();
    });
    span.end();

    expect(carrier["traceparent"]).toContain(spanCtx.traceId);
  });
});

// ---------------------------------------------------------------------------
// extractTraceContext
// ---------------------------------------------------------------------------

describe("extractTraceContext", () => {
  let provider: ReturnType<typeof setupProvider>["provider"];

  beforeEach(() => {
    ({ provider } = setupProvider());
  });

  afterEach(async () => {
    await teardownProvider(provider);
  });

  it("returns ROOT_CONTEXT for an empty carrier", () => {
    const ctx = extractTraceContext({});
    expect(ctx).toBe(ROOT_CONTEXT);
  });

  it("returns ROOT_CONTEXT when called with no argument", () => {
    const ctx = extractTraceContext();
    expect(ctx).toBe(ROOT_CONTEXT);
  });

  it("recovers the traceId from a carrier produced by injectTraceContext", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("producer");
    const producerSpanCtx = span.spanContext();
    const ctx = trace.setSpan(context.active(), span);

    let carrier: TraceCarrier = {};
    context.with(ctx, () => {
      carrier = injectTraceContext();
    });
    span.end();

    const extracted = extractTraceContext(carrier);
    const extractedSpanCtx = trace.getSpanContext(extracted);

    expect(extractedSpanCtx).toBeDefined();
    expect(extractedSpanCtx!.traceId).toBe(producerSpanCtx.traceId);
  });

  it("extracted spanId matches the producer span's spanId (remote parent link)", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("producer");
    const producerSpanCtx = span.spanContext();
    const ctx = trace.setSpan(context.active(), span);

    let carrier: TraceCarrier = {};
    context.with(ctx, () => {
      carrier = injectTraceContext();
    });
    span.end();

    const extracted = extractTraceContext(carrier);
    const extractedSpanCtx = trace.getSpanContext(extracted);

    expect(extractedSpanCtx!.spanId).toBe(producerSpanCtx.spanId);
  });

  it("extracted span context is marked as remote", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("s");
    const ctx = trace.setSpan(context.active(), span);

    let carrier: TraceCarrier = {};
    context.with(ctx, () => {
      carrier = injectTraceContext();
    });
    span.end();

    const extracted = extractTraceContext(carrier);
    const spanCtx = trace.getSpanContext(extracted);
    expect(spanCtx?.isRemote).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inject → extract round-trip
// ---------------------------------------------------------------------------

describe("inject → extract round-trip", () => {
  let provider: ReturnType<typeof setupProvider>["provider"];

  beforeEach(() => {
    ({ provider } = setupProvider());
  });

  afterEach(async () => {
    await teardownProvider(provider);
  });

  it("a span started under the extracted context belongs to the same trace", () => {
    const tracer = trace.getTracer("test");

    // Producer side
    const producerSpan = tracer.startSpan("producer");
    const producerCtx = trace.setSpan(context.active(), producerSpan);
    let carrier: TraceCarrier = {};
    context.with(producerCtx, () => {
      carrier = injectTraceContext();
    });
    producerSpan.end();

    // Worker side — restore context then start a child span
    const workerCtx = extractTraceContext(carrier);
    let workerSpan: ReturnType<typeof tracer.startSpan> | undefined;
    context.with(workerCtx, () => {
      workerSpan = tracer.startSpan("worker-handler");
    });
    workerSpan!.end();

    const producerSpanCtx = producerSpan.spanContext();
    const workerSpanCtx = workerSpan!.spanContext();

    expect(workerSpanCtx.traceId).toBe(producerSpanCtx.traceId);
    expect(workerSpanCtx.spanId).not.toBe(producerSpanCtx.spanId);
  });
});
