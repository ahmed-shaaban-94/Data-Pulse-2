/**
 * idempotency-mismatch.filter.unit.spec.ts
 *
 * Docker-free unit coverage for IdempotencyMismatchFilter.
 *
 * Strategy: construct the filter directly (no DI container), supply hand-
 * built ArgumentsHost fakes, and assert on the audit-enqueue payload +
 * the re-thrown exception.
 *
 * Mirrors the proven pattern in `apps/api/test/common/exception.filter.unit.spec.ts`.
 * Does NOT use the broken APP_INTERCEPTOR + TestingModule harness shared by
 * `retry-mismatch.spec.ts` and `metrics.spec.ts` (whose mismatch cases are
 * skipped pending a harness refactor in 005-WAVE1-METRICS-MISMATCH-FOLLOWUP).
 *
 * Covers the four branches of `catch()`:
 *   IMF1 — non-matching code (e.g. "alias_conflict") → re-throw, no side effects
 *   IMF2 — matching code + enqueuer wired → counter fires, audit enqueued, re-throw
 *   IMF3 — matching code + enqueuer null (constructor @Optional fallback)
 *          → counter fires, no audit, re-throw
 *   IMF4 — matching code + enqueuer throws → swallow, counter still fires, re-throw
 *
 * Coverage restored: the four `if` / `try-catch` branches in the filter that
 * were previously exercised (badly) by the integration-test harness whose
 * mismatch cases are now skipped.
 */
import "reflect-metadata";

import { ArgumentsHost, ConflictException } from "@nestjs/common";

import { IdempotencyMismatchFilter } from "../../../../src/catalog/unknown-items/filters/idempotency-mismatch.filter";
import type {
  AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(req: object): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => ({} as unknown as T),
    }),
  } as unknown as ArgumentsHost;
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("IdempotencyMismatchFilter (unit, no harness)", () => {
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

  // IMF1 — non-matching code: re-throw immediately, no side effects.
  it("re-throws non-matching 409 without firing telemetry", async () => {
    const enqueuer = new FakeEnqueuer();
    const filter = new IdempotencyMismatchFilter(enqueuer);
    const exception = NON_MATCHING_EXCEPTION();
    const host = makeHost(REQUEST_SHAPE);

    await expect(filter.catch(exception, host)).rejects.toBe(exception);

    expect(mismatchCounter).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });

  // IMF2 — matching code + enqueuer wired: counter fires, audit enqueued, re-throw.
  it("on matching 409: increments counter, enqueues audit, re-throws", async () => {
    const enqueuer = new FakeEnqueuer();
    const filter = new IdempotencyMismatchFilter(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const host = makeHost(REQUEST_SHAPE);

    await expect(filter.catch(exception, host)).rejects.toBe(exception);

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

  // IMF3 — matching code + enqueuer null (constructor @Optional fallback).
  it("on matching 409 with no enqueuer: counter fires, no audit, re-throws", async () => {
    const filter = new IdempotencyMismatchFilter(null);
    const exception = MATCHING_EXCEPTION();
    const host = makeHost(REQUEST_SHAPE);

    await expect(filter.catch(exception, host)).rejects.toBe(exception);

    expect(mismatchCounter).toBe(1);
  });

  // IMF4 — matching code + enqueuer throws: swallow, counter still fires, re-throw.
  it("on enqueue failure: swallows error, counter still fires, re-throws original 409", async () => {
    const enqueuer = new ThrowingEnqueuer();
    const filter = new IdempotencyMismatchFilter(enqueuer);
    const exception = MATCHING_EXCEPTION();
    const host = makeHost(REQUEST_SHAPE);

    // The original ConflictException must propagate, NOT the BullMQ error.
    await expect(filter.catch(exception, host)).rejects.toBe(exception);

    expect(mismatchCounter).toBe(1);
    expect(enqueuer.callCount).toBe(1);
  });

  // IMF5 — request fields absent: payload tolerates missing context/principal.
  it("tolerates absent request.context and request.principal (nullable payload fields)", async () => {
    const enqueuer = new FakeEnqueuer();
    const filter = new IdempotencyMismatchFilter(enqueuer);
    const exception = MATCHING_EXCEPTION();
    // Minimal request shape — no context, no principal, no requestId.
    const host = makeHost({});

    await expect(filter.catch(exception, host)).rejects.toBe(exception);

    expect(enqueuer.calls).toHaveLength(1);
    const payload = enqueuer.calls[0]!;
    expect(payload.tenant_id).toBeNull();
    expect(payload.store_id).toBeNull();
    expect(payload.actor_user_id).toBeNull();
    expect(payload.request_id).toBeNull();
  });
});
