/**
 * API metric definitions — T470 / Track B / P4.
 *
 * Registers every API-layer signal from `docs/observability/signals.md` §1
 * with the OTel global Meter and exposes typed emission helpers.
 *
 * Label-policy enforcement (two layers):
 *   1. `assertMetricLabels` is called at module load for each signal.
 *      A forbidden or unregistered label throws immediately — it cannot
 *      reach a live SDK (FR-B-006, FR-B-012).
 *   2. Helper parameter types admit only the declared label keys. A call
 *      site cannot pass `tenant_id` because the helper's TypeScript
 *      signature excludes it (compile-time enforcement of FR-B-006).
 *
 * No DB or worker signals — those are T471 (DB) and T472 (worker).
 * Idempotency signals are Track D (T477) — not included here.
 *
 * Instruments are no-op until a MetricReader is registered (T470's future
 * `startOtel` extension with `metricsExporter`). Tests exercise the
 * helpers safely without a live SDK.
 *
 * Constitution §VII / FR-B-001 / FR-B-006 / FR-B-012.
 */
import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type Histogram,
} from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Bounded cause / reason enums (signals.md §1)
// ---------------------------------------------------------------------------
// Values are outcome-derived — never credential-derived. No email, password,
// token, tenant_id, or user_id may appear here (FR-B-006 + redaction matrix).

/** Five bounded auth-failure causes. All are safe metric label values. */
export const AUTH_FAILURE_CAUSES = [
  "bad_password",
  "bad_token",
  "expired",
  "missing",
  "rate_limited",
] as const satisfies readonly string[];
export type AuthFailureCause = (typeof AUTH_FAILURE_CAUSES)[number];

/** Three bounded tenant-context failure reasons. */
export const TENANT_CONTEXT_FAILURE_REASONS = [
  "missing",
  "invalid",
  "cross_tenant",
] as const satisfies readonly string[];
export type TenantContextFailureReason = (typeof TENANT_CONTEXT_FAILURE_REASONS)[number];

/** Three bounded suspicious-login reasons. */
export const SUSPICIOUS_LOGIN_REASONS = [
  "rapid_retry",
  "geo_anomaly",
  "unknown_device",
] as const satisfies readonly string[];
export type SuspiciousLoginReason = (typeof SUSPICIOUS_LOGIN_REASONS)[number];

/** HTTP status classes used for request-count bucketing. */
export const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const satisfies readonly string[];
export type HttpStatusClass = (typeof HTTP_STATUS_CLASSES)[number];

// ---------------------------------------------------------------------------
// Module-load label-policy validation
// ---------------------------------------------------------------------------
// assertMetricLabels throws if a label is forbidden or not in the closed
// allowlist (ALLOWED_METRIC_LABELS in packages/shared). Called once at
// registration time; cannot be deferred to emit time.

assertMetricLabels("http_request_count", ["route", "method", "status_class"]);
assertMetricLabels("http_request_duration_seconds", ["route", "method"]);
assertMetricLabels("http_error_4xx_total", ["route", "status"]);
assertMetricLabels("http_error_5xx_total", ["route", "status"]);
assertMetricLabels("auth_failure_total", ["cause"]);
assertMetricLabels("tenant_context_failure_total", ["reason"]);
assertMetricLabels("validation_failure_total", ["route"]);
assertMetricLabels("suspicious_login_total", ["reason"]);
assertMetricLabels("cross_tenant_rejection_total", ["route"]);
assertMetricLabels("idempotency_replay_total", ["route"]);
assertMetricLabels("idempotency_conflict_total", ["route"]);
assertMetricLabels("idempotency_in_progress_total", ["route"]);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const meter = getMeter("api");

const _httpRequestCount: Counter = meter.createCounter("http_request_count", {
  description: "Total API requests by route, method, and status class.",
});
const _httpRequestDuration: Histogram = meter.createHistogram(
  "http_request_duration_seconds",
  {
    description: "API request duration in seconds by route and method.",
    unit: "s",
  },
);
const _httpError4xx: Counter = meter.createCounter("http_error_4xx_total", {
  description: "Total 4xx error responses by route and status code.",
});
const _httpError5xx: Counter = meter.createCounter("http_error_5xx_total", {
  description: "Total 5xx error responses by route and status code.",
});
const _authFailure: Counter = meter.createCounter("auth_failure_total", {
  description: "Authentication failures by cause.",
});
const _tenantContextFailure: Counter = meter.createCounter(
  "tenant_context_failure_total",
  { description: "Tenant context resolution failures by reason." },
);
const _validationFailure: Counter = meter.createCounter("validation_failure_total", {
  description: "Request validation failures by route.",
});
const _suspiciousLogin: Counter = meter.createCounter("suspicious_login_total", {
  description: "Suspicious login attempts by reason.",
});
const _crossTenantRejection: Counter = meter.createCounter(
  "cross_tenant_rejection_total",
  { description: "Cross-tenant access rejections by route." },
);
const _idempotencyReplay: Counter = meter.createCounter(
  "idempotency_replay_total",
  { description: "Idempotent replay responses by route." },
);
const _idempotencyConflict: Counter = meter.createCounter(
  "idempotency_conflict_total",
  { description: "Idempotency key conflicts (409) by route." },
);
const _idempotencyInProgress: Counter = meter.createCounter(
  "idempotency_in_progress_total",
  { description: "In-flight idempotency collisions (425) by route." },
);

