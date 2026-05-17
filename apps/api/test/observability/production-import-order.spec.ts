/**
 * T483 — Production import-order regression test.
 *
 * Verifies that instruments created at module-load time in `api.metrics.ts`
 * (which happens before `bootstrap()` ever runs) actually forward data to the
 * Prometheus scrape endpoint when `instrumentation.ts` is imported first.
 *
 * Why this test exists
 * --------------------
 * The critical production bug: ES/CommonJS imports are hoisted. When `main.ts`
 * is loaded, ALL imports are evaluated before `bootstrap()` runs:
 *   1. `instrumentation.ts` → calls `startOtel()` → registers MeterProvider
 *   2. `api.metrics.ts` → creates counters/histograms against the LIVE provider
 *
 * If `startOtel()` is called AFTER `api.metrics.ts` (e.g., inside `bootstrap()`),
 * all instruments become dead ProxyCounters that never forward data to the
 * Prometheus exporter.
 *
 * Test strategy
 * -------------
 * Use `jest.isolateModules()` to control module evaluation order in-process:
 *   1. Set `METRICS_PORT` before loading any module.
 *   2. Load `instrumentation.ts` FIRST → this calls `startOtel()` synchronously.
 *   3. Load `api.metrics.ts` SECOND → instruments see the live MeterProvider.
 *   4. Call a module-level helper → assert the data appears in `/metrics`.
 *
 * This directly mimics the production import order imposed by `main.ts`.
 *
 * Constitution §VII / T483.
 */
import * as net from "net";
import * as http from "http";
import { __internal_otelMetricsApi as otelMetrics } from "@data-pulse-2/shared";

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
// Test
// ---------------------------------------------------------------------------

describe("T483 — production import-order regression", () => {
  let metricsPort: number;

  beforeEach(async () => {
    metricsPort = await getFreePort();
  });

  afterEach(async () => {
    // Reset global OTel state so other test files start clean.
    otelMetrics.disable();
  });

  it("module-level recordHttpRequest emits to /metrics when instrumentation.ts loads first", async () => {
    // Capture the port before the modules load.
    const capturedPort = metricsPort;

    // Use jest.isolateModules to get a fresh module registry scoped to
    // this block. This lets us control evaluation order precisely.
    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(async () => {
        try {
          // Step 1: set METRICS_PORT so instrumentation.ts picks it up.
          process.env["METRICS_PORT"] = String(capturedPort);

          // Step 2: load instrumentation FIRST — mimics main.ts import order.
          // This calls startOtel() synchronously, registering the MeterProvider.
          require("../../src/instrumentation");

          // Step 3: wait for the Prometheus exporter's HTTP listener to be up.
          await waitForMetricsEndpoint(
            `http://127.0.0.1:${capturedPort}/metrics`,
          );

          // Step 4: load api.metrics AFTER the provider is set — this mimics
          // AppModule's transitive imports being evaluated post-instrumentation.
          // All instruments created here resolve to live SDK counters.
          const {
            recordHttpRequest,
          }: typeof import("../../src/observability/metrics/api.metrics") =
            require("../../src/observability/metrics/api.metrics");

          // Step 5: emit a metric via the module-level helper.
          recordHttpRequest({
            method: "GET",
            route: "/health",
            status_class: "2xx",
          });

          // Step 6: flush and scrape — the data must appear.
          // We can't call provider.forceFlush() here because we don't have a
          // handle to the internal MeterProvider. Instead, wait a tick for the
          // OTel collect cycle and retry the scrape a few times.
          let body = "";
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            body = await fetchText(
              `http://127.0.0.1:${capturedPort}/metrics`,
            );
            if (body.includes("http_request_count")) break;
            await new Promise((r) => setTimeout(r, 100));
          }

          expect(body).toContain("http_request_count");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
});
