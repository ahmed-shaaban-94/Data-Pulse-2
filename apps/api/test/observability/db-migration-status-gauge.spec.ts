/**
 * Unit tests for `registerDbMigrationStatusGauge` and
 * `createDbMigrationStatusCallback` (T483 / P4 W3).
 *
 * Uses `createDbMigrationStatusCallback` — the exported inner callback
 * builder — to exercise the real production callback path with a mock
 * `DbMigrationStatusObservableResult` and injectable `executeQuery`.
 * This covers the actual state logic, re-entrancy guard, and error
 * handling without requiring a live OTel MetricReader or Postgres.
 *
 * `registerDbMigrationStatusGauge` itself is tested for the null/no-op
 * contract and stop idempotency (OTel addCallback is a no-op in unit
 * tests, so callback-path coverage lives in the `createDbMigrationStatusCallback`
 * suites).
 *
 * Constitution §VII / FR-B-006 / T483 / P4 W3.
 */
import type { Pool } from "pg";

import {
  createDbMigrationStatusCallback,
  registerDbMigrationStatusGauge,
  type DbMigrationStatusObservableResult,
} from "../../src/observability/metrics/db.metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Observation = { value: number; state: string };

function makeObservableResult(): {
  result: DbMigrationStatusObservableResult;
  observations: Observation[];
} {
  const observations: Observation[] = [];
  const result: DbMigrationStatusObservableResult = {
    observe(value: number, attributes: Record<string, unknown>) {
      observations.push({ value, state: attributes["state"] as string });
    },
  };
  return { result, observations };
}

/** Pool is never called directly — the injectable executeQuery seam replaces it. */
function makeStubPool(): Pool {
  return {} as unknown as Pool;
}

// ---------------------------------------------------------------------------
// 1. registerDbMigrationStatusGauge — null / no-op contract
// ---------------------------------------------------------------------------

describe("registerDbMigrationStatusGauge — null pool (no-DB path)", () => {
  it("returns a handle with a stop function", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: null,
      totalMigrations: 9,
    });
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() does not throw on the null path", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: null,
      totalMigrations: 9,
    });
    expect(() => handle.stop()).not.toThrow();
  });

  it("stop() is idempotent on the null path", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: null,
      totalMigrations: 9,
    });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("multiple null registrations do not interfere", () => {
    const handles = Array.from({ length: 5 }, () =>
      registerDbMigrationStatusGauge({ pool: null, totalMigrations: 9 }),
    );
    expect(() => handles.forEach((h) => h.stop())).not.toThrow();
  });
});

describe("registerDbMigrationStatusGauge — non-null pool (registration smoke)", () => {
  it("returns a handle with a stop function when pool is provided", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: makeStubPool(),
      totalMigrations: 9,
    });
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });

  it("stop() does not throw after registration", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: makeStubPool(),
      totalMigrations: 9,
    });
    expect(() => handle.stop()).not.toThrow();
  });

  it("stop() is idempotent after registration", () => {
    const handle = registerDbMigrationStatusGauge({
      pool: makeStubPool(),
      totalMigrations: 9,
    });
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. createDbMigrationStatusCallback — state logic (real callback path)
// ---------------------------------------------------------------------------

describe("createDbMigrationStatusCallback — state observations", () => {
  it("observes applied=1 pending=0 failed=0 when all migrations applied", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => 9,
    );
    await callback(result);

    expect(observations).toHaveLength(3);
    expect(observations.find((o) => o.state === "applied")?.value).toBe(1);
    expect(observations.find((o) => o.state === "pending")?.value).toBe(0);
    expect(observations.find((o) => o.state === "failed")?.value).toBe(0);
  });

  it("observes applied=0 pending=1 failed=0 when migrations are pending", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => 7, // 7 of 9 applied
    );
    await callback(result);

    expect(observations).toHaveLength(3);
    expect(observations.find((o) => o.state === "applied")?.value).toBe(0);
    expect(observations.find((o) => o.state === "pending")?.value).toBe(1);
    expect(observations.find((o) => o.state === "failed")?.value).toBe(0);
  });

  it("observes applied=0 pending=0 failed=1 when the query throws", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => {
        throw new Error("connection refused");
      },
    );
    await callback(result);

    expect(observations).toHaveLength(3);
    expect(observations.find((o) => o.state === "applied")?.value).toBe(0);
    expect(observations.find((o) => o.state === "pending")?.value).toBe(0);
    expect(observations.find((o) => o.state === "failed")?.value).toBe(1);
  });

  it("callback does not throw even when the query throws", async () => {
    const { result } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => {
        throw new Error("total failure");
      },
    );
    await expect(callback(result)).resolves.toBeUndefined();
  });

  it("treats applied >= totalMigrations as fully applied (e.g. 0 migrations total)", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      0, // no migrations expected
      async () => 0,
    );
    await callback(result);

    expect(observations.find((o) => o.state === "applied")?.value).toBe(1);
    expect(observations.find((o) => o.state === "pending")?.value).toBe(0);
  });

  it("emits exactly the three state labels on every invocation", async () => {
    const { result, observations } = makeObservableResult();
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => 9,
    );
    await callback(result);

    const states = observations.map((o) => o.state).sort();
    expect(states).toEqual(["applied", "failed", "pending"]);
  });
});

// ---------------------------------------------------------------------------
// 3. createDbMigrationStatusCallback — re-entrancy guard
// ---------------------------------------------------------------------------

describe("createDbMigrationStatusCallback — re-entrancy guard", () => {
  it("skips a second concurrent invocation while the first is in-flight", async () => {
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstComplete = false;

    const { result: r1, observations: obs1 } = makeObservableResult();
    const { result: r2, observations: obs2 } = makeObservableResult();

    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => {
        resolveFirst();
        // Pause to simulate a slow DB query
        await new Promise<void>((res) => setTimeout(res, 20));
        firstComplete = true;
        return 9;
      },
    );

    const first = callback(r1);
    await firstStarted; // first is now in-flight

    // Second call while first is still running — should be skipped
    await callback(r2);
    expect(obs2).toHaveLength(0); // skipped

    await first;
    expect(firstComplete).toBe(true);
    expect(obs1).toHaveLength(3);
  });

  it("allows a second invocation after the first has completed", async () => {
    const { result: r1 } = makeObservableResult();
    const { result: r2, observations: obs2 } = makeObservableResult();

    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => 9,
    );

    await callback(r1);
    await callback(r2);

    expect(obs2).toHaveLength(3);
  });

  it("re-entrancy guard is released even when the query throws", async () => {
    const { result: r1 } = makeObservableResult();
    const { result: r2, observations: obs2 } = makeObservableResult();

    let calls = 0;
    const callback = createDbMigrationStatusCallback(
      makeStubPool(),
      9,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("first call fails");
        return 9;
      },
    );

    await callback(r1); // throws internally, but guard must be released
    await callback(r2); // must be allowed

    expect(obs2).toHaveLength(3);
  });
});
