/**
 * T550 / T551 -- 005-WAVE1-METRICS-MISMATCH-FOLLOWUP -- idempotency-mismatch
 * audit subject, end-to-end wiring evidence.
 *
 * Acceptance (FR-082 + FR-021c):
 *   - A payload mismatch on the POS capture route
 *     (`POST /api/pos/v1/catalog/unknown-items`: same Idempotency-Key, different
 *     body) is rejected with 409 `idempotency_key_conflict` and emits exactly
 *     one `unknown_item.idempotency_mismatch_rejected` audit subject carrying
 *     the acting principal's tenant / store / user.
 *   - FR-021c DETERMINISM GUARANTEE: the audit enqueue is fire-and-forget. If
 *     the audit pipeline REJECTS (BullMQ outage, Redis disconnect), the 409
 *     contract MUST NOT be replaced by an audit failure -- the rejection is
 *     swallowed by the interceptor's `.catch()` and the client still receives a
 *     clean 409.
 *
 * Why this spec exists distinctly from `retry-mismatch.spec.ts` (T532)
 * --------------------------------------------------------------------
 * T532 already asserts the happy-shape audit payload on the mismatch path with
 * a RESOLVING spy enqueuer. This spec deliberately covers the angle T532 does
 * NOT: the determinism guarantee under a REJECTING enqueuer. The audit dir's
 * convention is one focused audit-subject spec per subject
 * (`capture-audit.spec.ts`, `dismiss-audit.spec.ts`); this is the matching file
 * for the `unknown_item.idempotency_mismatch_rejected` subject. The brief
 * (`005-WAVE1-METRICS-MISMATCH-FOLLOWUP`) lists it as the T550 deliverable.
 *
 * Wiring strategy
 * ---------------
 * Mirrors `metrics.spec.ts` / `retry-mismatch.spec.ts`: real
 * `UnknownItemsController` + `UnknownItemsService` against a Testcontainers
 * `pg.Pool`, real `IdempotencyInterceptor` constructed with the spy
 * `AuditJobEnqueuer` as its 4th constructor arg (the `@Optional()`
 * AUDIT_JOB_ENQUEUER inject) so the inline collision-branch catalog audit lands
 * on the spy. PR 2 of this slice re-homed the emission from the deleted
 * `IdempotencyMismatchFilter` into the interceptor's collision branch.
 *
 * Docker: Testcontainers Postgres 16 required; honors
 * `MIGRATION_TEST_ALLOW_SKIP=1` per repo convention.
 *
 * Spec anchors: FR-082 (failed reconciliation attempts are first-class audit
 * events), FR-021c (token/payload mismatch fails closed deterministically,
 * audit failures never alter the contract outcome).
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005d1";
const IDEMP_KEY = "ddccbbaa44332211ddccbbaa44332211";
const FIRST_VALUE = "T550-AUDIT-MISMATCH-FIRST-001";
const SECOND_VALUE = "T550-AUDIT-MISMATCH-SECOND-001";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker -- minimal Wave 1 pattern
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
// Spy enqueuer with a toggleable rejection mode.
//   - records every payload it was asked to enqueue (proves the subject + shape)
//   - when `rejectMode` is on, throws AFTER recording -- exercising the
//     interceptor's fire-and-forget `.catch()` while still letting us assert
//     what was attempted.
// ---------------------------------------------------------------------------

class ToggleableAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  public rejectMode = false;
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
    if (this.rejectMode) {
      throw new Error("simulated audit pipeline outage (BullMQ/Redis down)");
    }
  }
  reset(): void {
    this.calls = [];
    this.rejectMode = false;
  }
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let auditSpy: ToggleableAuditEnqueuer;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T550 idempotency-mismatch-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
  auditSpy = new ToggleableAuditEnqueuer();

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
  // Pass auditSpy as the 4th constructor arg (the @Optional() AUDIT_JOB_ENQUEUER
  // inject) so the inline catalog-domain audit emit on IdempotencyInterceptor's
  // collision branch lands on the spy under test. A logger is intentionally NOT
  // passed (5th arg) so the `.catch()`'s `this.logger?.error(...)` exercises its
  // no-op arm even when the enqueue rejects.
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
    auditSpy,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // Admin pool (RLS-bypassed): this spec asserts the audit subject + the
      // determinism guarantee on the mismatch path, not the data-access RLS
      // path (covered by capture-happy-path.spec.ts). Pattern:
      // dismiss-audit.spec.ts:168 / retry-mismatch.spec.ts:266.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
    ],
  })
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
    "DELETE FROM unknown_items WHERE value LIKE 'T550-AUDIT-MISMATCH-%'",
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

/**
 * Drive a payload mismatch: capture once (201), then re-POST the same
 * Idempotency-Key with a different body. Returns the second response.
 * Resets the audit spy + clears the first call's emissions before the second.
 */
