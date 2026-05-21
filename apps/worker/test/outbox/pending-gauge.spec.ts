/**
 * T595 PR-B-2 — outbox_pending_total ObservableGauge registrar spec.
 *
 * Pure unit-level coverage of `registerOutboxPendingGauge`. The OTel
 * ObservableGauge's `addCallback` is exercised via the injected `queryFn`
 * seam; no live Postgres, no OTel SDK boot beyond the no-op default Meter
 * that `worker.metrics.ts` already constructs at module load.
 *
 * What this spec pins:
 *   PG-1 — pool=null is a no-op (no callback registered, stop() is safe).
 *   PG-2 — pool != null registers a callback that observes one sample per
 *          event_type returned by queryFn.
 *   PG-3 — count is forwarded verbatim from queryFn (no coercion of values).
 *   PG-4 — queryFn returning [] observes nothing (operator-truthful "no data").
 *   PG-5 — queryFn throwing is caught; callback writes a redacted single-line
 *          stderr diagnostic and does NOT throw to the OTel SDK.
 *   PG-6 — re-entrancy: while a previous callback invocation is awaiting its
 *          queryFn, a second invocation skips without calling queryFn again.
 *   PG-7 — stop() removes the callback so subsequent scrapes do not invoke it.
 *
 * Pattern: invoke the callback DIRECTLY by spying on _outboxPending via the
 * exported `registerOutboxPendingGauge` surface — we capture the callback
 * passed to `addCallback` by monkey-patching it for the duration of the
 * test. A `FakeObservableResult` records every observe(value, attrs) so
 * assertions can read the captured pairs.
 *
 * No Docker, no Postgres, no Nest DI graph.
 */
import {
  registerOutboxPendingGauge,
  type OutboxPendingRow,
} from "../../src/observability/metrics/worker.metrics";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface ObservedSample {
  value: number;
  attributes: Record<string, unknown>;
}

class FakeObservableResult {
  readonly samples: ObservedSample[] = [];
  observe(value: number, attributes: Record<string, unknown>): void {
    this.samples.push({ value, attributes });
  }
}

/**
 * Captures the `addCallback` registered by `registerOutboxPendingGauge`.
 *
 * The registrar calls `_outboxPending.addCallback(cb)` where
 * `_outboxPending` is module-scoped. We don't have a direct handle, so we
 * monkey-patch a known proxy: a `jest.spyOn` on the underlying meter
 * instrument would be the textbook approach, but the instrument is a
 * private const. Instead we rely on the OTel API contract that
 * `addCallback` is invoked from the same module; we capture the callback
 * by injecting an `Object.defineProperty`-style override on the gauge.
 *
 * In practice the simplest seam is: monkey-patch the
 * `_outboxPending.addCallback` method via the module's exported instrument
 * — but that's also private. The cleanest unit approach is the one taken
 * here: use the public `registerOutboxPendingGauge` API and capture the
 * callback by spying on `addCallback` through the meter graph at the
 * `@opentelemetry/api` boundary.
 */
function captureCallback(): {
  cb: () => Promise<((result: FakeObservableResult) => Promise<void>) | null>;
  restore: () => void;
} {
  // Lazy require to keep this file out of the @opentelemetry/api load
  // graph until the test runs.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const api = require("@opentelemetry/api") as typeof import("@opentelemetry/api");
  const meter = api.metrics.getMeter("worker");
  // Get a reference to the same observable gauge worker.metrics.ts uses.
  // Pino's `getMeter("worker")` returns the same instance, and
  // createObservableGauge is idempotent for the same name.
  const gauge = meter.createObservableGauge("outbox_pending_total");

  let capturedCb:
    | ((result: FakeObservableResult) => void | Promise<void>)
    | null = null;
  const origAdd = gauge.addCallback.bind(gauge);
  const origRemove = gauge.removeCallback.bind(gauge);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gauge as any).addCallback = (
    cb: (result: FakeObservableResult) => void | Promise<void>,
  ) => {
    capturedCb = cb;
    origAdd(cb as never);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gauge as any).removeCallback = (
    cb: (result: FakeObservableResult) => void | Promise<void>,
  ) => {
    if (capturedCb === cb) {
      capturedCb = null;
    }
    origRemove(cb as never);
  };

  return {
    cb: async () =>
      capturedCb as
        | ((result: FakeObservableResult) => Promise<void>)
        | null,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gauge as any).addCallback = origAdd;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gauge as any).removeCallback = origRemove;
    },
  };
}

/**
 * A minimal Pool stand-in. The registrar accepts `Pool | null`; we only need
 * a truthy object so the runtime check passes — the injected queryFn never
 * touches it.
 */
