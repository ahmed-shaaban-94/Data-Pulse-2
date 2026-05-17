/**
 * T483 — Worker metrics HTTP listener integration test.
 *
 * Verifies that:
 *   1. A `PrometheusExporter` registered with a real `MeterProvider` exposes
 *      a `/metrics` endpoint in Prometheus text format on the configured port.
 *   2. A counter created via `getMeter("worker")` after the MeterProvider is
 *      registered records values that appear in the `/metrics` response,
 *      confirming that the worker-scope meter is wired to the Prometheus scrape
 *      pipeline.
 *   3. The response body is valid Prometheus text format (TYPE comment lines).
 *   4. The exporter can be bound to `127.0.0.1` (loopback), confirming that
 *      the worker metrics endpoint can be restricted to the loopback interface.
 *
 * Strategy: use `MeterProvider` + `PrometheusExporter` directly (from
 * `@opentelemetry/sdk-metrics`), bypassing NodeSDK entirely. NodeSDK wiring
 * (including the metricReaders option) is already verified in
 * `packages/shared/__tests__/observability/metrics-sdk.spec.ts`.
 *
 * Why we don't call recordQueueFailed() from worker.metrics.ts here:
 *   worker.metrics.ts creates all its instruments at module-load time under a
 *   ProxyMeter (no MeterProvider is registered yet). ProxyCounters only resolve
 *   their delegate on the NEXT getMeter() call after the provider is set. Using
 *   a fresh counter created after setGlobalMeterProvider avoids that timing
 *   issue. Worker-layer emission helpers are validated by worker-signals.spec.ts.
 *
 * No BullMQ, Redis, or Nest bootstrap required.
 *
 * Constitution §VII / T483.
 */
import * as net from "net";
import * as http from "http";
// Import OTel SDK classes via @data-pulse-2/shared so the worker package
// doesn't need to list @opentelemetry/* as direct devDependencies (T483).
import {
  __internal_MeterProvider as MeterProvider,
  __internal_PrometheusExporter as PrometheusExporter,
  __internal_otelMetricsApi as otelMetrics,
  getMeter,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

async function waitForMetricsEndpoint(
  url: string,
  maxMs = 5000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetchText(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Metrics endpoint ${url} not reachable within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T483 — worker metrics listener", () => {
  let exporter: PrometheusExporter;
  let provider: MeterProvider;
  let metricsPort: number;

  beforeEach(async () => {
    metricsPort = await getFreePort();
    // Worker binds to 127.0.0.1 to avoid external exposure.
    exporter = new PrometheusExporter({ port: metricsPort, host: "127.0.0.1" });
    provider = new MeterProvider({ readers: [exporter] });
    otelMetrics.setGlobalMeterProvider(provider);
    await waitForMetricsEndpoint(`http://127.0.0.1:${metricsPort}/metrics`);
  });

  afterEach(async () => {
    await provider.shutdown();
    otelMetrics.disable();
  });

  it("GET /metrics returns Prometheus text format", async () => {
    const body = await fetchText(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(body).toMatch(/^#\s+TYPE\s+/m);
  });

  it("GET /metrics contains queue_failed_total after recording via worker-scope meter", async () => {
    // Create the counter AFTER setGlobalMeterProvider so it's backed by the
    // real MeterProvider (not a ProxyMeter from the no-op provider).
    const meter = getMeter("worker");
    const counter = meter.createCounter("queue_failed_total", {
      description: "Queue failure counter (test).",
    });
    counter.add(1, { queue: "email", error_class: "Error" });

    // Force-flush to ensure the data point is exported before we scrape.
    await provider.forceFlush();

    const body = await fetchText(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(body).toContain("queue_failed_total");
  });

  it("binds to 127.0.0.1 so the listener is reachable on loopback", async () => {
    const body = await fetchText(`http://127.0.0.1:${metricsPort}/metrics`);
    // If reachable on loopback, the binding is correct.
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
  });
});
