/**
 * Platform-wide OTel Meter factory — Track B / P4 / T470.
 *
 * Returns the OTel global Meter for the named service. When no SDK
 * MetricReader has been registered (test or pre-SDK-boot context), the
 * returned Meter is a no-op; every instrument it creates costs nothing to
 * call. Once a MetricReader IS registered the existing instruments start
 * recording — no re-registration needed (OTel deferred-recording contract).
 *
 * Why a separate module rather than inlining in otel.ts:
 *   The future metrics extension of otel.ts needs `@opentelemetry/sdk-metrics`
 *   (a new package, gated separately per plan §10). Until that package is
 *   approved, keeping this module free of SDK imports avoids polluting the
 *   trace-only startup path.
 *
 * This module has zero side effects — no SDK boot, no instrument creation.
 * It is a pure factory. Call sites create their own instruments.
 */
import { metrics } from "@opentelemetry/api";

export type { Attributes, Counter, Histogram, Meter, ObservableGauge } from "@opentelemetry/api";

/**
 * Return the global OTel Meter for `serviceName`. Safe to call at module
 * load time — the no-op Meter is available before any SDK starts.
 */
export function getMeter(
  serviceName: string,
  version?: string,
): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter(serviceName, version);
}
