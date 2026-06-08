/**
 * T008 (020-FND) — RED unit tests for the pure liveness-verdict helper.
 *
 * `deriveLiveness(lastSeenAt, now, thresholdMs, disabledAt)` follows the
 * documented precedence (data-model.md "Derived value"):
 *   1. disabled_at IS NOT NULL          -> "disabled"   (wins over everything)
 *   2. last_seen_at IS NULL             -> "never_seen"
 *   3. now - last_seen_at <= threshold  -> "healthy"
 *   4. else                             -> "stale"
 *
 * Pure function: no DB, no DI, no clock — `now` is injected. The 5-minute
 * default threshold is exported as a constant. The boundary is strict:
 * exactly-at-threshold is healthy (`<=`); one ms past is stale (`>`).
 */
import {
  deriveLiveness,
  DEFAULT_STALENESS_THRESHOLD_MS,
  type LivenessVerdict,
} from "../../src/connector-health/connector-health.liveness";

const now = new Date("2026-06-08T12:00:00.000Z");

describe("deriveLiveness", () => {
  it("exports a 5-minute default staleness threshold", () => {
    expect(DEFAULT_STALENESS_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it("returns never_seen when last_seen_at is null", () => {
    const v: LivenessVerdict = deriveLiveness(null, now, DEFAULT_STALENESS_THRESHOLD_MS, null);
    expect(v).toBe("never_seen");
  });

  it("returns healthy when last_seen_at is within the threshold", () => {
    const lastSeen = new Date(now.getTime() - 60_000); // 1 minute ago
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, null)).toBe("healthy");
  });

  it("returns healthy at exactly the threshold (<= boundary)", () => {
    const lastSeen = new Date(now.getTime() - DEFAULT_STALENESS_THRESHOLD_MS);
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, null)).toBe("healthy");
  });

  it("returns stale one millisecond past the threshold (> boundary)", () => {
    const lastSeen = new Date(now.getTime() - DEFAULT_STALENESS_THRESHOLD_MS - 1);
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, null)).toBe("stale");
  });

  it("returns stale when last_seen_at is well past the threshold", () => {
    const lastSeen = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, null)).toBe("stale");
  });

  it("returns disabled when disabled_at is set, regardless of a healthy last_seen_at", () => {
    const lastSeen = new Date(now.getTime() - 1000); // 1s ago -> would be healthy
    const disabledAt = new Date(now.getTime() - 10_000);
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, disabledAt)).toBe("disabled");
  });

  it("returns disabled even when never seen (disabled precedence over never_seen)", () => {
    const disabledAt = new Date(now.getTime() - 10_000);
    expect(deriveLiveness(null, now, DEFAULT_STALENESS_THRESHOLD_MS, disabledAt)).toBe("disabled");
  });

  it("returns disabled even when stale (disabled precedence over stale)", () => {
    const lastSeen = new Date(now.getTime() - 60 * 60 * 1000);
    const disabledAt = new Date(now.getTime() - 10_000);
    expect(deriveLiveness(lastSeen, now, DEFAULT_STALENESS_THRESHOLD_MS, disabledAt)).toBe("disabled");
  });
});
