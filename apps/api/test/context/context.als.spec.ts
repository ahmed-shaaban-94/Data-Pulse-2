/**
 * T151 — context.als spec.
 *
 * Pure unit tests for the AsyncLocalStorage primitive. Covers:
 *   - reads outside any `runInContext` return `undefined`
 *   - reads inside `runInContext` return the supplied ctx
 *   - the ctx survives `await` boundaries (Node ALS guarantee)
 *   - concurrent invocations are isolated (each `run` sees only its
 *     own ctx, never another's)
 *   - errors inside `fn` propagate and the scope still tears down
 *   - synchronous `fn` works too (no `await` required)
 *
 * No Nest, no DB, no network.
 */
import {
  getResolvedContext,
  runInContext,
} from "../../src/context/context.als";
import type { ResolvedContext } from "../../src/context/types";

const CTX_A: ResolvedContext = {
  userId: "00000000-0000-7000-8000-00000000aa01",
  tenantId: "00000000-0000-7000-8000-0000000ten01",
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

const CTX_B: ResolvedContext = {
  userId: "00000000-0000-7000-8000-00000000bb02",
  tenantId: "00000000-0000-7000-8000-0000000ten02",
  storeId: "00000000-0000-7000-8000-00000000st02",
  isPlatformAdmin: false,
  source: "token",
};

describe("getResolvedContext — outside any scope", () => {
  it("returns undefined", () => {
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("runInContext — synchronous fn", () => {
  it("makes ctx visible inside fn", () => {
    const seen = runInContext(CTX_A, () => getResolvedContext());
    expect(seen).toBe(CTX_A);
  });

  it("returns the value fn returns", () => {
    const out = runInContext(CTX_A, () => 42);
    expect(out).toBe(42);
  });

  it("clears the ctx after fn returns", () => {
    runInContext(CTX_A, () => getResolvedContext());
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("runInContext — async fn (await propagation)", () => {
  it("preserves ctx across await", async () => {
    const seen = await runInContext(CTX_A, async () => {
      await Promise.resolve();
      const before = getResolvedContext();
      await new Promise((r) => setImmediate(r));
      const after = getResolvedContext();
      return { before, after };
    });
    expect(seen.before).toBe(CTX_A);
    expect(seen.after).toBe(CTX_A);
  });

  it("preserves ctx across nested awaits", async () => {
    const seen = await runInContext(CTX_A, async () => {
      const deep = await Promise.resolve().then(() =>
        Promise.resolve().then(() => getResolvedContext()),
      );
      return deep;
    });
    expect(seen).toBe(CTX_A);
  });

  it("clears ctx after the awaited fn settles", async () => {
    await runInContext(CTX_A, async () => {
      await Promise.resolve();
    });
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("runInContext — concurrent isolation", () => {
  it("two concurrent runs never see each other's ctx", async () => {
    const seenA: Array<ResolvedContext | undefined> = [];
    const seenB: Array<ResolvedContext | undefined> = [];

    const runA = runInContext(CTX_A, async () => {
      await Promise.resolve();
      seenA.push(getResolvedContext());
      await new Promise((r) => setImmediate(r));
      seenA.push(getResolvedContext());
    });

    const runB = runInContext(CTX_B, async () => {
      await new Promise((r) => setImmediate(r));
      seenB.push(getResolvedContext());
      await Promise.resolve();
      seenB.push(getResolvedContext());
    });

    await Promise.all([runA, runB]);

    expect(seenA.every((c) => c === CTX_A)).toBe(true);
    expect(seenB.every((c) => c === CTX_B)).toBe(true);
    expect(seenA).toHaveLength(2);
    expect(seenB).toHaveLength(2);
  });

  it("nested runInContext shadows the outer ctx and restores on exit", async () => {
    await runInContext(CTX_A, async () => {
      expect(getResolvedContext()).toBe(CTX_A);
      await runInContext(CTX_B, async () => {
        await Promise.resolve();
        expect(getResolvedContext()).toBe(CTX_B);
      });
      expect(getResolvedContext()).toBe(CTX_A);
    });
    expect(getResolvedContext()).toBeUndefined();
  });
});

describe("runInContext — error propagation", () => {
  it("propagates synchronous errors and tears down the scope", () => {
    expect(() =>
      runInContext(CTX_A, () => {
        throw new Error("boom-sync");
      }),
    ).toThrow("boom-sync");
    expect(getResolvedContext()).toBeUndefined();
  });

  it("propagates asynchronous errors and tears down the scope", async () => {
    await expect(
      runInContext(CTX_A, async () => {
        await Promise.resolve();
        throw new Error("boom-async");
      }),
    ).rejects.toThrow("boom-async");
    expect(getResolvedContext()).toBeUndefined();
  });
});
