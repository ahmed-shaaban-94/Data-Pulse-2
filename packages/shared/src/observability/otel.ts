/**
 * OpenTelemetry SDK setup for Data-Pulse-2.
 *
 * Instruments HTTP, Postgres (`pg`), and Redis (`node-redis`, v4+) via the
 * official `@opentelemetry/instrumentation-*` packages, and exports traces
 * over OTLP/HTTP.
 *
 * BullMQ instrumentation is INTENTIONALLY DEFERRED.
 *
 *   The OpenTelemetry contrib org does not publish
 *   `@opentelemetry/instrumentation-bullmq`. Available third-party options
 *   (`bullmq-otel` from the BullMQ authors, `@appsignal/...`, and others)
 *   each have different integration models and trade-offs. The BullMQ tracing
 *   decision will be made when `apps/worker` actually introduces BullMQ
 *   (Phase 2 worker bootstrap and Phase 3 email/audit processors). This
 *   module must NOT import or reference any BullMQ-related package today.
 *
 * Constitution VII (observable systems) and plan §1.1 (vendor-neutral OTel).
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface OtelOptions {
  /** Service name written into every span's `service.name` resource attr. */
  serviceName: string;
  /** Service version (e.g., git SHA or semver). */
  serviceVersion?: string;
  /**
   * Override the default OTLP/HTTP traces endpoint.
   * Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env var, then the SDK default.
   */
  otlpEndpoint?: string;
  /** Enable internal OTel debug logging. */
  debug?: boolean;
}

let sdk: NodeSDK | null = null;

export function createOtelSdk(opts: OtelOptions): NodeSDK {
  if (opts.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const traceExporter = new OTLPTraceExporter(
    opts.otlpEndpoint ? { url: opts.otlpEndpoint } : {},
  );

  const instrumentations = [
    new HttpInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation(),
    // BullMQ instrumentation deferred — see file header.
  ];

  return new NodeSDK({
    serviceName: opts.serviceName,
    ...(opts.serviceVersion ? { serviceVersion: opts.serviceVersion } : {}),
    traceExporter,
    instrumentations,
  });
}

/**
 * Start the singleton OTel SDK. Idempotent: a second call returns the
 * already-running instance.
 */
export function startOtel(opts: OtelOptions): NodeSDK {
  if (sdk) return sdk;
  sdk = createOtelSdk(opts);
  sdk.start();
  return sdk;
}

/**
 * Flush and shut down the singleton OTel SDK. Safe to call without a prior
 * `startOtel`; resolves immediately if no SDK is running.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  await current.shutdown();
}

export * from "./bullmq-propagation";
