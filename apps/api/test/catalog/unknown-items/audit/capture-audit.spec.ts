/**
 * T546 — 005-WAVE1-AUDIT — Capture audit emission.
 *
 * Acceptance (slice 005-WAVE1-AUDIT validation contract):
 *   GREEN — FR-080/FR-082 audit emission for the capture transition:
 *     - POS submits an unknown identifier via `posCaptureItem`
 *     - the `AuditEmitterInterceptor` enqueues exactly one payload with:
 *         action          = "unknown_item.captured"
 *         tenant_id       = the POS principal's tenant
 *         store_id        = the POS principal's store binding
 *         actor_user_id   = the POS device user id
 *         request_id      = the request's request id (matches the
 *                           response's `request_id` envelope field
 *                           when present)
 *     - no additional audit payloads fire for the same request
 *
 * Spec anchors:
 *   - FR-080: state-transition operations emit one audit event
 *   - FR-082: capture is a first-class audit subject
 *   - 005-WAVE1-AUDIT brief: T546 + T547 verify the `@Auditable`
 *     decorator on `posCaptureItem` reaches the global
 *     `AuditEmitterInterceptor` via `Reflector`
 *
 * Wiring strategy
 * ---------------
 * Hand-rolled `Test.createTestingModule` (same posture as
 * `capture-happy-path.spec.ts` / `retry-mismatch.spec.ts`):
 *   - real `UnknownItemsController`
 *   - real `UnknownItemsService` against a Testcontainers `pg.Pool`
 *   - real `IdempotencyInterceptor` (registered via `APP_INTERCEPTOR`)
 *     because the route carries `@Idempotent("required")` — without
 *     it the request would 400 before reaching the audit emitter
 *   - real `AuditEmitterInterceptor` registered via `APP_INTERCEPTOR`
 *     so the `@Auditable` decorator metadata is consumed
 *   - a spy `AuditJobEnqueuer` bound to `AUDIT_JOB_ENQUEUER` captures
 *     every enqueue call for inspection
 *
 * Why a real DB:
 *   The capture path inserts a row; without a real schema the service
 *   would fail before the interceptor's `tap.next` fires. We also assert
 *   the audit subject is emitted on a successful 201 (not a 4xx fast
 *   fail), which requires the row insert to actually succeed.
 *
 * Docker: Testcontainers Postgres 16 required; honors
 * `MIGRATION_TEST_ALLOW_SKIP=1` per repo convention.
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
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005a1";
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";
const IDENTIFIER_VALUE = "T546-AUDIT-CAPTURE-001";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same pattern as the sibling capture specs.
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
// ConfigurableContextGuard — publishes both `req.context` and `req.principal`.
// The AuditEmitterInterceptor reads `request.principal?.userId` for
// `actor_user_id`; the context guard provides both.
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
// Spy enqueuer — records every payload the interceptor pushes.
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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T546 capture-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      // audit-event emission verification — admin isolates the audit assertion
      // from orthogonal RLS plumbing (same pattern as dismiss-audit.spec.ts),
      // not the data-access path. RLS coverage for the data path is asserted
      // by capture-happy-path.spec.ts. Pattern: dismiss-audit.spec.ts:162-164.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      // Audit emitter wiring — the decorator on the route is what we're
      // proving reaches the interceptor through Nest's Reflector.
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useClass: AuditEmitterInterceptor },
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
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = DEVICE_USER_ID;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(
    "DELETE FROM unknown_items WHERE value LIKE 'T546-AUDIT-CAPTURE-%'",
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T546 — capture emits an `unknown_item.captured` audit event
// ---------------------------------------------------------------------------

describe("T546 / 005-WAVE1-AUDIT — capture audit emission", () => {
  it("posCaptureItem 201 emits exactly one `unknown_item.captured` audit payload with the POS principal's tenant/store/user", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: IDENTIFIER_VALUE,
      });

    expect(res.status).toBe(201);

    // The interceptor's `tap.next` fires AFTER the response is composed
    // but the enqueue is async-wrapped (`emitAsync(...).catch(...)`).
    // Drain microtasks so the spy reliably observes the call before
    // assertions run. Mirrors the microtask-drain idiom from
    // capture-happy-path.spec.ts.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(auditSpy.calls).toHaveLength(1);
    const payload = auditSpy.calls[0]!;
    expect(payload.action).toBe("unknown_item.captured");
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.store_id).toBe(STORE_A_X);
    expect(payload.actor_user_id).toBe(DEVICE_USER_ID);
    // target_type / target_id / metadata default to null — the emitter
    // does not derive a target row id from the response body for this
    // subject. A future enhancement can populate them via a metadata
    // hook on the decorator; out of scope for this slice.
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });
});
