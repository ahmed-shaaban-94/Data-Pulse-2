/**
 * T460 — API signal-presence test.
 *
 * Verifies that every API metric defined in `docs/observability/signals.md` §1
 * is:
 *   1. Registered in the `ALLOWED_METRIC_LABELS` closed allowlist.
 *   2. Label-policy compliant (no forbidden labels, all labels in allowlist).
 *   3. Exposed via a typed emission helper that can be called without throwing.
 *
 * Scope: in-process definitions only. Full `/metrics` scrape (T483) requires
 * the Prometheus exporter package (`@opentelemetry/exporter-prometheus`),
 * which is gated separately per plan §10. This test validates the
 * registration surface that the exporter will drain once it is wired.
 *
 * No OTel SDK boot, no Testcontainers, no Nest app — pure module import and
 * assertion. The OTel Meter returned by `getMeter("api")` is a no-op until
 * a MetricReader is registered; helpers call through to it safely.
 *
 * Constitution §VII / FR-B-001 / FR-B-006 / T460.
 */
import {
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";
import {
  API_METRIC_NAMES,
  AUTH_FAILURE_CAUSES,
  HTTP_STATUS_CLASSES,
  SUSPICIOUS_LOGIN_REASONS,
  TENANT_CONTEXT_FAILURE_REASONS,
  recordAuthFailure,
  recordCrossTenantRejection,
  recordHttp4xxError,
  recordHttp5xxError,
  recordHttpDuration,
  recordHttpRequest,
  recordSuspiciousLogin,
  recordTenantContextFailure,
  recordValidationFailure,
} from "../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// 1. Signal-name registry: every API metric is in ALLOWED_METRIC_LABELS
// ---------------------------------------------------------------------------

describe("T460 — signal presence: every API metric is in ALLOWED_METRIC_LABELS", () => {
  for (const name of API_METRIC_NAMES) {
    it(`registers "${name}"`, () => {
      expect(ALLOWED_METRIC_LABELS[name]).toBeDefined();
    });
  }

  it("API_METRIC_NAMES covers all documented API signals (nine base + three idempotency)", () => {
    const expected = [
      "http_request_count",
      "http_request_duration_seconds",
      "http_error_4xx_total",
      "http_error_5xx_total",
      "auth_failure_total",
      "tenant_context_failure_total",
      "validation_failure_total",
      "suspicious_login_total",
      "cross_tenant_rejection_total",
      // Track D idempotency signals (T517/T523)
      "idempotency_replay_total",
      "idempotency_conflict_total",
      "idempotency_in_progress_total",
    ];
    expect([...API_METRIC_NAMES].sort()).toEqual([...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Label policy: every registered label obeys the allowlist
// ---------------------------------------------------------------------------

describe("T460 — label policy: every API metric's labels pass validateMetricLabels", () => {
  for (const name of API_METRIC_NAMES) {
    const allowed = ALLOWED_METRIC_LABELS[name] ?? [];

    it(`"${name}" passes with its full allowed label set`, () => {
      expect(validateMetricLabels(name, allowed)).toBeNull();
    });

    it(`"${name}" passes with an empty label set (subset is allowed)`, () => {
      expect(validateMetricLabels(name, [])).toBeNull();
    });

    it(`"${name}" rejects tenant_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["tenant_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });

    it(`"${name}" rejects user_id (FR-B-006)`, () => {
      const result = validateMetricLabels(name, ["user_id"]);
      expect(result?.kind).toBe("forbidden_label");
    });
  }

  it("no API metric's allowed labels intersect FORBIDDEN_METRIC_LABELS", () => {
    const offenders: Array<{ metric: string; label: string }> = [];
    for (const name of API_METRIC_NAMES) {
      const allowed = ALLOWED_METRIC_LABELS[name] ?? [];
      for (const label of allowed) {
        if (FORBIDDEN_METRIC_LABELS.has(label)) {
          offenders.push({ metric: name, label });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Helpers are callable — no throw, no SDK required
// ---------------------------------------------------------------------------

describe("T460 — emission helpers: callable without a live MetricReader", () => {
  it("recordHttpRequest does not throw", () => {
    expect(() =>
      recordHttpRequest({ route: "/v1/context/me", method: "GET", status_class: "2xx" }),
    ).not.toThrow();
  });

  it("recordHttpDuration does not throw", () => {
    expect(() =>
      recordHttpDuration({ route: "/v1/context/me", method: "GET" }, 0.045),
    ).not.toThrow();
  });

  it("recordHttp4xxError does not throw", () => {
    expect(() =>
      recordHttp4xxError({ route: "/v1/auth/signin", status: "401" }),
    ).not.toThrow();
  });

  it("recordHttp5xxError does not throw", () => {
    expect(() =>
      recordHttp5xxError({ route: "/v1/context/me", status: "500" }),
    ).not.toThrow();
  });

  it("recordAuthFailure does not throw for each valid cause", () => {
    for (const cause of AUTH_FAILURE_CAUSES) {
      expect(() => recordAuthFailure({ cause })).not.toThrow();
    }
  });

  it("recordTenantContextFailure does not throw for each valid reason", () => {
    for (const reason of TENANT_CONTEXT_FAILURE_REASONS) {
      expect(() => recordTenantContextFailure({ reason })).not.toThrow();
    }
  });

  it("recordValidationFailure does not throw", () => {
    expect(() =>
      recordValidationFailure({ route: "/v1/auth/signin" }),
    ).not.toThrow();
  });

  it("recordSuspiciousLogin does not throw for each valid reason", () => {
    for (const reason of SUSPICIOUS_LOGIN_REASONS) {
      expect(() => recordSuspiciousLogin({ reason })).not.toThrow();
    }
  });

  it("recordCrossTenantRejection does not throw", () => {
    expect(() =>
      recordCrossTenantRejection({ route: "/v1/tenants/:tenant_id/members" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Bounded-enum constants are well-formed
// ---------------------------------------------------------------------------

describe("T460 — bounded enums: status classes are documented", () => {
  it("HTTP_STATUS_CLASSES contains exactly {2xx, 3xx, 4xx, 5xx}", () => {
    expect([...HTTP_STATUS_CLASSES].sort()).toEqual(["2xx", "3xx", "4xx", "5xx"]);
  });

  it("no status class value is in FORBIDDEN_METRIC_LABELS", () => {
    for (const cls of HTTP_STATUS_CLASSES) {
      expect(FORBIDDEN_METRIC_LABELS.has(cls)).toBe(false);
    }
  });
});
