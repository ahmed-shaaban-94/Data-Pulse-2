/**
 * T534 — 005-WAVE1-IDEMP-EDGES — Cross-device Idempotency-Key independence.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-EDGES validation contract, T534 / FR-021a):
 *   GREEN — Two distinct device principals submit `posCaptureItem` to the
 *   real route against the SAME `Idempotency-Key` header value but with
 *   DIFFERENT request bodies. Both calls succeed independently:
 *     - Each device gets a 201 + `kind: "unknown"` outcome.
 *     - Neither call carries `Idempotent-Replayed: true` (these are two
 *       independent computes, not replays of each other).
 *     - No 409 is raised — payload-mismatch detection is scoped to the
 *       same `clientId`, so different devices occupy independent dedup
 *       slots even when the wire-level header value collides.
 *     - Two distinct `unknown_items` rows exist after the calls (one per
 *       device's payload).
 *     - `unknown_item_captured_total` counter increments exactly twice.
 *
 * Spec anchor:
 *   FR-021a — per-device scoping. Proven structurally by the existing
 *   `IdempotencyInterceptor`'s dedup tuple
 *   `${method}:${route}:${clientId}:${key}` where `clientId =
 *   req.context.userId` (interceptor.ts:117 + clientId() at line 85).
 *   `existing-primitive-coverage.spec.ts` (T505) proved this against a
 *   stub controller; this slice closes the gap by proving it against
 *   the REAL `UnknownItemsController.posCaptureItem` route.
 *
 * Wiring strategy
 * ---------------
 * Mirrors `retry-identical.spec.ts` (T530 / PR #336) exactly — same
 * hand-rolled `Test.createTestingModule` with the real controller +
 * service bound to Testcontainers Postgres, real
 * `IdempotencyInterceptor` registered as `APP_INTERCEPTOR`, FakeRedis
 * + FakeMarker in-memory replacements. The ConfigurableContextGuard
 * is reconfigured between requests to flip the device principal
 * (`userId`) while keeping tenant/store stable. The IdempotencyMismatchFilter
 * is registered as a provider so the controller's `@UseFilters(...)`
 * binding can resolve it even though we expect no mismatch firing on
 * the happy path of this spec.
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1` per the repo convention; a Docker-less
 *   local run soft-skips and CI exercises the real assertions.
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
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { IdempotencyMismatchFilter } from "../../../../src/catalog/unknown-items/filters/idempotency-mismatch.filter";
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

/** Device principal A — a POS terminal. Distinct from B at `userId`. */
const DEVICE_A_USER_ID = "0d000000-0000-7000-8000-0000000005a1";
/** Device principal B — a second POS terminal in the same tenant/store. */
const DEVICE_B_USER_ID = "0d000000-0000-7000-8000-0000000005b1";

/** Shared Idempotency-Key header value — 32-char ASCII (passes KEY_REGEX). */
const IDEMP_KEY = "abcdef1234567890abcdef1234567534";

/**
 * Two DIFFERENT identifier values — distinct payloads keyed under the
 * same wire-level Idempotency-Key. If per-device scoping were broken the
 * interceptor would see the second call as a `same-key + different-body`
 * collision and return 409. Correct behavior: the dedup tuple bakes in
 * `clientId = userId`, so the two principals occupy independent slots.
 */
const DEVICE_A_VALUE = "T534-CROSS-DEVICE-A";
const DEVICE_B_VALUE = "T534-CROSS-DEVICE-B";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same shape as retry-identical.spec.ts
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
// ConfigurableContextGuard — reconfigurable `userId` per request
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string = STORE_A_X;
  public userId: string = DEVICE_A_USER_ID;

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
// Audit enqueuer stub — IdempotencyMismatchFilter injects AUDIT_JOB_ENQUEUER
// even though no mismatch should fire in this spec; record calls so we can
// defensively assert zero mismatch audits.
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
let captureCounter = 0;
let recordSpy: jest.SpyInstance;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T534 cross-device-keys.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      // Method-scoped filter on `posCaptureItem` — register as a provider
      // so Nest can resolve its `AUDIT_JOB_ENQUEUER` injection. Mirrors
      // retry-mismatch.spec.ts. The filter never fires on this spec's
      // happy path; we assert zero mismatch audits as a defensive check.
      IdempotencyMismatchFilter,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
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
  auditSpy.reset();
  captureCounter = 0;
  // Spy on the capture counter so we can prove each device's call did its
  // own service-level INSERT (not a replay short-circuit). Mirrors
  // retry-identical.spec.ts's pattern.
  recordSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemCaptured")
    .mockImplementation(() => {
      captureCounter += 1;
    });
  // Reset guard state to device A by default.
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = DEVICE_A_USER_ID;
});

