/**
 * Metric-label cardinality guard — unit tests.
 *
 * Mirrors the API-side cardinality.spec.ts (T461) at the shared-package
 * level so that FORBIDDEN_METRIC_LABELS, ALLOWED_METRIC_LABELS,
 * validateMetricLabels, and assertMetricLabels have 100% shared-package
 * coverage. Both suites must stay green; they are complementary, not
 * redundant — the shared suite protects the library itself, the API suite
 * protects the integration contract.
 */
import {
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  assertMetricLabels,
  validateMetricLabels,
} from "../../src/observability/metrics-labels";

// ---------------------------------------------------------------------------
// FORBIDDEN_METRIC_LABELS — deny list invariants
// ---------------------------------------------------------------------------

describe("FORBIDDEN_METRIC_LABELS — mandatory-forbidden keys (FR-B-006)", () => {
  it("contains tenant_id", () => expect(FORBIDDEN_METRIC_LABELS.has("tenant_id")).toBe(true));
  it("contains tenantId", () => expect(FORBIDDEN_METRIC_LABELS.has("tenantId")).toBe(true));
  it("contains store_id", () => expect(FORBIDDEN_METRIC_LABELS.has("store_id")).toBe(true));
  it("contains user_id", () => expect(FORBIDDEN_METRIC_LABELS.has("user_id")).toBe(true));
  it("contains actor_id", () => expect(FORBIDDEN_METRIC_LABELS.has("actor_id")).toBe(true));
});

describe("FORBIDDEN_METRIC_LABELS — PII-adjacent keys", () => {
  it("contains email", () => expect(FORBIDDEN_METRIC_LABELS.has("email")).toBe(true));
  it("contains phone", () => expect(FORBIDDEN_METRIC_LABELS.has("phone")).toBe(true));
  it("contains full_name", () => expect(FORBIDDEN_METRIC_LABELS.has("full_name")).toBe(true));
  it("contains ip_address", () => expect(FORBIDDEN_METRIC_LABELS.has("ip_address")).toBe(true));
});

describe("FORBIDDEN_METRIC_LABELS — credential keys", () => {
  it("contains password", () => expect(FORBIDDEN_METRIC_LABELS.has("password")).toBe(true));
  it("contains token", () => expect(FORBIDDEN_METRIC_LABELS.has("token")).toBe(true));
  it("contains api_key", () => expect(FORBIDDEN_METRIC_LABELS.has("api_key")).toBe(true));
  it("contains secret", () => expect(FORBIDDEN_METRIC_LABELS.has("secret")).toBe(true));
  it("contains idempotency_key", () =>
    expect(FORBIDDEN_METRIC_LABELS.has("idempotency_key")).toBe(true));
});

describe("FORBIDDEN_METRIC_LABELS — per-message identifiers (unbounded)", () => {
  it("contains request_id", () => expect(FORBIDDEN_METRIC_LABELS.has("request_id")).toBe(true));
  it("contains correlation_id", () =>
    expect(FORBIDDEN_METRIC_LABELS.has("correlation_id")).toBe(true));
  it("contains trace_id", () => expect(FORBIDDEN_METRIC_LABELS.has("trace_id")).toBe(true));
  it("contains path (rendered URL)", () =>
    expect(FORBIDDEN_METRIC_LABELS.has("path")).toBe(true));
  it("contains url (rendered URL)", () => expect(FORBIDDEN_METRIC_LABELS.has("url")).toBe(true));
});

// ---------------------------------------------------------------------------
// ALLOWED_METRIC_LABELS — closed allowlist invariants
// ---------------------------------------------------------------------------

