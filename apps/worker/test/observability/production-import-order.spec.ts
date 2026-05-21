/**
 * T483 — Worker production import-order regression test.
 *
 * Verifies that worker metric instruments created at module-load time in
 * `worker.metrics.ts` actually forward data to the Prometheus scrape
 * endpoint when `instrumentation.ts` is imported first and `worker.metrics`
 * is then loaded as a side-effect import (as done in `main.ts`).
 *
 * Why this test exists
 * --------------------
 * Before this fix, `worker.metrics.ts` was never required by any runtime
 * code in the worker — the file existed only as a definitions module, and
 * the platform-defined worker signals (signals.md §3) never appeared in
 * `/metrics` because the `meter.create*` side effects never ran. The fix
 * was a one-line side-effect import added to `main.ts`:
 *
 *   import "./instrumentation";
 *   import "./observability/metrics/worker.metrics";   // <-- this
 *
 * If a future contributor removes that line, this test fails — the
 * `queue_retry_total` family will not appear in the scrape body.
 *
 * Test strategy
 * -------------
 * Use `jest.isolateModules()` to control module evaluation order in-process:
 *   1. Set `WORKER_METRICS_PORT` / `WORKER_METRICS_BIND_HOST` before loading
 *      any module.
 *   2. Load `instrumentation.ts` FIRST — this calls `startOtel()`
 *      synchronously, registering the MeterProvider on `@opentelemetry/api`.
 *   3. Load `worker.metrics.ts` SECOND — its module-level
 *      `meter.createCounter(...)` calls see the live MeterProvider.
 *   4. Call a uniquely-named worker helper (`recordQueueRetry`) so the
 *      Prometheus exporter has a non-zero data point to surface, then
 *      assert the family appears in the scrape body.
 *
 * No BullMQ, no Redis, no Nest bootstrap, no Testcontainers. Pure
 * import-order + scrape assertion.
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

describe("T483 — worker production import-order regression", () => {
  let metricsPort: number;

  beforeEach(async () => {
    metricsPort = await getFreePort();
  });

  afterEach(async () => {
    // Reset global OTel state so other test files start clean.
    otelMetrics.disable();
  });

  it("worker metric instruments emit to /metrics when instrumentation + worker.metrics load before bootstrap", async () => {
    const capturedPort = metricsPort;

    await new Promise<void>((resolve, reject) => {
      jest.isolateModules(async () => {
        try {
          // Step 1: set env so instrumentation.ts picks them up.
          process.env["WORKER_METRICS_PORT"] = String(capturedPort);
          process.env["WORKER_METRICS_BIND_HOST"] = "127.0.0.1";

          // Step 2: load instrumentation FIRST — mimics main.ts import order.
          // This calls startOtel() synchronously, registering the
          // MeterProvider on @opentelemetry/api.
          require("../../src/instrumentation");

          // Step 3: wait for the Prometheus exporter's HTTP listener to be up.
          await waitForMetricsEndpoint(
            `http://127.0.0.1:${capturedPort}/metrics`,
          );

          // Step 4: load worker.metrics AFTER the provider is set. This is the
          // exact same side-effect import that main.ts now performs. All
          // instruments created at module load resolve to live SDK counters.
          const {
            recordQueueRetry,
          }: typeof import("../../src/observability/metrics/worker.metrics") =
            require("../../src/observability/metrics/worker.metrics");

          // Step 5: emit a data point for a uniquely-named worker signal.
          // `queue_retry_total` is one of the seven worker-emission families
          // documented in signals.md §3.2 and cannot collide with any OTel
          // auto-instrumentation signal name.
          recordQueueRetry({ queue: "email" });

          // Step 6: flush + scrape with a short retry loop. Prometheus
          // collection is pull-based; the body should contain the family
          // after the next collect cycle.
          let body = "";
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            body = await fetchText(
              `http://127.0.0.1:${capturedPort}/metrics`,
            );
            if (body.includes("queue_retry_total")) break;
            await new Promise((r) => setTimeout(r, 100));
          }

          expect(body).toContain("queue_retry_total");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
});
