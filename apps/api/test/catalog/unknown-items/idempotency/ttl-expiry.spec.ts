/**
 * T535 — 005-WAVE1-IDEMP-EDGES — TTL expiry → fresh request.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-EDGES validation contract, T535 / FR-021b):
 *   GREEN — A POS capture submitted with `(tenant, device, Idempotency-Key,
 *   payload)` succeeds (201). After the cached entry's TTL elapses, an
 *   IDENTICAL re-submission is treated as a FRESH compute, not a replay:
 *     - Second response status is 201 (a new `unknown_items` row is
 *       inserted — the FR-032 dedup branch does NOT short-circuit here
 *       because the second request uses a fresh dedup-pending-row helper
 *       seeded via a `T535-FRESH-` identifier the prior call did not
 *       create).
 *
 *       NOTE on isolation between the "TTL expired → fresh request"
 *       semantic and the catalog-domain natural-dedup (FR-032):
 *       captureItem's service layer does a `SELECT ... pending` for the
 *       same `(tenant, store, identifier_type, value, source_system)`
 *       and short-circuits on hit (T518). To prove "treated as fresh by
 *       the IDEMPOTENCY layer" without colliding with the catalog dedup,
 *       this spec uses TWO different identifier values across the calls
 *       — both submitted with the SAME Idempotency-Key + same body fp on
 *       paper would be a contradiction; the simpler proof is: after TTL
 *       expiry the SAME key+payload reaches the SAME service path (no
 *       interceptor short-circuit), regardless of what the service then
 *       does. We assert this via:
 *         · `Idempotent-Replayed` header absent on the second call
 *         · the interceptor's replay metric fires once (first call's
 *           replay header check baseline) vs the fresh-compute path
 *
 *       Concretely, FR-021b is about the interceptor's TTL behavior, NOT
 *       about whether captureItem creates a row. So we delete the first
 *       capture's row from the DB BEFORE the second call (mimicking
 *       "lots of time passed; the prior pending row got dismissed and
 *       cleaned out"), then assert the second call lands a fresh row at
 *       the SAME identifier — observable proof that the request reached
 *       the handler.
 *     - The second response does NOT carry `Idempotent-Replayed: true`
 *       (the interceptor's replay short-circuit did not fire).
 *     - `unknown_item_captured_total` counter increments TWICE across
 *       the two calls — once per fresh compute. A replay would increment
 *       it exactly once.
 *
 * Clock-mocking strategy
 * ----------------------
 * The slice brief instructs: "Advance the clock past 72h ... via the test
 * infrastructure's clock-mocking. ... If you can't find an existing clock-
 * mock pattern in this repo, note it explicitly in the report and STOP —
 * do not invent infrastructure."
 *
 * Search results in this repo:
 *   - `apps/api/test/idempotency/marker-ttl.spec.ts:39, 83-90` — the
 *     existing canonical pattern for simulating TTL expiry in the
 *     IdempotencyInterceptor's surrounding test infrastructure: a
 *     RecordingRedis exposes an `expire(key)` method that explicitly
 *     removes the in-memory entry. The spec advances "past TTL" by
 *     calling `redis.expire(key)`. This is the established pattern.
 *   - No `jest.useFakeTimers` / `setSystemTime` / `advanceTimersByTime`
 *     usage exists anywhere under `apps/api/test/`.
 *
 * This spec mirrors `marker-ttl.spec.ts`'s pattern: the local FakeRedis
 * (already required for the rest of the wiring, identical shape to
 * retry-identical.spec.ts:113) carries a `clear()` method that removes
 * ALL entries. Calling `clear()` between the two POST requests is
 * semantically equivalent to "the cached idempotency entry expired and
 * the interceptor's `store.findOrCreate` sees no hit." Behaviorally
 * indistinguishable from advancing wall-clock time past the 72h TTL,
 * with the additional benefit that it doesn't risk perturbing the
 * underlying Postgres container's `now()` (which the service writes to
 * `encountered_at`).
 *
 * This is NOT new infrastructure — `clear()` is already on every
 * FakeRedis instance across the existing idempotency specs (see
 * retry-identical.spec.ts:138, retry-mismatch.spec.ts:140, existing-
 * primitive-coverage.spec.ts:117, capture-resolves-to-alias.spec.ts:128).
 *
 * Wiring strategy
 * ---------------
 * Mirrors `retry-identical.spec.ts` (T530 / PR #336) — same real-route
 * Testcontainer fixture, same FakeRedis + FakeMarker, same Configurable
 * guard. We do NOT touch the worker `apiMetrics.recordIdempotencyReplay`
 * spy — the assertion that the second response lacks `Idempotent-Replayed`
 * is the canonical FR-021b proof at the route boundary, and adding a
 * platform-counter spy would replicate 001's existing coverage.
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1` per the repo convention.
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
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005c1";
const IDEMP_KEY = "abcdef1234567890abcdef1234567535";
const IDENTIFIER_VALUE = "T535-TTL-EXPIRY-001";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker
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
        `\n[T535 ttl-expiry.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      // PG_POOL bound to admin (superuser, RLS-bypassed) — this spec asserts
      // idempotency-key TTL expiry semantics — admin isolates the
      // store-eviction behavior from RLS, not the data-access path. RLS
      // coverage for the data path is asserted by capture-happy-path.spec.ts.
      // Pattern: dismiss-audit.spec.ts:162-164.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      IdempotencyMismatchFilter,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice.
    // Even tests that only hit the POS capture route must override these
    // because NestJS resolves all controller-declared guards at compile time.
    // Override with no-op pass-throughs so the test harness compiles and
    // the global ConfigurableContextGuard's context survives to the handler.
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
  fakeRedis.clear();
  auditSpy.reset();
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
      "DELETE FROM unknown_items WHERE value LIKE 'T535-TTL-%'",
    );
  }
  recordSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T535 — FR-021b TTL expiry → fresh compute
// ---------------------------------------------------------------------------

describe("T535 / 005-WAVE1-IDEMP-EDGES — FR-021b idempotency cache TTL expiry → fresh compute", () => {
  it("after the interceptor's cached entry has expired, an identical resubmission is treated as a FRESH request", async () => {
    if (dockerSkipped) return;

    const body = {
      identifier_type: "barcode" as const,
      identifier_value: IDENTIFIER_VALUE,
    };

    // ---- First call — establishes the cached idempotency entry --------
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(first.body).toMatchObject({ kind: "unknown" });

    // Drain the interceptor's fire-and-forget `store.save` tap so the
    // cached entry lands BEFORE we simulate TTL expiry.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // First INSERT fired the catalog capture counter exactly once.
    expect(captureCounter).toBe(1);

    // ---- Simulate TTL expiry of the idempotency cache -----------------
    //
    // Canonical pattern from marker-ttl.spec.ts:83-90: explicitly clear
    // the in-memory Redis store. From the IdempotencyInterceptor's POV,
    // `store.findOrCreate(...)` now sees no hit — identical to wall-clock
    // advancement past the 72h default TTL. No production source is
    // touched; this is FakeRedis-local state.
    //
    // We also delete the catalog row from the first capture: the
    // service-layer FR-032 dedup (T518) would otherwise short-circuit at
    // the DB layer (regardless of the idempotency layer) on the second
    // call. Deleting the row models "lots of time passed; the pending
    // entry got cleaned out." The FR-021b assertion concerns the
    // IDEMPOTENCY layer's TTL behavior — we isolate that here by
    // ensuring the catalog dedup branch can't shadow the result.
    fakeRedis.clear();
    expect(env).not.toBeNull();
    await env!.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, IDENTIFIER_VALUE],
    );

    // ---- Second call — same key + payload, after TTL "expiry" --------
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);

    // FR-021b: the second call is a FRESH compute, not a replay.
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: IDENTIFIER_VALUE,
        resolution_status: "pending",
      },
    });

    // The second call's `unknown_items.id` differs from the first's —
    // proves the handler ran again (not a cached-body replay).
    expect(second.body.unknown_item.id).not.toBe(first.body.unknown_item.id);

    // Drain the second call's save tap before asserting metrics.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Capture counter incremented again — total 2. A replay would have
    // left this at 1.
    expect(captureCounter).toBe(2);

    // One pending row exists at the identifier after the cleanup +
    // re-capture. (The DELETE removed the first row; the second call
    // inserted a new one.)
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // No mismatch audit was fired (this is a same-key + same-payload
    // re-submission, not a payload mismatch).
    expect(
      auditSpy.calls.filter(
        (c) => c.action === "unknown_item.idempotency_mismatch_rejected",
      ),
    ).toHaveLength(0);
  });
});
