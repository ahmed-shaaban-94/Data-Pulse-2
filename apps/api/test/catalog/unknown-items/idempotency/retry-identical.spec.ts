/**
 * T530 — 005-WAVE1-IDEMP-WIRE — Real-route identical-retry verification.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-WIRE validation contract):
 *   GREEN — FR-021: same `(tenant, device, idempotency-key, payload)`
 *   submitted 5 times in rapid succession against the real
 *   `UnknownItemsController.posCaptureItem` route →
 *     - all 5 responses are identical
 *     - the second through fifth responses carry
 *       `Idempotent-Replayed: true` (the first does not)
 *     - exactly ONE `unknown_items` row exists after the loop
 *     - the capture metric increments exactly ONCE (the service
 *       runs once; replays short-circuit in the interceptor)
 *
 * Slice context — why this spec is small
 * --------------------------------------
 * The two structural pieces this slice was meant to deliver landed
 * earlier:
 *
 *   - T531 (`@Idempotent('required')` decorator on the capture route)
 *     shipped in PR #317 / CAPTURE-HAPPY at
 *     `apps/api/src/catalog/unknown-items/unknown-items.controller.ts:264`.
 *     No controller edit is needed in this slice.
 *
 *   - The FR-021 retry-identical *contract* is partially proven by two
 *     earlier specs:
 *       (a) `apps/api/test/catalog/unknown-items/capture/capture-happy-path.spec.ts`
 *           — PR #317 — proves replay at N=2 against the real route,
 *           with DB-row + metric assertions.
 *       (b) `apps/api/test/catalog/unknown-items/idempotency/existing-primitive-coverage.spec.ts`
 *           — PR #306 / T505 — proves replay at N=5 against a STUB
 *           controller (not the real `UnknownItemsController`).
 *
 *   This spec closes the small gap between them: N=5 calls against the
 *   REAL route, with the full assertion set the brief requires (DB
 *   uniqueness + metric uniqueness + replay header progression).
 *   Future POLISH (T564) may consolidate (a) + this file if the
 *   overlap becomes maintenance friction.
 *
 * Wiring strategy
 * ---------------
 * Mirrors `capture-happy-path.spec.ts`'s integration `describe`:
 * full `Test.createTestingModule` with the real controller, real
 * `UnknownItemsService` bound to the Testcontainer's admin pool,
 * real `IdempotencyInterceptor` registered as `APP_INTERCEPTOR`,
 * fake Redis (in-memory) + fake marker so no real Redis container is
 * needed. Configurable context guard publishes a fixed POS principal.
 *
 * Spy on `recordUnknownItemCaptured` (same approach as
 * capture-happy-path) so we can assert handler-invocation count
 * without scraping Prometheus internals.
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1` per the repo convention; a
 *   Docker-less local run soft-skips and CI exercises the real
 *   assertions under Testcontainers.
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

import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005e1";
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";
const IDENTIFIER_VALUE = "T530-RETRY-5X-001";
const RETRY_COUNT = 5;

// ---------------------------------------------------------------------------
// FakeRedis — same pattern as capture-happy-path.spec.ts
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
// ConfigurableContextGuard
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string = STORE_A_X;
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
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;
let captureCounter = 0;
let recordSpy: jest.SpyInstance;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T530 retry-identical.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  const localEnv = env;
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  contextGuard = new ConfigurableContextGuard();

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
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
    ],
  }).compile();

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
  fakeRedis.clear();
  captureCounter = 0;
  recordSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemCaptured")
    .mockImplementation(() => {
      captureCounter += 1;
    });
});

afterEach(async () => {
  if (dockerSkipped) return;
  if (env) {
    await env.admin.query(
      "DELETE FROM unknown_items WHERE value LIKE 'T530-RETRY-%'",
    );
  }
  recordSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T530 — FR-021 retry-identical at N=5 against the real route
// ---------------------------------------------------------------------------

describe("T530 / 005-WAVE1-IDEMP-WIRE — FR-021 identical-retry at N=5 (real route)", () => {
  it("submits the same (tenant, device, key, payload) 5 times → 1 row, 1 metric, replay header from call 2 onward", async () => {
    if (dockerSkipped) return;

    const body = {
      identifier_type: "barcode" as const,
      identifier_value: IDENTIFIER_VALUE,
    };

    const responses = [];
    for (let i = 0; i < RETRY_COUNT; i += 1) {
      const res = await http()
        .post("/api/pos/v1/catalog/unknown-items")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(body);
      responses.push(res);

      // After every call, drain the interceptor's fire-and-forget
      // `store.save` tap so the next call sees the cached result.
      // Mirrors capture-happy-path's microtask-drain idiom.
      for (let j = 0; j < 50; j += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // All 5 responses succeeded with the same status.
    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    // Bodies are byte-identical (same id, same tenant, etc.).
    for (let i = 1; i < responses.length; i += 1) {
      expect(responses[i]!.body).toEqual(responses[0]!.body);
    }

    // First call is NOT a replay; calls 2-5 ARE replays.
    expect(responses[0]!.headers["idempotent-replayed"]).toBeUndefined();
    for (let i = 1; i < responses.length; i += 1) {
      expect(responses[i]!.headers["idempotent-replayed"]).toBe("true");
    }

    // FR-021 invariant: exactly ONE `unknown_items` row in the DB after
    // the 5-call loop. Calls 2-5 short-circuit inside the interceptor
    // and never reach the service.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_X, IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // Capture metric counted exactly once — the service was invoked
    // exactly once. Same property T505 proved against a stub
    // controller; here we prove it against the real route.
    expect(captureCounter).toBe(1);
  });
});
