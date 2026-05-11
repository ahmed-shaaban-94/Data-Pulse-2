/**
 * context.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for ContextInterceptor.
 *
 * Strategy: construct ContextInterceptor directly (no Nest module).
 * Mock `runInContext` from `../../src/context/context.als` so no real
 * AsyncLocalStorage scope is entered. Verify the interceptor's branching
 * logic — pass-through when ctx is absent vs. ALS wrapping when ctx is
 * present.
 *
 * Tests:
 *   CI1 — ctx absent  → returns next.handle() Observable; runInContext NOT called
 *   CI2 — ctx present → runInContext IS called with the resolved context
 *   CI3 — ctx present, runInContext resolves value → Observable emits that value
 *   CI4 — ctx present, next.handle() throws → Observable errors
 *   CI5 — ctx absent,  next.handle() throws → Observable errors (passthrough)
 *   CI6 — ctx present → next.handle() called exactly once
 */
import "reflect-metadata";

import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { of, throwError } from "rxjs";
import { firstValueFrom } from "rxjs";

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing anything that depends on it
// ---------------------------------------------------------------------------

jest.mock("../../src/context/context.als", () => ({
  runInContext: jest.fn(),
}));

// Import AFTER mock registration
import { runInContext } from "../../src/context/context.als";
import { ContextInterceptor } from "../../src/context/context.interceptor";
import type { ResolvedContext } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed context object
// ---------------------------------------------------------------------------

const RESOLVED_CTX: ResolvedContext = {
  userId: "0a000000-0000-7000-8000-00000000aa01",
  tenantId: "0a000000-0000-7000-8000-0000000ten01",
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeExecCtx(ctx?: ResolvedContext): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ context: ctx }),
    }),
  } as unknown as ExecutionContext;
}

function makeNext(value: unknown): CallHandler {
  return {
    handle: () => of(value),
  } as CallHandler;
}

function makeThrowingNext(err: unknown): CallHandler {
  return {
    handle: () => throwError(() => err),
  } as CallHandler;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let interceptor: ContextInterceptor;
const runInContextMock = runInContext as jest.Mock;

beforeEach(() => {
  interceptor = new ContextInterceptor();
  runInContextMock.mockReset();
  // Default: execute the callback so tests that want realistic behaviour get it
  runInContextMock.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
});

// ---------------------------------------------------------------------------
// CI1 — ctx absent → returns next.handle() Observable; runInContext NOT called
// ---------------------------------------------------------------------------

describe("CI1 — ctx absent: passthrough, runInContext not called", () => {
  it("returns next.handle() observable without entering ALS", async () => {
    const next = makeNext("raw-value");
    const obs = interceptor.intercept(makeExecCtx(undefined), next);
    const result = await firstValueFrom(obs);
    expect(result).toBe("raw-value");
    expect(runInContextMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CI2 — ctx present → runInContext IS called with ctx
// ---------------------------------------------------------------------------

describe("CI2 — ctx present: runInContext called with resolved context", () => {
  it("calls runInContext with the request context object", async () => {
    const next = makeNext("some-value");
    const obs = interceptor.intercept(makeExecCtx(RESOLVED_CTX), next);
    await firstValueFrom(obs);
    expect(runInContextMock).toHaveBeenCalledTimes(1);
    expect(runInContextMock).toHaveBeenCalledWith(RESOLVED_CTX, expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// CI3 — ctx present, runInContext resolves value → Observable emits that value
// ---------------------------------------------------------------------------

describe("CI3 — ctx present: emits resolved value", () => {
  it("emits the value produced by the handler inside the ALS scope", async () => {
    const PAYLOAD = { tenant_id: "abc", active: true };
    const next = makeNext(PAYLOAD);
    const obs = interceptor.intercept(makeExecCtx(RESOLVED_CTX), next);
    const result = await firstValueFrom(obs);
    expect(result).toEqual(PAYLOAD);
  });
});

// ---------------------------------------------------------------------------
// CI4 — ctx present, next.handle() throws → Observable errors
// ---------------------------------------------------------------------------

describe("CI4 — ctx present: error propagates through ALS scope", () => {
  it("re-emits handler error as Observable error notification", async () => {
    const boom = new Error("handler exploded");
    const next = makeThrowingNext(boom);
    const obs = interceptor.intercept(makeExecCtx(RESOLVED_CTX), next);
    await expect(firstValueFrom(obs)).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// CI5 — ctx absent, next.handle() throws → Observable errors (passthrough)
// ---------------------------------------------------------------------------

describe("CI5 — ctx absent: error passthrough", () => {
  it("propagates error unchanged when ctx is absent", async () => {
    const boom = new Error("upstream failure");
    const next = makeThrowingNext(boom);
    const obs = interceptor.intercept(makeExecCtx(undefined), next);
    await expect(firstValueFrom(obs)).rejects.toBe(boom);
    expect(runInContextMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CI6 — ctx present → next.handle() called exactly once
// ---------------------------------------------------------------------------

describe("CI6 — ctx present: next.handle() called exactly once", () => {
  it("subscribes to the downstream handler exactly one time", async () => {
    const handleFn = jest.fn(() => of("result"));
    const next: CallHandler = { handle: handleFn };
    const obs = interceptor.intercept(makeExecCtx(RESOLVED_CTX), next);
    // Subscribe to trigger the defer() lazy evaluation
    await firstValueFrom(obs);
    expect(handleFn).toHaveBeenCalledTimes(1);
  });
});
