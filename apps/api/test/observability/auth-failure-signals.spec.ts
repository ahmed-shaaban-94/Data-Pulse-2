/**
 * T466 — auth-failure-by-cause signal test.
 *
 * Asserts `auth_failure_total{cause}` is:
 *   - Bounded: only the five documented cause values are accepted.
 *   - Non-PII: no cause value is a credential or identity field.
 *   - Outcome-derived: causes describe the authentication outcome, never
 *     the credential material (no email, password, token, tenant_id, etc.).
 *   - Label-policy compliant: `validateMetricLabels` approves the `cause`
 *     label and rejects forbidden alternatives.
 *   - Callable: `recordAuthFailure` accepts every valid cause without
 *     throwing, even before a MetricReader is registered.
 *
 * Scope: in-process; no Testcontainers, no Nest app, no live SDK. The OTel
 * Meter is a no-op in this context. Full end-to-end cause-increment
 * verification (one sub-test per cause asserts only the target counter
 * incremented) requires an in-process MetricReader which is deferred to
 * the exporter-package approval gate (T483 / plan §10).
 *
 * Per plan §4.4 (T466), emission sites are:
 *   - `bad_password` → auth.service.ts
 *   - `bad_token` / `expired` / `missing` → auth.guard.ts
 *   - `rate_limited` → rate-limit.ts
 * This test validates the cause constants and helper surface; emission-site
 * wiring lives in the T470 call-site PR.
 *
 * Constitution §VII / FR-B-001 / FR-B-006 / T466.
 */
import {
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  validateMetricLabels,
} from "@data-pulse-2/shared";
import {
  AUTH_FAILURE_CAUSES,
  type AuthFailureCause,
  recordAuthFailure,
} from "../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Cause set: bounded, complete, documented
// ---------------------------------------------------------------------------

describe("T466 — auth_failure_total: cause constants are bounded and complete", () => {
  it("contains exactly the five documented causes", () => {
    expect([...AUTH_FAILURE_CAUSES].sort()).toEqual(
      ["bad_password", "bad_token", "expired", "missing", "rate_limited"].sort(),
    );
  });

  it("has length 5", () => {
    expect(AUTH_FAILURE_CAUSES).toHaveLength(5);
  });

  it("contains bad_password (auth.service.ts emission site)", () => {
    expect(AUTH_FAILURE_CAUSES).toContain("bad_password");
  });

  it("contains bad_token (auth.guard.ts emission site — malformed bearer)", () => {
    expect(AUTH_FAILURE_CAUSES).toContain("bad_token");
  });

  it("contains expired (auth.guard.ts emission site — expired session/token)", () => {
    expect(AUTH_FAILURE_CAUSES).toContain("expired");
  });

  it("contains missing (auth.guard.ts emission site — no credential)", () => {
    expect(AUTH_FAILURE_CAUSES).toContain("missing");
  });

  it("contains rate_limited (rate-limit.ts emission site)", () => {
    expect(AUTH_FAILURE_CAUSES).toContain("rate_limited");
  });
});

// ---------------------------------------------------------------------------
// PII / credential safety: cause values are outcome-derived, not credential-
// derived (signals.md §1, plan §4.4 "Stop condition")
// ---------------------------------------------------------------------------

describe("T466 — auth_failure_total: cause values are non-PII and non-credential", () => {
  it("no cause value is in FORBIDDEN_METRIC_LABELS", () => {
    for (const cause of AUTH_FAILURE_CAUSES) {
      expect(FORBIDDEN_METRIC_LABELS.has(cause)).toBe(false);
    }
  });

  it("no cause value contains email-like patterns", () => {
    for (const cause of AUTH_FAILURE_CAUSES) {
      expect(cause).not.toMatch(/email|@/i);
    }
  });

  it("every cause is a static lowercase_snake string — never a runtime credential value", () => {
    // Causes are fixed string literals from the bounded enum. They describe
    // the OUTCOME of authentication, not the credential itself. Being static
    // strings (not derived from request data) is what makes them safe as metric
    // labels: a bad_password cause never includes the actual password text.
    for (const cause of AUTH_FAILURE_CAUSES) {
      expect(cause).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it("no cause value contains identity-like patterns (user_id, tenant_id, actor_id)", () => {
    for (const cause of AUTH_FAILURE_CAUSES) {
      expect(cause).not.toMatch(/user_?id|tenant_?id|actor_?id/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Label-policy compliance: `cause` is the only label and it is allowed
// ---------------------------------------------------------------------------

describe("T466 — auth_failure_total: label policy", () => {
  it("validateMetricLabels passes with [cause]", () => {
    expect(validateMetricLabels("auth_failure_total", ["cause"])).toBeNull();
  });

  it("validateMetricLabels passes with [] (empty subset is valid)", () => {
    expect(validateMetricLabels("auth_failure_total", [])).toBeNull();
  });

  it("allowed label set is exactly [cause] per signals.md §1", () => {
    expect(ALLOWED_METRIC_LABELS["auth_failure_total"]).toEqual(["cause"]);
  });

  it("rejects tenant_id (forbidden by FR-B-006)", () => {
    const result = validateMetricLabels("auth_failure_total", ["tenant_id"]);
    expect(result?.kind).toBe("forbidden_label");
    expect(result).toMatchObject({ label: "tenant_id" });
  });

  it("rejects user_id (forbidden by FR-B-006)", () => {
    const result = validateMetricLabels("auth_failure_total", ["user_id"]);
    expect(result?.kind).toBe("forbidden_label");
  });

  it("rejects email (PII — forbidden by FR-B-006)", () => {
    const result = validateMetricLabels("auth_failure_total", ["email"]);
    expect(result?.kind).toBe("forbidden_label");
  });

  it("rejects an unallowed but non-forbidden label (e.g. ip_class)", () => {
    const result = validateMetricLabels("auth_failure_total", ["ip_class"]);
    expect(result?.kind).toBe("unallowed_label");
  });
});

// ---------------------------------------------------------------------------
// Emission helper: callable for every valid cause, no MetricReader required
// ---------------------------------------------------------------------------

describe("T466 — recordAuthFailure helper: each cause emits without throwing", () => {
  for (const cause of AUTH_FAILURE_CAUSES) {
    it(`accepts cause="${cause}" without throwing`, () => {
      expect(() => recordAuthFailure({ cause })).not.toThrow();
    });
  }

  it("TypeScript type AuthFailureCause is derived from AUTH_FAILURE_CAUSES", () => {
    // Compile-time check: the type assignment below would fail to compile if
    // AuthFailureCause did not include the five cause values.
    const _causes: AuthFailureCause[] = [...AUTH_FAILURE_CAUSES];
    expect(_causes).toHaveLength(5);
  });
});