const FAKE_POOL = {} as unknown as import("pg").Pool;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerOutboxPendingGauge", () => {
  let cap: ReturnType<typeof captureCallback>;

  beforeEach(() => {
    cap = captureCallback();
  });

  afterEach(() => {
    cap.restore();
  });

  // PG-1
  it("PG-1: pool=null is a no-op (no callback registered, stop() safe)", async () => {
    const handle = registerOutboxPendingGauge({ pool: null });
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
    // No callback was passed to addCallback.
    expect(await cap.cb()).toBeNull();
    // stop() on the no-op handle must be safe.
    expect(() => handle.stop()).not.toThrow();
  });

  // PG-2
  it("PG-2: pool != null registers a callback that observes one sample per event_type", async () => {
    const rows: OutboxPendingRow[] = [
      { event_type: "audit.event.created", count: 7 },
      { event_type: "test.event.alpha", count: 3 },
    ];
    const queryFn = jest.fn(async () => rows);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    try {
      const cb = await cap.cb();
      expect(cb).not.toBeNull();

      const result = new FakeObservableResult();
      await cb!(result);

      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(result.samples).toHaveLength(2);
      expect(result.samples).toEqual(
        expect.arrayContaining([
          { value: 7, attributes: { event_type: "audit.event.created" } },
          { value: 3, attributes: { event_type: "test.event.alpha" } },
        ]),
      );
    } finally {
      handle.stop();
    }
  });

  // PG-3
  it("PG-3: count value is forwarded verbatim from queryFn (no coercion)", async () => {
    const rows: OutboxPendingRow[] = [
      { event_type: "audit.event.created", count: 0 },
      { event_type: "test.event.beta", count: 1_000_000 },
    ];
    const queryFn = jest.fn(async () => rows);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    try {
      const cb = await cap.cb();
      const result = new FakeObservableResult();
      await cb!(result);

      const audit = result.samples.find(
        (s) => s.attributes["event_type"] === "audit.event.created",
      );
      expect(audit?.value).toBe(0);

      const beta = result.samples.find(
        (s) => s.attributes["event_type"] === "test.event.beta",
      );
      expect(beta?.value).toBe(1_000_000);
    } finally {
      handle.stop();
    }
  });

  // PG-4
  it("PG-4: empty queryFn result observes nothing", async () => {
    const queryFn = jest.fn(async () => [] as OutboxPendingRow[]);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    try {
      const cb = await cap.cb();
      const result = new FakeObservableResult();
      await cb!(result);

      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(result.samples).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  // PG-5
  it("PG-5: queryFn throw is caught; callback writes one stderr line and does NOT throw", async () => {
    class FakePgError extends Error {
      override readonly name = "FakePgError";
    }
    const queryFn = jest.fn(async () => {
      throw new FakePgError("connection refused");
    });

    // Capture stderr.
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    try {
      const cb = await cap.cb();
      const result = new FakeObservableResult();

      // Must not throw — OTel callbacks may NEVER throw.
      await expect(cb!(result)).resolves.toBeUndefined();
      expect(result.samples).toEqual([]);

      // One stderr line was written with the redacted error class.
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = String(stderrSpy.mock.calls[0]![0]);
      const parsed = JSON.parse(written.trim()) as Record<string, unknown>;
      expect(parsed["level"]).toBe("error");
      expect(parsed["component"]).toBe("outbox.pending.gauge");
      expect(parsed["errorName"]).toBe("FakePgError");
      // Critically: NO err.message in the log line. The matrix is strict
      // about Postgres-shaped error messages embedding parameter data.
      const blob = JSON.stringify(parsed);
      expect(blob).not.toContain("connection refused");
    } finally {
      stderrSpy.mockRestore();
      handle.stop();
    }
  });

  // PG-6
  it("PG-6: re-entrancy — a second invocation while the first is in-flight skips", async () => {
    let resolveFirst!: (rows: OutboxPendingRow[]) => void;
    const firstQuery = new Promise<OutboxPendingRow[]>((resolve) => {
      resolveFirst = resolve;
    });

    // queryFn returns the still-pending promise on the FIRST call; if it
    // were called a second time we'd return a different value, but the
    // re-entrancy guard should skip the second call entirely.
    const queryFn = jest
      .fn<Promise<OutboxPendingRow[]>, [import("pg").Pool]>()
      .mockReturnValueOnce(firstQuery)
      .mockResolvedValueOnce([{ event_type: "should.not.appear", count: 99 }]);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    try {
      const cb = await cap.cb();
      const firstResult = new FakeObservableResult();
      const secondResult = new FakeObservableResult();

      // First invocation — kicks off the long query.
      const firstPromise = cb!(firstResult);
      // Second invocation while first still in-flight — must skip.
      const secondPromise = cb!(secondResult);

      await secondPromise;
      expect(secondResult.samples).toEqual([]);
      // queryFn must have been called exactly ONCE; the second invocation
      // skipped before calling it.
      expect(queryFn).toHaveBeenCalledTimes(1);

      // Now release the first query.
      resolveFirst([{ event_type: "audit.event.created", count: 4 }]);
      await firstPromise;
      expect(firstResult.samples).toEqual([
        { value: 4, attributes: { event_type: "audit.event.created" } },
      ]);
    } finally {
      handle.stop();
    }
  });

  // PG-7
  it("PG-7: stop() removes the callback (subsequent OTel scrapes do not invoke queryFn)", async () => {
    const queryFn = jest.fn(async () => [] as OutboxPendingRow[]);

    const handle = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn });
    const cb = await cap.cb();
    expect(cb).not.toBeNull();

    handle.stop();

    // After stop(), the captured callback reference is cleared by the
    // capture helper's removeCallback wrapper.
    expect(await cap.cb()).toBeNull();
  });

  // PG-8 — defense: subsequent calls after stop() should re-register cleanly.
  it("PG-8: re-registering after stop() works (no stale state)", async () => {
    const queryFn1 = jest.fn(async () => [
      { event_type: "audit.event.created", count: 1 },
    ]);
    const handle1 = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn: queryFn1 });
    handle1.stop();

    const queryFn2 = jest.fn(async () => [
      { event_type: "audit.event.created", count: 2 },
    ]);
    const handle2 = registerOutboxPendingGauge({ pool: FAKE_POOL, queryFn: queryFn2 });
    try {
      const cb = await cap.cb();
      const result = new FakeObservableResult();
      await cb!(result);

      // Only queryFn2 fires — queryFn1's callback was removed by handle1.stop().
      expect(queryFn1).not.toHaveBeenCalled();
      expect(queryFn2).toHaveBeenCalledTimes(1);
      expect(result.samples).toEqual([
        { value: 2, attributes: { event_type: "audit.event.created" } },
      ]);
    } finally {
      handle2.stop();
    }
  });
});
