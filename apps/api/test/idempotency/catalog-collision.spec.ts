/**
 * Catalog-collision branch coverage — IdempotencyInterceptor.
 *
 * Context (005-WAVE1-METRICS-MISMATCH-FOLLOWUP, PR #389 "Option A"):
 *   The collision branch of `IdempotencyInterceptor.handle()` was extended to
 *   fire catalog-domain side effects INLINE — the FR-021c
 *   `recordIdempotencyTokenMismatch()` counter and the FR-082
 *   `unknown_item.idempotency_mismatch_rejected` audit subject — but ONLY for
 *   the 005 unknown-items capture route (`POST /api/pos/v1/catalog/unknown-items`).
 *
 * The integration spec `test/catalog/unknown-items/idempotency/retry-mismatch.spec.ts`
 * exercises the *happy* shape of that branch (route matches, enqueuer wired and
 * RESOLVING, `principal`/`context` always populated by its guards). That leaves
 * several branches in the audit block uncovered:
 *
 *   1. `principal?.userId` when `principal` is undefined.
 *   2. `ctx?.tenantId` / `ctx?.storeId` when `context` is undefined.
 *   3. the `.catch()` rejection handler on a FAILING `enqueue()`.
 *   4. `this.logger?.error(...)` when a logger IS present, and the implicit
 *      no-op arm when it is absent.
 *
 * This Docker-free unit spec drives the interceptor directly (no Nest app, no
 * controller, no Testcontainers) so it runs in the `fast` CI job and pins those
 * branches deterministically. It also asserts the route-scoping invariant added
 * to resolve the CodeRabbit "scope catalog telemetry" review finding: catalog
 * side effects must NOT fire on a non-capture idempotent route.
 *
 * The negative arm (`isUnknownItemsCaptureRoute === false`, enqueuer null) is
 * additionally covered by `conflict.spec.ts` on the invite route; one case here
 * makes the route-scoping contract explicit at the unit level.
 */
import "reflect-metadata";

import {
  ConflictException,
  type CallHandler,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { firstValueFrom } from "rxjs";

import { IdempotencyKeyStore, type Logger } from "@data-pulse-2/shared";

import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import {
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import {
  IDEMPOTENT_OPTIONS_KEY,
  IDEMPOTENT_POLICY_KEY,
} from "../../src/idempotency/idempotent.decorator";
import { InProgressMarker } from "../../src/idempotency/in-progress-marker";
import type { ResolvedContext } from "../../src/context/types";
import * as apiMetrics from "../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPTURE_ROUTE = "/api/pos/v1/catalog/unknown-items";
const NON_CATALOG_ROUTE = "/api/v1/memberships/invite";
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Marker that always grants ownership and no-ops on delete. */
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

/** A store whose findOrCreate always reports a payload collision. */
class CollisionStore {
  async findOrCreate(): Promise<{ hit: "collision" }> {
    return { hit: "collision" };
  }
}

/** Enqueuer that rejects — drives the fire-and-forget `.catch()` arm. */
class RejectingEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
    throw new Error("simulated BullMQ outage");
  }
}

/** Enqueuer that resolves — used for the route-scoping negative case. */
class ResolvingEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

// ---------------------------------------------------------------------------
// ExecutionContext builder
// ---------------------------------------------------------------------------

interface BuildReqOpts {
  routePath: string;
  principal?: { userId?: string };
  context?: ResolvedContext;
  requestId?: string;
}

function buildExecCtx(opts: BuildReqOpts): ExecutionContext {
  const req: Record<string, unknown> = {
    method: "POST",
    route: { path: opts.routePath },
    url: opts.routePath,
    headers: { "idempotency-key": IDEMP_KEY },
    body: { identifier_type: "barcode", identifier_value: "X" },
  };
  if (opts.principal !== undefined) req["principal"] = opts.principal;
  if (opts.context !== undefined) req["context"] = opts.context;
  if (opts.requestId !== undefined) req["requestId"] = opts.requestId;

  const res = {
    status: () => undefined,
    setHeader: () => undefined,
    json: () => undefined,
    headersSent: false,
    statusCode: 200,
  };

  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as T,
      getResponse: <T>() => res as T,
    }),
    // `@Idempotent("required")` metadata — the interceptor reads these off the
    // handler via Reflector.get; a bare object handler with reflect-metadata
    // attached satisfies the lookup below.
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

// A handler function carrying the @Idempotent metadata the interceptor reads.
function handler(): void {
  /* never invoked — collision short-circuits before next.handle() */
}
Reflect.defineMetadata(IDEMPOTENT_POLICY_KEY, "required", handler);
Reflect.defineMetadata(IDEMPOTENT_OPTIONS_KEY, {}, handler);

/** A CallHandler whose handle() must never be subscribed on the collision path. */
function neverHandler(): CallHandler {
  return {
    handle: () => {
      throw new Error("next.handle() must not run on the collision branch");
    },
  };
}

