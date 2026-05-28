/**
 * T552 / T553 -- 005-WAVE1-METRICS -- counter-increment emission.
 *
 * Acceptance (slice 005-WAVE1-METRICS validation contract):
 *   GREEN -- FR-081 counter increments at all 3 emission sites:
 *     - successful capture increments `unknown_item_captured_total`
 *     - dismiss increments `unknown_item_resolved_total{action='dismissed'}`
 *     - idempotency-key mismatch increments `idempotency_token_mismatch_total`
 *
 * TDD discipline:
 *   T552 (RED): this spec was written first. Of the three counters:
 *     - `unknown_item_captured_total` was already wired in T511
 *       (UnknownItemsService.captureItem line ~479: `recordUnknownItemCaptured()`
 *       on the `result.inserted` branch) -- assertion passes immediately.
 *     - `idempotency_token_mismatch_total` was already wired in T533, and
 *       re-homed by `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` PR 2 into the
 *       `IdempotencyInterceptor` collision branch (inline, route-scoped to the
 *       capture path) -- `recordIdempotencyTokenMismatch()` -- assertion passes.
 *     - `unknown_item_resolved_total{action='dismissed'}` was explicitly
 *       deferred (service.ts docstring at the dismissUnknownItem `ok` branch
 *       says "The METRICS slice T552/T553 authors the explicit counter
 *       increment") -- assertion failed RED on first run.
 *   T553 (GREEN): added `recordUnknownItemResolved({ action: "dismissed" })`
 *     to `dismissUnknownItem` on the `result.kind === "ok"` branch before
 *     `return result.row`. That single call-site addition turned all three
 *     assertions GREEN.
 *
 * Counter-observation strategy:
 *   The OTel Meter returned by `getMeter("api")` is a no-op until a
 *   MetricReader is registered, so direct meter inspection won't yield
 *   numeric values in the test environment. Instead, we spy on the
 *   emission helpers in `api.metrics.ts` -- the established pattern from
 *   `capture-happy-path.spec.ts` (captureCounter + jest.spyOn) and
 *   `retry-mismatch.spec.ts` (mismatchCounter + jest.spyOn). The spy
 *   intercepts the helper call BEFORE the no-op meter, counting emissions
 *   without requiring a live MetricReader.
 *
 * App wiring:
 *   Mirrors `retry-mismatch.spec.ts` (the most complete prior Wave 1
 *   spec): real UnknownItemsController + UnknownItemsService against a
 *   Testcontainers pg.Pool, real IdempotencyInterceptor (constructed with
 *   the spy AuditJobEnqueuer so its inline collision-branch catalog audit
 *   lands on the spy), real AuditEmitterInterceptor, spy AuditJobEnqueuer.
 *   This wiring exercises all three emission paths from a single module
 *   fixture.
 *
 *   Dismiss does NOT carry `@Idempotent("required")` so the
 *   IdempotencyInterceptor is a no-op on that route. The mismatch counter +
 *   audit fire inline on the interceptor's collision branch, route-scoped to
 *   the `posCaptureItem` path (`005-WAVE1-METRICS-MISMATCH-FOLLOWUP` PR 2).
 *
 * Docker: Testcontainers Postgres 16 required; honors
 * `MIGRATION_TEST_ALLOW_SKIP=1` per repo convention.
 *
 * Spec anchors: FR-081, plan §3.4, tasks.md T552 / T553.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  STORE_A_X,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005c1";
const IDEMP_KEY_CAPTURE = "aabbccdd11223344aabbccdd11223344";
const IDEMP_KEY_MISMATCH = "11223344aabbccdd11223344aabbccdd";
const CAPTURE_VALUE = "T552-METRICS-CAPTURE-001";
const MISMATCH_VALUE_FIRST = "T552-METRICS-MISMATCH-FIRST-001";
const MISMATCH_VALUE_SECOND = "T552-METRICS-MISMATCH-SECOND-001";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker -- same minimal pattern used across Wave 1 specs
// ---------------------------------------------------------------------------

class FakeRedis {
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(
    key: string,
    value: string,
    options: { px: number },
  ): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeMarker {
  async trySet(_tuple: string, _ttl?: number): Promise<boolean> {
    return true;
  }
  async del(_tuple: string): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// ConfigurableContextGuard -- mirrors capture-audit.spec.ts / retry-mismatch
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string = DEVICE_USER_ID;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer -- needed by AuditEmitterInterceptor + MismatchFilter
// ---------------------------------------------------------------------------

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

// Per-test metric spy handles (attached in beforeEach, restored in afterEach)
let capturedSpy: jest.SpyInstance;
let resolvedSpy: jest.SpyInstance;
let mismatchSpy: jest.SpyInstance;

// Per-test counters (reset to 0 in beforeEach)
let capturedCount = 0;
let resolvedCount = 0;
let mismatchCount = 0;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedUnknownItemsFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T552 metrics.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const localEnv = env;
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const idempStore = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: {
      async find() {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  // Pass auditSpy as the 4th constructor arg so the inlined catalog-domain
  // audit emit on IdempotencyInterceptor's collision branch lands on the spy.
  // Required for the T551/T552-mismatch cases that exercise the mismatch path.
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
    auditSpy,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // PG_POOL bound to admin (superuser, RLS-bypassed) — this spec asserts
      // Prometheus counter increment verification — admin isolates the metric
      // assertion from RLS plumbing, not the data-access path. RLS coverage
      // for the data path is asserted by capture-happy-path.spec.ts. Pattern:
      // dismiss-audit.spec.ts:162-164.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useClass: AuditEmitterInterceptor },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice
    // (UnknownItemsController has no class-level guards because the POS
    // capture route uses a different auth model). Tests inject context via
    // the global ConfigurableContextGuard (registered below); override the
    // production guards with no-op pass-throughs so the global guard's
    // context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;

  // Reset state and re-attach spies each test.
  // Jest's restoreMocks:true resets spies between tests; re-attach here
  // mirrors the pattern in capture-happy-path.spec.ts:280 and
  // retry-mismatch.spec.ts:288.
  capturedCount = 0;
  resolvedCount = 0;
  mismatchCount = 0;

  capturedSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemCaptured")
    .mockImplementation(() => {
      capturedCount += 1;
    });

  resolvedSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemResolved")
    .mockImplementation(() => {
      resolvedCount += 1;
    });

  mismatchSpy = jest
    .spyOn(apiMetrics, "recordIdempotencyTokenMismatch")
    .mockImplementation(() => {
      mismatchCount += 1;
    });

  fakeRedis.clear();
  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = DEVICE_USER_ID;
});

afterEach(async () => {
  // Guards handle the case where beforeAll soft-skipped (no Docker) and the
  // spies were never attached in beforeEach. Mirrors how retry-mismatch.spec.ts
  // calls mismatchSpy.mockRestore() only after it was unconditionally created.
  capturedSpy?.mockRestore();
  resolvedSpy?.mockRestore();
  mismatchSpy?.mockRestore();

  if (dockerSkipped || !env) return;
  // Clean up rows created by capture tests in this suite only.
  await env.admin.query(
    "DELETE FROM unknown_items WHERE value LIKE 'T552-METRICS-%'",
  );
  // Reset the dismiss fixture row back to pending after each dismiss test.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending',
            resolution_action = NULL,
            resolved_at       = NULL,
            resolved_by       = NULL,
            resolved_product_id = NULL
      WHERE id = ANY($1)`,
    [
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      ],
    ],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T552-A -- capture increments `unknown_item_captured_total`
// ---------------------------------------------------------------------------

describe("T552 / 005-WAVE1-METRICS -- capture emission", () => {
  it("posCaptureItem 201 increments unknown_item_captured_total exactly once", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_CAPTURE)
      .send({
        identifier_type: "barcode",
        identifier_value: CAPTURE_VALUE,
      });

    expect(res.status).toBe(201);

    // Drain microtasks: the service's recordUnknownItemCaptured() call is
    // synchronous within the handler, but the idempotency store's async
    // fire-and-forget tap may race. Mirrors capture-happy-path pattern.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(capturedCount).toBe(1);
    // Other counters must NOT fire on a plain capture.
    expect(resolvedCount).toBe(0);
    expect(mismatchCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T552-B -- dismiss increments `unknown_item_resolved_total{action='dismissed'}`
// ---------------------------------------------------------------------------

describe("T552 / 005-WAVE1-METRICS -- dismiss emission", () => {
  it("dismiss 200 increments unknown_item_resolved_total (action=dismissed) exactly once", async () => {
    if (dockerSkipped) return;

    // Use unknownAYBarcode -- the same target dismiss-audit.spec.ts uses
    // successfully against the admin pool. Tenant-wide actor (storeId=null
    // on context) to match dismiss-happy-path.spec.ts posture; the 0009
    // empty-string carve-out handles RLS.
    contextGuard.storeId = null as unknown as string;

    const targetId = UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode;

    const res = await http().post(
      `/api/v1/catalog/unknown-items/${targetId}/dismiss`,
    );

    expect(res.status).toBe(200);

    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(resolvedCount).toBe(1);
    // Verify the spy was called with action='dismissed'.
    expect(resolvedSpy).toHaveBeenCalledWith({ action: "dismissed" });
    // Other counters must NOT fire on a plain dismiss.
    expect(capturedCount).toBe(0);
    expect(mismatchCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T552-C -- idempotency mismatch increments `idempotency_token_mismatch_total`
//
// UNSKIPPED by `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` PR 3. Previously skipped
// because the mismatch path was wired through the now-deleted
// `IdempotencyMismatchFilter` (an async `@Catch(ConflictException)` filter
// `@UseFilters`-bound on `posCaptureItem`). PR 2 of this slice proved that
// pattern never fired its side effects under the test harness: when the
// global `IdempotencyInterceptor` (APP_INTERCEPTOR) throws `ConflictException`
// on the collision branch BEFORE calling `next.handle()`, NestJS never
// subscribes the inner chain, so no downstream filter/interceptor observes the
// rejection. PR 2 pivoted to firing the catalog telemetry INLINE inside
// `IdempotencyInterceptor.handle()`'s collision branch (same code-site as the
// platform `recordIdempotencyConflict`), route-scoped to the unknown-items
// capture path. The sibling `retry-mismatch.spec.ts` (T532) now passes on
// db-integration CI with that wiring; this case uses the identical harness
// (see the `idempInterceptor` constructed with `auditSpy` in `beforeAll`).
// ---------------------------------------------------------------------------

describe("T552 / 005-WAVE1-METRICS -- idempotency mismatch emission", () => {
  it("same key + different payload -> 409; idempotency_token_mismatch_total incremented exactly once", async () => {
    if (dockerSkipped) return;

    // First call -- establishes the cached entry.
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_MISMATCH)
      .send({
        identifier_type: "barcode",
        identifier_value: MISMATCH_VALUE_FIRST,
      });
    expect(first.status).toBe(201);

    // Drain so the idempotency store's async tap completes and the entry
    // is available to the second call. Mirrors retry-mismatch.spec.ts:332.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Reset counters so only the SECOND call's emissions are observed.
    capturedCount = 0;
    resolvedCount = 0;
    mismatchCount = 0;

    // Second call -- same key, different identifier_value.
    // IdempotencyInterceptor detects the payload mismatch on its collision
    // branch, fires recordIdempotencyTokenMismatch() INLINE (route-scoped to
    // the capture path), enqueues the catalog audit, then throws
    // ConflictException. GlobalExceptionFilter formats the 409 envelope.
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_MISMATCH)
      .send({
        identifier_type: "barcode",
        identifier_value: MISMATCH_VALUE_SECOND,
      });

    expect(second.status).toBe(409);

    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(mismatchCount).toBe(1);
    // Capture counter must NOT fire on a mismatch rejection (no row created).
    expect(capturedCount).toBe(0);
    expect(resolvedCount).toBe(0);
  });
});
