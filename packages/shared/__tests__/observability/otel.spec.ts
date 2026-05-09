/**
 * Unit tests for otel.ts SDK helpers.
 *
 * Strategy: jest.mock replaces @opentelemetry/sdk-node and the instrumentation
 * packages with lightweight stubs so that NodeSDK.start() / .shutdown() never
 * open real sockets, register real HTTP interceptors, or connect to an OTLP
 * collector. All tests are pure in-process.
 */

// Shared mock functions — defined outside jest.mock so tests can inspect them.
const mockStart = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock("@opentelemetry/sdk-node", () => {
  const MockNodeSDK = jest.fn().mockImplementation(() => ({
    start: mockStart,
    shutdown: mockShutdown,
  }));
  return { NodeSDK: MockNodeSDK };
});

jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-redis", () => ({
  RedisInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

// Import after mocks are hoisted.
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  createOtelSdk,
  startOtel,
  shutdownOtel,
} from "../../src/observability/otel";

const MockNodeSDK = NodeSDK as jest.MockedClass<typeof NodeSDK>;

// ---------------------------------------------------------------------------
// createOtelSdk
// ---------------------------------------------------------------------------

describe("createOtelSdk", () => {
  beforeEach(() => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
  });

  it("constructs a NodeSDK with the given serviceName", () => {
    createOtelSdk({ serviceName: "my-service" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["serviceName"]).toBe("my-service");
  });

  it("includes serviceVersion when provided", () => {
    createOtelSdk({ serviceName: "svc", serviceVersion: "1.2.3" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["serviceVersion"]).toBe("1.2.3");
  });

  it("omits serviceVersion when not provided", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg).not.toHaveProperty("serviceVersion");
  });

  it("passes an OTLP exporter to NodeSDK", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["traceExporter"]).toBeDefined();
  });

  it("passes instrumentations array to NodeSDK", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(Array.isArray(ctorArg["instrumentations"])).toBe(true);
    expect((ctorArg["instrumentations"] as unknown[]).length).toBeGreaterThan(
      0,
    );
  });

  it("enables diag logging when debug is true without throwing", () => {
    expect(() =>
      createOtelSdk({ serviceName: "svc", debug: true }),
    ).not.toThrow();
  });

  it("accepts a custom otlpEndpoint without throwing", () => {
    expect(() =>
      createOtelSdk({
        serviceName: "svc",
        otlpEndpoint: "http://localhost:4318/v1/traces",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startOtel
// ---------------------------------------------------------------------------

describe("startOtel", () => {
  beforeEach(async () => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    // Reset singleton between tests
    await shutdownOtel();
  });

  it("creates and starts a NodeSDK instance", () => {
    startOtel({ serviceName: "svc" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("returns the same instance on a second call (idempotent)", () => {
    const first = startOtel({ serviceName: "svc" });
    const second = startOtel({ serviceName: "svc" });
    expect(second).toBe(first);
    // NodeSDK constructor must only have been called once
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// shutdownOtel
// ---------------------------------------------------------------------------

describe("shutdownOtel", () => {
  beforeEach(async () => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    await shutdownOtel();
  });

  it("resolves immediately when no SDK has been started (no-op)", async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it("calls shutdown on the running SDK and then resolves", async () => {
    startOtel({ serviceName: "svc" });
    await shutdownOtel();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it("clears the singleton so a subsequent startOtel creates a fresh SDK", async () => {
    startOtel({ serviceName: "svc" });
    await shutdownOtel();
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    startOtel({ serviceName: "svc-2" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