function makeStore(): IdempotencyKeyStore {
  // The real IdempotencyKeyStore is bypassed — we override findOrCreate with a
  // collision-returning stub. Only `findOrCreate` is exercised on this path.
  return new CollisionStore() as unknown as IdempotencyKeyStore;
}

/** Subscribe to the interceptor's observable and capture the thrown error. */
async function runAndCaptureError(
  interceptor: IdempotencyInterceptor,
  ctx: ExecutionContext,
): Promise<unknown> {
  try {
    await firstValueFrom(interceptor.intercept(ctx, neverHandler()));
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("IdempotencyInterceptor — catalog-collision branch coverage", () => {
  let mismatchSpy: jest.SpyInstance;
  let mismatchCount: number;

  beforeEach(() => {
    mismatchCount = 0;
    mismatchSpy = jest
      .spyOn(apiMetrics, "recordIdempotencyTokenMismatch")
      .mockImplementation(() => {
        mismatchCount += 1;
      });
    // recordIdempotencyConflict is the platform-axis counter; silence it.
    jest.spyOn(apiMetrics, "recordIdempotencyConflict").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("capture route + rejecting enqueuer + undefined principal/context: fires counter, builds null-actor audit payload, swallows enqueue rejection (logger present)", async () => {
    const enqueuer = new RejectingEnqueuer();
    const errorLogs: unknown[] = [];
    const logger = {
      error: (...args: unknown[]) => {
        errorLogs.push(args);
      },
    } as unknown as Logger;

    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      makeStore(),
      new FakeMarker() as unknown as InProgressMarker,
      enqueuer,
      logger,
    );

    const ctx = buildExecCtx({ routePath: CAPTURE_ROUTE });
    const err = await runAndCaptureError(interceptor, ctx);

    // Contract: still a 409 ConflictException — audit failure must NOT replace it.
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "idempotency_key_conflict",
    });

    // FR-021c counter fired on the capture route.
    expect(mismatchCount).toBe(1);

    // FR-082 audit enqueued exactly once, with null actor/tenant/store because
    // principal + context were absent (covers the `?.` null-arms).
    expect(enqueuer.calls).toHaveLength(1);
    const payload = enqueuer.calls[0]!;
    expect(payload.action).toBe("unknown_item.idempotency_mismatch_rejected");
    expect(payload.actor_user_id).toBeNull();
    expect(payload.tenant_id).toBeNull();
    expect(payload.store_id).toBeNull();
    expect(payload.request_id).toBeNull();

    // The enqueue rejection was caught and logged (covers `.catch` + logger?. present).
    // Drain microtasks so the fire-and-forget .catch() settles.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(errorLogs).toHaveLength(1);
  });

  it("capture route + rejecting enqueuer + NO logger: rejection still swallowed (covers logger?. absent arm)", async () => {
    const enqueuer = new RejectingEnqueuer();
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      makeStore(),
      new FakeMarker() as unknown as InProgressMarker,
      enqueuer,
      // logger omitted → undefined
    );

    const ctx = buildExecCtx({
      routePath: CAPTURE_ROUTE,
      principal: { userId: "user-1" },
      context: {
        userId: "user-1",
        tenantId: "tenant-1",
        storeId: "store-1",
        isPlatformAdmin: false,
        source: "token",
      },
      requestId: "req-1",
    });
    const err = await runAndCaptureError(interceptor, ctx);

    expect(err).toBeInstanceOf(ConflictException);
    expect(mismatchCount).toBe(1);
    expect(enqueuer.calls).toHaveLength(1);

    // populated arms of the `?.` chains (the truthy side).
    const payload = enqueuer.calls[0]!;
    expect(payload.actor_user_id).toBe("user-1");
    expect(payload.tenant_id).toBe("tenant-1");
    expect(payload.store_id).toBe("store-1");
    expect(payload.request_id).toBe("req-1");

    // No throw escaped despite missing logger — `.catch` ran with logger?. = no-op.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("non-catalog idempotent route: catalog counter + audit do NOT fire (route-scoping invariant)", async () => {
    const enqueuer = new ResolvingEnqueuer();
    const interceptor = new IdempotencyInterceptor(
      new Reflector(),
      makeStore(),
      new FakeMarker() as unknown as InProgressMarker,
      enqueuer,
    );

    const ctx = buildExecCtx({
      routePath: NON_CATALOG_ROUTE,
      principal: { userId: "user-1" },
    });
    const err = await runAndCaptureError(interceptor, ctx);

    // Still a 409 — the platform conflict outcome is route-agnostic.
    expect(err).toBeInstanceOf(ConflictException);
    // But the catalog-domain side effects are gated out.
    expect(mismatchCount).toBe(0);
    expect(enqueuer.calls).toHaveLength(0);
  });
});
