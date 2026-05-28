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
 *     - the `IdempotencyMismatchFilter` fires:
 *         · `recordIdempotencyTokenMismatch()` counter incremented
 *         · `AUDIT_JOB_ENQUEUER.enqueue(...)` called with
 *           `action: "unknown_item.idempotency_mismatch_rejected"`
 *           and the same tenant/store/principal context the request
 *           carried
 *     - the platform-level `recordIdempotencyConflict` counter (in
 *       the 001 interceptor) also fired (not directly asserted here
 *       — it fires inside the interceptor at line 254, before the
 *       filter runs; we trust the interceptor's existing coverage).
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
 *   - `IdempotencyMismatchFilter` is registered as a provider AND
 *     applied as a method-level filter on `posCaptureItem` — both
 *     pieces are needed for the filter to actually fire on the 409.
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

import { createHash } from "node:crypto";

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
import { createLogger, IdempotencyKeyStore } from "@data-pulse-2/shared";

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

// [T532-DIAG] Module-local pino logger for B5 boundary diagnostics. Mirrors
// the createLogger pattern in apps/api/src/main.ts. Removed in PR 2.
const diagLogger = createLogger({ service: "test.t532.retry-mismatch" });

/**
 * [T532-DIAG] Returns a SHA-256 hex fingerprint (first 8 chars) of the
 * Idempotency-Key for safe-to-log identification. Mirrors the
 * `keyFingerprint` helper in apps/api/src/idempotency/idempotency.interceptor.ts.
 * No raw key material is logged.
 */
function diagKeyFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
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

// [T532-DIAG] Save+restore T532_DIAG around the suite so the flag does not
// leak into other Jest workers that may share this process. Removed in PR 2
// once the failure boundary is identified.
let prevT532Diag: string | undefined;

beforeAll(async () => {
  prevT532Diag = process.env["T532_DIAG"];
  process.env["T532_DIAG"] = "1";

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
  // [T532-DIAG] Restore prior T532_DIAG value so the flag does not leak.
  if (prevT532Diag === undefined) {
    delete process.env["T532_DIAG"];
  } else {
    process.env["T532_DIAG"] = prevT532Diag;
  }
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

// [T532-DIAG] PR 1 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP — DIAGNOSTIC ONLY.
//
// CI RED IS EXPECTED on this PR. The unskip + diagnostic logging exist to
// collect *evidence* about where the ConflictException dies in the harness
// pipeline. PR 2 of the slice will apply the actual fix based on what the
// boundary logs reveal.
//
// What this PR does:
//   1. Removes `.skip` from the describe block below so the test runs.
//   2. Sets process.env.T532_DIAG = "1" before the suite runs so that
//      `console.log` statements at boundaries B1/B2/B3 (instrumented in
//      apps/api/src/idempotency/idempotency.interceptor.ts and
//      apps/api/src/catalog/unknown-items/filters/idempotency-mismatch.filter.ts)
//      fire under this CI run only. The env-gate keeps the diagnostics
//      inert in production and every other test suite.
//   3. Adds B5 console.log around the second supertest call to capture
//      the response (or absence thereof on timeout).
//
// The five boundary points the slice brief specified:
//   B1 — interceptor pre-throw (instrumented in interceptor.ts)
//   B2 — interceptor outer try/catch (instrumented in interceptor.ts)
//   B3 — IdempotencyMismatchFilter.catch entry (instrumented in filter.ts)
//   B4 — GlobalExceptionFilter.catch entry: NOT INSTRUMENTED in PR 1
//        because apps/api/src/common/exception.filter.ts is outside this
//        slice's allowed_files. Inferred from absence-of-B3-log.
//   B5 — supertest response receipt (instrumented below)
//
// Original PR #349 framing (preserved below for reference; per the
// FOLLOWUP brief in specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Correction to the existing skip-block framing", the claim that
// "the harness pattern is wrong" overstated the evidence — 001's
// conflict.spec.ts uses the same Test.createTestingModule + APP_INTERCEPTOR
// + sync-throw shape and passes CI today, so the pattern itself is NOT
// broken. This diagnostic PR exists to find the actual structural
// difference between 001's working spec and this one):
//
//   Root cause (original framing, retained for context): the test harness
//   uses a no-op `IdempotencyKeyStore` pgWriter/pgReader plus a method-level
//   `@UseFilters(IdempotencyMismatchFilter)` binding on the controller. When
//   `APP_INTERCEPTOR` throws (or returns `throwError`) inside that harness,
//   the `ConflictException` escapes Jest before any filter side-effect can
//   run, causing a 30s test timeout with a bare RxJS stack trace ending at
//   `switchMap.ts` — no NestJS request frames, no supertest frames, no
//   filter frames. Fix attempts in PR #349 (`30ca9e0` interceptor
//   `throwError` shape, `951ee84` global filter binding) failed with
//   byte-identical CI output.
//
// Slice brief: specs/005-pos-catalog-sync-reconciliation/wave-status.md
// §"Slice brief — 005-WAVE1-METRICS-MISMATCH-FOLLOWUP"
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
    // ConflictException. The filter catches it, fires catalog
    // telemetry, re-throws. GlobalExceptionFilter formats the envelope.
    //
    // [T532-DIAG B5] Pre/post-call structured pino logs around supertest. If
    // the call times out without ever returning, only the pre-call log fires —
    // that combined with which of B1/B2/B3 also fired tells us where in the
    // pipeline the exception was swallowed. Key is logged as a SHA-256
    // fingerprint only — no raw key material.
    diagLogger.debug(
      {
        event: "T532-DIAG-B5",
        boundary: "supertest-pre-call",
        key_fingerprint: diagKeyFingerprint(IDEMP_KEY),
        value: SECOND_VALUE,
        ts: Date.now(),
      },
      "T532 diagnostic: about to issue mismatch-triggering POST",
    );
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: SECOND_VALUE,
      });
    diagLogger.debug(
      {
        event: "T532-DIAG-B5",
        boundary: "supertest-post-call",
        key_fingerprint: diagKeyFingerprint(IDEMP_KEY),
        status: second.status,
        body_keys: Object.keys(second.body ?? {}),
        ts: Date.now(),
      },
      "T532 diagnostic: mismatch POST returned",
    );

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
    // NOTE: `error.details.code` assertion below is left as-authored
    // for the follow-up slice (005-WAVE1-METRICS-MISMATCH-FOLLOWUP)
    // that unskips this block. Post-PR #360 the interceptor still
    // throws `{ code, message }` only — no `details` field — so when
    // the skip is lifted, this assertion will need revisiting along
    // with the surrounding harness refactor.
    expect(second.body.error.details).toMatchObject({
      code: "idempotency_key_conflict",
    });

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