// ---------------------------------------------------------------------------
// Attribute types — TypeScript compile-time label enforcement (FR-B-006)
// ---------------------------------------------------------------------------
// Each type admits ONLY the allowed label keys for its signal. A call site
// that adds `tenant_id` or any forbidden key won't compile.

export interface HttpRequestAttrs {
  route: string;
  method: string;
  status_class: HttpStatusClass;
}

export interface HttpDurationAttrs {
  route: string;
  method: string;
}

export interface HttpErrorAttrs {
  route: string;
  status: string;
}

export interface AuthFailureAttrs {
  cause: AuthFailureCause;
}

export interface TenantContextFailureAttrs {
  reason: TenantContextFailureReason;
}

export interface ValidationFailureAttrs {
  route: string;
}

export interface SuspiciousLoginAttrs {
  reason: SuspiciousLoginReason;
}

export interface CrossTenantRejectionAttrs {
  route: string;
}

export interface IdempotencyRouteAttrs {
  route: string;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/** Increment the HTTP request counter. Called from the logging interceptor. */
export function recordHttpRequest(attrs: HttpRequestAttrs): void {
  _httpRequestCount.add(1, attrs as unknown as Attributes);
}

/**
 * Record an HTTP request duration observation (seconds).
 * Called from the logging interceptor alongside `recordHttpRequest`.
 */
export function recordHttpDuration(attrs: HttpDurationAttrs, durationSeconds: number): void {
  _httpRequestDuration.record(durationSeconds, attrs as unknown as Attributes);
}

/** Increment the 4xx error counter. Called from the exception filter. */
export function recordHttp4xxError(attrs: HttpErrorAttrs): void {
  _httpError4xx.add(1, attrs as unknown as Attributes);
}

/** Increment the 5xx error counter. Called from the exception filter. */
export function recordHttp5xxError(attrs: HttpErrorAttrs): void {
  _httpError5xx.add(1, attrs as unknown as Attributes);
}

/**
 * Increment auth_failure_total for the given cause.
 * Emission sites: auth.guard.ts (bad_token/expired/missing),
 * auth.service.ts (bad_password), rate-limit.ts (rate_limited).
 */
export function recordAuthFailure(attrs: AuthFailureAttrs): void {
  _authFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment tenant_context_failure_total.
 * Emission site: tenant-context.guard.ts resolution failures.
 */
export function recordTenantContextFailure(attrs: TenantContextFailureAttrs): void {
  _tenantContextFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment validation_failure_total.
 * Emission site: exception.filter.ts ZodError branch.
 * No field_class label — see signals.md §8 finding 2.
 */
export function recordValidationFailure(attrs: ValidationFailureAttrs): void {
  _validationFailure.add(1, attrs as unknown as Attributes);
}

/**
 * Increment suspicious_login_total.
 * Emission sites: auth.service.ts / rate-limit.ts detection paths.
 */
export function recordSuspiciousLogin(attrs: SuspiciousLoginAttrs): void {
  _suspiciousLogin.add(1, attrs as unknown as Attributes);
}

/**
 * Increment cross_tenant_rejection_total.
 * Emission site: tenant-context.guard.ts cross-tenant throw path (T475).
 */
export function recordCrossTenantRejection(attrs: CrossTenantRejectionAttrs): void {
  _crossTenantRejection.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_replay_total.
 * Emission site: IdempotencyInterceptor replay short-circuit path.
 */
export function recordIdempotencyReplay(attrs: IdempotencyRouteAttrs): void {
  _idempotencyReplay.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_conflict_total.
 * Emission site: IdempotencyInterceptor 409 conflict path.
 */
export function recordIdempotencyConflict(attrs: IdempotencyRouteAttrs): void {
  _idempotencyConflict.add(1, attrs as unknown as Attributes);
}

/**
 * Increment idempotency_in_progress_total.
 * Emission site: IdempotencyInterceptor 425 in-progress path.
 */
export function recordIdempotencyInProgress(attrs: IdempotencyRouteAttrs): void {
  _idempotencyInProgress.add(1, attrs as unknown as Attributes);
}

// ---------------------------------------------------------------------------
// Signal-name registry — used by T460 signal-presence tests
// ---------------------------------------------------------------------------

/**
 * Canonical names of all API signals registered by this module.
 * Tests import this to verify every signal is in ALLOWED_METRIC_LABELS and
 * obeys the label policy. Drift between this array and the actual instrument
 * creation above fails CI.
 */
export const API_METRIC_NAMES = [
  "http_request_count",
  "http_request_duration_seconds",
  "http_error_4xx_total",
  "http_error_5xx_total",
  "auth_failure_total",
  "tenant_context_failure_total",
  "validation_failure_total",
  "suspicious_login_total",
  "cross_tenant_rejection_total",
  "idempotency_replay_total",
  "idempotency_conflict_total",
  "idempotency_in_progress_total",
] as const satisfies readonly string[];

export type ApiMetricName = (typeof API_METRIC_NAMES)[number];
