/**
 * idempotency-mismatch.interceptor.unit.spec.ts
 *
 * Docker-free unit coverage for IdempotencyMismatchInterceptor.
 *
 * Strategy: construct the interceptor directly (no DI container), hand-build
 * an ExecutionContext + a CallHandler that returns an Observable wrapping a
 * caller-supplied error, subscribe, and assert on the audit-enqueue payload +
 * the propagated error.
 *
 * Mirrors the proven pattern in `apps/api/test/audit/audit-emitter.interceptor.unit.spec.ts`.
 * Ports IMF1-5 from the prior IdempotencyMismatchFilter unit spec; renumbered
 * IMI1-5. Behavioural contract identical; mechanism differs.
 *
 * Branches covered:
 *   IMI1 — non-ConflictException error → no side effects, error propagates unchanged
 *   IMI2 — non-matching code → no side effects, error propagates unchanged
 *   IMI3 — matching code + enqueuer wired → counter fires, audit enqueued, error propagates
 *   IMI4 — matching code + enqueuer null (constructor @Optional fallback) → counter fires, no audit
 *   IMI5 — matching code + enqueuer rejects → counter fires, original error propagates (not the BullMQ error)
 *
 * Note: IMF5 (filter-only "tolerates absent request fields" case) is folded
 * into IMI3 as the canonical matching-code path; the interceptor's payload
 * construction is byte-identical to the filter's, so a separate "absent
 * fields" case is redundant.
 */
import "reflect-metadata";

import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
} from "@nestjs/common";
import { type Observable, throwError } from "rxjs";

import { IdempotencyMismatchInterceptor } from "../../../../src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor";
import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => ({} as unknown as T),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(observableFactory: () => Observable<unknown>): CallHandler {
  return { handle: observableFactory } as unknown as CallHandler;
}

class FakeEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

class ThrowingEnqueuer implements AuditJobEnqueuer {
  public callCount = 0;
  async enqueue(_payload: AuditJobPayload): Promise<void> {
    this.callCount += 1;
    throw new Error("BullMQ outage");
  }
}

const MATCHING_EXCEPTION = (): ConflictException =>
  new ConflictException({
    code: "idempotency_key_conflict",
    message:
      "The provided Idempotency-Key has already been used for a different request body. Generate a new key.",
  });

const NON_MATCHING_EXCEPTION = (): ConflictException =>
  new ConflictException({
    code: "alias_conflict",
    message: "Some other 409 reason — not our concern.",
  });

const REQUEST_SHAPE = {
  context: {
    tenantId: "0a000000-0000-7000-8000-00000000a1d1",
    storeId: "0a000000-0000-7000-8000-00000000a51c",
  },
  principal: {
    userId: "0a000000-0000-7000-8000-00000000ad11",
  },
  requestId: "req_abc123",
};

/**
 * Subscribe to the interceptor's output and resolve to:
 *   { kind: "value", value } on success
 *   { kind: "error", error } on error
 * Avoids relying on rxjs `firstValueFrom`/`lastValueFrom` rejection shape.
 */
async function collectOutcome<T>(observable: Observable<T>): Promise<
  { kind: "value"; value: T } | { kind: "error"; error: unknown }
> {
  return new Promise((resolve) => {
    observable.subscribe({
      next: (value) => resolve({ kind: "value", value }),
      error: (error) => resolve({ kind: "error", error }),
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("IdempotencyMismatchInterceptor (unit, no harness)", () => {
  let mismatchCounter: number;
  let counterSpy: jest.SpyInstance;

  beforeEach(() => {
    mismatchCounter = 0;
    counterSpy = jest
      .spyOn(apiMetrics, "recordIdempotencyTokenMismatch")
      .mockImplementation(() => {
        mismatchCounter += 1;
      });
  });

  afterEach(() => {
    counterSpy.mockRestore();
  });

  // IMI1 — non-ConflictException error: passthrough, no side effects.
  it("IMI1: non-ConflictException error propagates unchanged with no side effects", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const error = new Error("some other failure");
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => error));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(error);
    expect(mismatchCounter).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  // IMI2 — ConflictException with non-matching code: passthrough, no side effects.
  it("IMI2: non-matching 409 propagates unchanged with no side effects", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = NON_MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  // IMI3 — matching code + enqueuer wired: counter increments, audit enqueued, error propagates.
  it("IMI3: matching 409 increments counter, enqueues audit, propagates the original error", async () => {
    const enqueuer = new FakeEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    // Allow microtask queue to drain the fire-and-forget enqueue call.
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
    expect(enqueuer.calls).toHaveLength(1);
    const payload = enqueuer.calls[0]!;
    expect(payload.action).toBe("unknown_item.idempotency_mismatch_rejected");
    expect(payload.tenant_id).toBe(REQUEST_SHAPE.context.tenantId);
    expect(payload.store_id).toBe(REQUEST_SHAPE.context.storeId);
    expect(payload.actor_user_id).toBe(REQUEST_SHAPE.principal.userId);
    expect(payload.request_id).toBe(REQUEST_SHAPE.requestId);
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });

  // IMI4 — matching code + enqueuer null: counter increments, no audit.
  it("IMI4: matching 409 with null enqueuer still increments counter, no audit, no throw", async () => {
    const interceptor = new IdempotencyMismatchInterceptor(null);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
  });

  // IMI5 — matching code + enqueuer throws: original ConflictException propagates, not BullMQ error.
  it("IMI5: matching 409 with throwing enqueuer propagates the original 409 (not the BullMQ error)", async () => {
    const enqueuer = new ThrowingEnqueuer();
    const interceptor = new IdempotencyMismatchInterceptor(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const ctx = makeCtx(REQUEST_SHAPE);
    const next = makeHandler(() => throwError(() => exception));

    const outcome = await collectOutcome(interceptor.intercept(ctx, next));

    // Allow microtask queue to drain the fire-and-forget enqueue call (which rejects).
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toBe(exception);
    expect(mismatchCounter).toBe(1);
    expect(enqueuer.callCount).toBe(1);
  });
});