describe("ALLOWED_METRIC_LABELS — allowlist well-formedness", () => {
  it("every entry has a snake_case key", () => {
    for (const metric of Object.keys(ALLOWED_METRIC_LABELS)) {
      expect(metric).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every entry value is an array", () => {
    for (const labels of Object.values(ALLOWED_METRIC_LABELS)) {
      expect(Array.isArray(labels)).toBe(true);
    }
  });

  it("no allowed label is also in FORBIDDEN_METRIC_LABELS", () => {
    const offenders: Array<{ metric: string; label: string }> = [];
    for (const [metric, labels] of Object.entries(ALLOWED_METRIC_LABELS)) {
      for (const label of labels) {
        if (FORBIDDEN_METRIC_LABELS.has(label)) offenders.push({ metric, label });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registers auth_failure_total with [cause]", () => {
    expect(ALLOWED_METRIC_LABELS["auth_failure_total"]).toEqual(["cause"]);
  });

  it("registers http_request_count with [route, method, status_class]", () => {
    expect(ALLOWED_METRIC_LABELS["http_request_count"]).toEqual([
      "route",
      "method",
      "status_class",
    ]);
  });

  it("registers db_rls_context_failure_total with no labels (alertable)", () => {
    expect(ALLOWED_METRIC_LABELS["db_rls_context_failure_total"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateMetricLabels — discriminated-union failure modes
// ---------------------------------------------------------------------------

describe("validateMetricLabels — success paths", () => {
  it("returns null for an exact match", () => {
    expect(
      validateMetricLabels("http_request_count", ["route", "method", "status_class"]),
    ).toBeNull();
  });

  it("returns null for an empty subset of allowed labels", () => {
    expect(validateMetricLabels("http_request_count", [])).toBeNull();
  });

  it("returns null for a signal with no allowed labels", () => {
    expect(validateMetricLabels("db_rls_context_failure_total", [])).toBeNull();
  });

  it("returns null for a single-label signal", () => {
    expect(validateMetricLabels("auth_failure_total", ["cause"])).toBeNull();
  });
});

describe("validateMetricLabels — unknown_metric", () => {
  it("returns unknown_metric for an unregistered signal", () => {
    const err = validateMetricLabels("not_in_catalogue_total", []);
    expect(err?.kind).toBe("unknown_metric");
    expect(err).toMatchObject({ kind: "unknown_metric", metric: "not_in_catalogue_total" });
  });
});

describe("validateMetricLabels — forbidden_label", () => {
  it("returns forbidden_label for tenant_id on any signal", () => {
    const err = validateMetricLabels("http_request_count", ["tenant_id"]);
    expect(err).toEqual({
      kind: "forbidden_label",
      metric: "http_request_count",
      label: "tenant_id",
    });
  });

  it("returns forbidden_label for user_id", () => {
    const err = validateMetricLabels("auth_failure_total", ["user_id"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("returns forbidden_label for email", () => {
    const err = validateMetricLabels("auth_failure_total", ["email"]);
    expect(err?.kind).toBe("forbidden_label");
  });

  it("forbidden check fires before unallowed check", () => {
    // tenant_id is forbidden; region is merely unallowed. Forbidden wins.
    const err = validateMetricLabels("http_request_count", ["region", "tenant_id"]);
    expect(err?.kind).toBe("forbidden_label");
    expect(err).toMatchObject({ label: "tenant_id" });
  });
});

describe("validateMetricLabels — unallowed_label", () => {
  it("returns unallowed_label for a safe but undeclared label", () => {
    const err = validateMetricLabels("http_request_count", ["region"]);
    expect(err).toEqual({
      kind: "unallowed_label",
      metric: "http_request_count",
      label: "region",
      allowed: ["route", "method", "status_class"],
    });
  });
});

// ---------------------------------------------------------------------------
// assertMetricLabels — strict throwing variant
// ---------------------------------------------------------------------------

describe("assertMetricLabels — does not throw on valid input", () => {
  it("passes for a valid signal with full label set", () => {
    expect(() =>
      assertMetricLabels("http_request_count", ["route", "method", "status_class"]),
    ).not.toThrow();
  });

  it("passes for a valid signal with empty label set", () => {
    expect(() => assertMetricLabels("queue_lag_seconds", ["queue"])).not.toThrow();
  });
});

describe("assertMetricLabels — throws with useful messages", () => {
  it("throws naming the metric on unknown_metric", () => {
    expect(() => assertMetricLabels("ghost_metric_total", [])).toThrow(
      /not registered in ALLOWED_METRIC_LABELS/,
    );
    expect(() => assertMetricLabels("ghost_metric_total", [])).toThrow(/ghost_metric_total/);
  });

  it("throws naming the offending label on forbidden_label", () => {
    expect(() => assertMetricLabels("http_request_count", ["tenant_id"])).toThrow(
      /FORBIDDEN_METRIC_LABELS|FR-B-006/,
    );
    expect(() => assertMetricLabels("http_request_count", ["tenant_id"])).toThrow(/tenant_id/);
  });

  it("throws naming the allowed set on unallowed_label", () => {
    expect(() => assertMetricLabels("auth_failure_total", ["ip_class"])).toThrow(
      /not in the allowlist/,
    );
    expect(() => assertMetricLabels("auth_failure_total", ["ip_class"])).toThrow(/cause/);
  });
});
