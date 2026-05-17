/**
 * OTel SDK bootstrap — imported FIRST in main.ts (before any module that
 * creates OTel instruments at load time).
 *
 * Why this file exists
 * --------------------
 * ES/CommonJS imports are hoisted: every `import` at the top of `main.ts`
 * is evaluated before the first line of `bootstrap()` runs. This means
 * `AppModule` (and all its transitive imports — `api.metrics.ts`,
 * `db.metrics.ts`, etc.) create their OTel instruments against the global
 * no-op ProxyMeter BEFORE `startOtel()` could be called inside bootstrap().
 *
 * ProxyCounters/ProxyHistograms do NOT retroactively forward data to a
 * MeterProvider that is set after they were created. The result would be a
 * live Prometheus scrape endpoint that always returned "# no registered
 * metrics" because every instrument was a dead ProxyCounter.
 *
 * The fix is to call `startOtel()` at module-evaluation time — before any
 * other import in `main.ts`. Placing `import "./instrumentation"` as the
 * FIRST import ensures the MeterProvider is registered before any
 * instrument-creating module is evaluated, so all instruments resolve
 * directly to live OTel SDK counters/histograms.
 *
 * Note: `reflect-metadata` must also be imported early (NestJS decorators
 * requirement) so it stays directly after this import in main.ts.
 *
 * Constitution §VII / T483.
 */
import { startOtel } from "@data-pulse-2/shared";

// Read env vars at module-evaluation time. Node.js has already populated
// `process.env` from the OS environment by this point, so these reads are safe.
startOtel({
  serviceName: "api",
  metrics: {
    port: Number(process.env["METRICS_PORT"] ?? 9464),
  },
});
