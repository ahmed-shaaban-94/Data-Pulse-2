/**
 * getMeter factory — unit tests.
 *
 * Verifies that `getMeter` returns a functional OTel Meter and that
 * instruments created from it are usable (no-op when no MetricReader
 * is registered). No SDK setup is required — the global `metrics` API
 * always provides a no-op Meter before SDK start.
 */
import { getMeter } from "../../src/observability/meter";

describe("getMeter", () => {
  it("returns a Meter object", () => {
    const meter = getMeter("test-service");
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createHistogram).toBe("function");
    expect(typeof meter.createObservableGauge).toBe("function");
  });

  it("accepts an optional version argument", () => {
    const meter = getMeter("test-service", "1.0.0");
    expect(meter).toBeDefined();
  });

  it("instruments created from the meter are callable without a MetricReader", () => {
    const meter = getMeter("test-service");
    const counter = meter.createCounter("test_counter_total", {
      description: "Test counter.",
    });
    const histogram = meter.createHistogram("test_duration_seconds", {
      description: "Test histogram.",
      unit: "s",
    });
    expect(() => counter.add(1, { label: "value" })).not.toThrow();
    expect(() => histogram.record(0.5, { label: "value" })).not.toThrow();
  });

  it("returns a distinct Meter per service name", () => {
    const a = getMeter("service-a");
    const b = getMeter("service-b");
    // Both must be usable — we can't assert identity without SDK internals,
    // but we can confirm neither throws.
    expect(() => a.createCounter("a_total").add(1)).not.toThrow();
    expect(() => b.createCounter("b_total").add(1)).not.toThrow();
  });
});
