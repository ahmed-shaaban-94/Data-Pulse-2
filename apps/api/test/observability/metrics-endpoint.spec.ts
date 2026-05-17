/**
 * T483 — API metrics scrape endpoint integration test.
 *
 * Verifies that:
 *   1. A `PrometheusExporter` registered with a real `MeterProvider` exposes
 *      a `/metrics` endpoint in Prometheus text format.
 *   2. A counter created via `getMeter("api")` after the MeterProvider is
 *      registered records values that appear in the `/metrics` response,
 *      confirming that the API-scope meter is wired to the Prometheus scrape
 *      pipeline.
 *   3. The response body is valid Prometheus text format (TYPE comment lines).
 *
 * Strategy: use `MeterProvider` + `PrometheusExporter` directly (from
 * `@opentelemetry/sdk-metrics`), bypassing NodeSDK entirely. NodeSDK wiring
 * (including the metricReaders option) is already verified in
 * `packages/shared/__tests__/observability/metrics-sdk.spec.ts`.
 *
 * Why we don't call recordHttpRequest() from api.metrics.ts here:
 *   The api.metrics.ts module creates all its instruments at module-load time
 *   under a ProxyMeter (no MeterProvider is registered yet). ProxyCounters
 *   only resolve their delegate on the NEXT getMeter() call after the provider
 *   is set. By the time our test calls recordHttpRequest(), the ProxyCounter
 *   still points at a no-op Meter scope. To verify the scrape pipeline
 *   end-to-end we use a fresh counter created after setGlobalMeterProvider.
 *   The API-layer emission helpers are already validated by api-signals.spec.ts.
 *
 * No Nest app is bootstrapped — contract loading, DB, Redis are not needed
 * for this assertion.
 *
 * Constitution §VII / T483.
 */
import * as net from "net";
import * as http from "http";
// Import OTel SDK classes via @data-pulse-2/shared so the worker/api packages
// don't need to list @opentelemetry/* as direct devDependencies (T483).
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

describe("T483 — API metrics endpoint", () => {
  let exporter: PrometheusExporter;
  let provider: MeterProvider;
  let metricsPort: number;

  beforeEach(async () => {
    metricsPort = await getFreePort();
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
    // Prometheus text format requires TYPE comment lines.
    expect(body).toMatch(/^#\s+TYPE\s+/m);
  });

  it("GET /metrics contains http_request_count after recording via api-scope meter", async () => {
    // Create the counter AFTER setGlobalMeterProvider so it's backed by the
    // real MeterProvider (not a ProxyMeter from the no-op provider).
    const meter = getMeter("api");
    const counter = meter.createCounter("http_request_count", {
      description: "Number of HTTP requests (test).",
    });
    counter.add(1, { method: "GET", route: "/health", status_class: "2xx" });

    // Force-flush to ensure the data point is exported before we scrape.
    await provider.forceFlush();

    const body = await fetchText(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(body).toContain("http_request_count");
  });
});