afterEach(async () => {
  if (dockerSkipped) return;
  if (env) {
    await env.admin.query(
      "DELETE FROM unknown_items WHERE value LIKE 'T534-CROSS-DEVICE-%'",
    );
  }
  recordSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T534 — FR-021a: same key string, two devices → two independent computes
// ---------------------------------------------------------------------------

describe("T534 / 005-WAVE1-IDEMP-EDGES — FR-021a cross-device Idempotency-Key independence", () => {
  it("two devices submit with the SAME Idempotency-Key but DIFFERENT payloads → both 201, no 409, two rows", async () => {
    if (dockerSkipped) return;

    // Device A — first call. Fresh request from the interceptor's POV.
    contextGuard.userId = DEVICE_A_USER_ID;
    const resA = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: DEVICE_A_VALUE,
      });

    // Drain the interceptor's fire-and-forget `store.save` tap so device
    // A's cached entry is committed BEFORE device B's call lands. If we
    // skip this and per-device scoping were broken, the second call
    // could race the cache and silently succeed for the wrong reason.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Device B — same key string, DIFFERENT body. If scoping were broken
    // this would 409 (`idempotency_key_conflict`). Correct behavior: the
    // dedup tuple bakes in `clientId = userId`, so device B occupies its
    // own slot and computes a fresh response.
    contextGuard.userId = DEVICE_B_USER_ID;
    const resB = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: DEVICE_B_VALUE,
      });

    // Both calls SUCCEEDED — 201 Created, no 409 collision.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    // Neither response is a replay — they are independent computes.
    expect(resA.headers["idempotent-replayed"]).toBeUndefined();
    expect(resB.headers["idempotent-replayed"]).toBeUndefined();

    // Each device's response carries its own payload — not the other's.
    expect(resA.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: DEVICE_A_VALUE,
        resolution_status: "pending",
      },
    });
    expect(resB.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: DEVICE_B_VALUE,
        resolution_status: "pending",
      },
    });

    // Two DISTINCT `unknown_items` rows exist — one per device's payload.
    expect(env).not.toBeNull();
    const aRows = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, DEVICE_A_VALUE],
    );
    expect(aRows.rows[0]?.count).toBe("1");

    const bRows = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, DEVICE_B_VALUE],
    );
    expect(bRows.rows[0]?.count).toBe("1");

    // The capture counter fired exactly twice — once per device's INSERT.
    // A broken scoping would either short-circuit one call (counter=1) or
    // raise 409 (counter=1 + a 409 envelope).
    expect(captureCounter).toBe(2);

    // Defensive: the IdempotencyMismatchFilter never fired — no 409 path
    // was taken. (The 001 interceptor's conflict counter is not asserted
    // directly here; it's owned by the platform spec.)
    expect(
      auditSpy.calls.filter(
        (c) => c.action === "unknown_item.idempotency_mismatch_rejected",
      ),
    ).toHaveLength(0);
  });

  it("device A's identical retry still replays (per-device scoping does not break the within-device replay)", async () => {
    if (dockerSkipped) return;

    // Device A's first call — establishes a cached entry.
    contextGuard.userId = DEVICE_A_USER_ID;
    const body = {
      identifier_type: "barcode" as const,
      identifier_value: DEVICE_A_VALUE,
    };
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Device A again — same key, same body. Replay path expected.
    const replay = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);

    // Exactly one capture counter increment across both calls.
    expect(captureCounter).toBe(1);

    // Exactly one row in the DB.
    expect(env).not.toBeNull();
    const rows = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, DEVICE_A_VALUE],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });
});
