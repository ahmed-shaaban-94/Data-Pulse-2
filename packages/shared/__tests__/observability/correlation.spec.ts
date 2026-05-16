/**
 * getCorrelationId — unit tests.
 *
 * Covers all four resolution paths:
 *   1. No active span (test context without OTel) → returns fallback.
 *   2. Active span with the all-zero invalid trace-id → returns fallback.
 *   3. Active span with a real trace-id → returns trace-id.
 *   4. OTel API throws internally → returns fallback (defensive catch).
 */
import { trace } from "@opentelemetry/api";
import { getCorrelationId } from "../../src/observability/correlation";
import { createTestTracerProvider } from "../../src/observability/bullmq-propagation";

describe("getCorrelationId — no active span (default test context)", () => {
  it("returns the fallback when no OTel span is active", () => {
    // No SDK/tracer registered → getActiveSpan() returns undefined.
    expect(getCorrelationId("req-fallback-123")).toBe("req-fallback-123");
  });

  it("returns the exact fallback string, not a transformed version", () => {
    const fallback = "my-request-id-abc-789";
    expect(getCorrelationId(fallback)).toBe(fallback);
  });
});

describe("getCorrelationId — span with invalid trace-id", () => {
  it("returns the fallback when the active span carries the all-zero trace-id", () => {
    const INVALID_TRACE_ID = "00000000000000000000000000000000";
    // Create a mock span whose spanContext() returns the invalid sentinel.
    const mockSpan = {
      spanContext: () => ({
        traceId: INVALID_TRACE_ID,
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    };
    jest
      .spyOn(trace, "getActiveSpan")
      .mockReturnValueOnce(mockSpan as unknown as ReturnType<typeof trace.getActiveSpan>);

    expect(getCorrelationId("fallback-for-invalid")).toBe("fallback-for-invalid");
  });
});

describe("getCorrelationId — active span with real trace-id", () => {
  let handle: ReturnType<typeof createTestTracerProvider>;

  beforeEach(() => {
    handle = createTestTracerProvider();
  });

  afterEach(async () => {
    await handle.teardown();
  });

  it("returns the OTel trace-id when a real span is active", () => {
    const tracer = trace.getTracer("test-service");
    tracer.startActiveSpan("test-span", (span) => {
      const { traceId } = span.spanContext();
      const result = getCorrelationId("fallback-should-not-be-used");
      expect(result).toBe(traceId);
      expect(result).not.toBe("fallback-should-not-be-used");
      // OTel trace-ids are 32 lowercase hex chars.
      expect(result).toMatch(/^[0-9a-f]{32}$/);
      span.end();
    });
  });
});

describe("getCorrelationId — defensive catch", () => {
  it("returns the fallback when getActiveSpan throws", () => {
    jest.spyOn(trace, "getActiveSpan").mockImplementationOnce(() => {
      throw new Error("OTel internal error");
    });

    expect(getCorrelationId("safe-fallback")).toBe("safe-fallback");
  });
});
