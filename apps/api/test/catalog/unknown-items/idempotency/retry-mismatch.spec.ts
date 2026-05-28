/**
 * T532 — 005-WAVE1-IDEMP-MISMATCH — Payload-mismatch catalog-domain
 * audit + counter on existing 409.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-MISMATCH validation contract):
 *   GREEN — FR-021c catalog-domain audit + counter on existing 409:
 *     - same `(tenant, device, Idempotency-Key)` + DIFFERENT payload
 *       (different `identifier_value`) → 409 with
 *       `code: "idempotency_key_conflict"` (the existing
 *       IdempotencyInterceptor's outcome — unchanged by this slice)
 *     - NO new `unknown_items` row created (request never reaches the
 *       service)
 *     - the `IdempotencyMismatchInterceptor` fires:
 *         · `recordIdempotencyTokenMismatch()` counter incremented
 *         · `AUDIT_JOB_ENQUEUER.enqueue(...)` called with
 *           `action: "unknown_item.idempotency_mismatch_rejected"`
 *           and the same tenant/store/principal context the request
 *           carried
 *     - the platform-level `recordIdempotencyConflict` counter (in
 *       the 001 interceptor) also fired (not directly asserted here
 *       — it fires inside the interceptor at the collision branch,
 *       before the catalog-domain interceptor observes the error;
 *       we trust the platform interceptor's existing coverage).
 *
 * Spec anchors:
 *   - FR-021c: token/payload mismatch fails closed with a
 *     deterministic conflict outcome, distinct from
 *     `duplicate_alias_conflict`
 *   - FR-082: failed reconciliation attempts are first-class audit
 *     events
 *   - research.md §R2 FR-091 taxonomy: "idempotency-token-mismatch"
 *
 * Wiring strategy
 * ---------------
 * Full Nest app via `Test.createTestingModule` (mirrors PR #336 /
 * retry-identical.spec.ts). The key additional pieces vs. retry-identical:
 *
 *   - `IdempotencyMismatchInterceptor` is registered as a provider AND
 *     applied as a method-level interceptor on `posCaptureItem` via
 *     `@UseInterceptors(...)` — both pieces are needed for the
 *     interceptor to observe the 409 via `tap({ error: ... })`.
 *   - `AUDIT_JOB_ENQUEUER` is overridden with a spy that records
 *     every enqueue call. We assert exactly one call with the
 *     catalog-domain subject.
 *   - `recordIdempotencyTokenMismatch` is spied via `jest.spyOn`
 *     (same approach retry-identical uses for
 *     `recordUnknownItemCaptured`).
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1` per the repo convention.
 *
 * Why a real DB is required even though the request rejects:
 *   The "NO new `unknown_items` row created" assertion requires the
 *   real schema to exist so the SELECT works. A fully stubbed setup
 *   could prove the filter's catalog-domain side-effects but not the
 *   "no side-effects" assertion. Following the slice's
 *   `docker_required: true` flag.
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
import { IdempotencyMismatchInterceptor } from "../../../../src/catalog/unknown-items/interceptors/idempotency-mismatch.interceptor";
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

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005f1";
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";
const FIRST_VALUE = "T532-MISMATCH-A";
const SECOND_VALUE = "T532-MISMATCH-B"; // distinct payload triggers the mismatch

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
// Spy AuditJobEnqueuer — records every enqueue call
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
let mismatchCounter = 0;
let mismatchSpy: jest.SpyInstance;
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
        `\n[T532 retry-mismatch.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      // idempotency-key body-fingerprint mismatch — admin isolates the
      // conflict-detection behavior from RLS, not the data-access path. RLS
      // coverage for the data path is asserted by capture-happy-path.spec.ts.
      // Pattern: dismiss-audit.spec.ts:162-164.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      // The filter is registered as a provider so NestJS can resolve
      // its `AUDIT_JOB_ENQUEUER` injection. The `@UseFilters` decorator
      // on `posCaptureItem` is what actually opts the route in — same
      // wiring as production.
      IdempotencyMismatchInterceptor,
      // Override the AUDIT_JOB_ENQUEUER token with the spy so we can
      // assert exactly what the filter enqueued without needing
      // BullMQ / Redis. Canonical pattern per
      // `audit-emitter.interceptor.ts:15`.
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
  mismatchCounter = 0;
  mismatchSpy = jest
    .spyOn(apiMetrics, "recordIdempotencyTokenMismatch")
    .mockImplementation(() => {
      mismatchCounter += 1;
    });
});

afterEach(async () => {
  if (dockerSkipped) return;
  if (env) {
    await env.admin.query(
      "DELETE FROM unknown_items WHERE value LIKE 'T532-MISMATCH-%'",
    );
  }
  mismatchSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T532 — FR-021c payload mismatch fires catalog-domain telemetry
// ---------------------------------------------------------------------------

// T532 / 005-WAVE1-IDEMP-MISMATCH — FR-021c payload-mismatch end-to-end.
//
// History: this spec was authored in PR #339 and merged with db-integration
// RED. Three prior fix attempts (PR #349 30ca9e0, PR #349 951ee84, and the
// b8a9dd4 revert) all failed because they targeted symptoms in the test
// harness rather than the underlying architectural issue: the
// IdempotencyMismatchFilter was the only async exception filter in the
// codebase, and its async `Promise<void>` re-throw from `catch()` did not
// propagate to GlobalExceptionFilter. PR #386's diagnostic instrumentation
// proved the failure was post-filter-catch, pre-supertest-response, leading
// to the architectural pivot in PR 2 of the FOLLOWUP slice: the filter is
// replaced by IdempotencyMismatchInterceptor (using RxJS tap({ error })),
// mirroring AuditEmitterInterceptor's working pattern.
//
// Reference: specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Investigation update — 2026-05-28 (PR #386 CI evidence)"
//          + §"Slice brief — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP"
describe("T532 / 005-WAVE1-IDEMP-MISMATCH — FR-021c payload-mismatch", () => {
  it("same key + different payload → 409 idempotency_key_conflict; catalog audit + counter fire; no row created", async () => {
    if (dockerSkipped) return;

    // First call — succeeds with 201. Establishes the cached entry
    // the second call will collide with.
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: FIRST_VALUE,
      });
    expect(first.status).toBe(201);

    // Drain the interceptor's fire-and-forget `store.save` tap so the
    // cached entry is available to the second call. Mirrors the
    // microtask-drain idiom from capture-happy-path / retry-identical.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // At this point the first capture has fired its own catalog
    // metrics + audit (those land on the success path, not the
    // mismatch path we care about). Reset the spies so the
    // assertions below only see what the SECOND call produces.
    auditSpy.reset();
    mismatchCounter = 0;

    // Second call — same key, DIFFERENT identifier_value. The
    // IdempotencyInterceptor detects payload mismatch and throws
    // ConflictException. The route-scoped IdempotencyMismatchInterceptor's
    // tap({ error }) fires catalog telemetry. GlobalExceptionFilter
    // formats the 409 envelope.
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: SECOND_VALUE,
      });

    // FR-021c — the 409 outcome itself. Envelope shape comes from
    // GlobalExceptionFilter's HttpException branch. Post-PR #360, the
    // filter honors the user-supplied fine-grained code from the
    // IdempotencyInterceptor (Constitution §IV), so the wire envelope
    // surfaces `error.code: "idempotency_key_conflict"` directly.
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: {
        code: "idempotency_key_conflict",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
    // No `error.details.code` assertion: post-PR #360, the
    // IdempotencyInterceptor throws `new ConflictException({ code, message })`
    // with no `details` field. GlobalExceptionFilter.extractEnvelopeFields
    // only populates the envelope's `details` when the response payload
    // carries one, so `error.details` is undefined here. The canonical
    // code is already asserted at envelope-level above; a second `.details`
    // check would be redundant and contractually wrong. The original
    // PR #339 author flagged this with a "will need revisiting" note that
    // is now resolved by this deletion (PR 2 of FOLLOWUP).

    // Catalog-domain counter incremented exactly once on the mismatch.
    expect(mismatchCounter).toBe(1);

    // Catalog-domain audit subject emitted exactly once.
    expect(auditSpy.calls).toHaveLength(1);
    const auditPayload = auditSpy.calls[0]!;
    expect(auditPayload.action).toBe(
      "unknown_item.idempotency_mismatch_rejected",
    );
    expect(auditPayload.tenant_id).toBe(TENANT_A);
    expect(auditPayload.store_id).toBe(STORE_A_X);
    expect(auditPayload.actor_user_id).toBe(DEVICE_USER_ID);
    // target_type / target_id / metadata are null — the request was
    // rejected before any specific row was touched.
    expect(auditPayload.target_type).toBeNull();
    expect(auditPayload.target_id).toBeNull();
    expect(auditPayload.metadata).toBeNull();

    // NO new `unknown_items` row was created by the second call.
    // The first call's row exists (FIRST_VALUE); the rejected second
    // call did not create one (SECOND_VALUE).
    expect(env).not.toBeNull();
    const firstValueCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, FIRST_VALUE],
    );
    expect(firstValueCount.rows[0]?.count).toBe("1");

    const secondValueCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, SECOND_VALUE],
    );
    expect(secondValueCount.rows[0]?.count).toBe("0");
  });
});