async function captureThenMismatch(): Promise<request.Response> {
  const first = await http()
    .post("/api/pos/v1/catalog/unknown-items")
    .set("Idempotency-Key", IDEMP_KEY)
    .send({ identifier_type: "barcode", identifier_value: FIRST_VALUE });
  expect(first.status).toBe(201);

  // Drain the interceptor's fire-and-forget store.save tap so the cached entry
  // is available to the second call. Mirrors retry-mismatch.spec.ts.
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  // Only the SECOND (mismatch) call's audit emission should be asserted.
  auditSpy.reset();

  return http()
    .post("/api/pos/v1/catalog/unknown-items")
    .set("Idempotency-Key", IDEMP_KEY)
    .send({ identifier_type: "barcode", identifier_value: SECOND_VALUE });
}

// ---------------------------------------------------------------------------
// T550 -- audit subject emitted on the mismatch path
// ---------------------------------------------------------------------------

describe("T550 / 005-WAVE1-METRICS-MISMATCH-FOLLOWUP -- idempotency-mismatch audit subject", () => {
  it("payload mismatch emits exactly one `unknown_item.idempotency_mismatch_rejected` audit payload with the acting principal's tenant/store/user", async () => {
    if (dockerSkipped) return;

    const second = await captureThenMismatch();

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: { code: "idempotency_key_conflict" },
    });

    // Drain the fire-and-forget enqueue.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(auditSpy.calls).toHaveLength(1);
    const payload = auditSpy.calls[0]!;
    expect(payload.action).toBe("unknown_item.idempotency_mismatch_rejected");
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.store_id).toBe(STORE_A_X);
    expect(payload.actor_user_id).toBe(DEVICE_USER_ID);
    // The request was rejected before any specific row was touched.
    expect(payload.target_type).toBeNull();
    expect(payload.target_id).toBeNull();
    expect(payload.metadata).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T551 -- FR-021c determinism: a rejecting audit pipeline never alters the
  // 409 contract outcome (the angle retry-mismatch.spec.ts does NOT cover).
  // -------------------------------------------------------------------------
  it("FR-021c: a REJECTING audit enqueuer still yields a deterministic 409 (audit failure is swallowed, contract preserved)", async () => {
    if (dockerSkipped) return;

    // Arm the rejection BEFORE the mismatch call. captureThenMismatch() resets
    // the spy (clearing rejectMode) after the first capture, so set it on the
    // response promise's call by toggling immediately before the second POST.
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ identifier_type: "barcode", identifier_value: FIRST_VALUE });
    expect(first.status).toBe(201);

    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    auditSpy.reset();
    auditSpy.rejectMode = true;

    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ identifier_type: "barcode", identifier_value: SECOND_VALUE });

    // The 409 contract is preserved despite the audit enqueue rejecting.
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: { code: "idempotency_key_conflict" },
    });

    // Drain so the rejected enqueue's `.catch()` settles.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The enqueue WAS attempted (recorded before it threw) -- proving the
    // emission fired, and that the rejection was swallowed rather than
    // surfaced to the client.
    expect(auditSpy.calls).toHaveLength(1);
    expect(auditSpy.calls[0]!.action).toBe(
      "unknown_item.idempotency_mismatch_rejected",
    );
  });
});
