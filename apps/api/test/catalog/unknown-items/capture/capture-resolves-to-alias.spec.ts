/**
 * T513 — 005-WAVE1-CAPTURE-RESOLVE — POS capture with alias-resolution prelude.
 *
 * Acceptance (slice 005-WAVE1-CAPTURE-RESOLVE validation contract):
 *   GREEN — T513/T514 acceptance criteria met:
 *     - POS submits an identifier whose `(tenant_id, identifier_type,
 *       value)` matches an active `product_aliases` row (`retired_at IS
 *       NULL`) → 200-class response with discriminated `kind: "resolved"`
 *       and `product_id` referencing the alias's target product.
 *     - NO new `unknown_items` row exists for that tuple after the call.
 *     - The CAPTURE-HAPPY fallthrough still works for a non-matching
 *       identifier (201 with `kind: "unknown"`, one row created).
 *     - Idempotency replay works on the resolved branch: a retry with
 *       the same `Idempotency-Key` + body returns the same 200 body and
 *       `Idempotent-Replayed: true` (proves the existing
 *       `IdempotencyInterceptor` covers both branches without change).
 *
 *   Seeded fixture (from `apps/api/test/catalog/__support__/isolation-harness.ts`):
 *     `product_aliases` row `(TENANT_A, 'barcode', 'T340-A-BAR-001',
 *      store_id NULL, retired_at NULL)` → PRODUCT_A_ACTIVE via ALIAS_A_BARCODE.
 *     We submit this exact identifier to exercise the resolved branch.
 *
 * Wiring strategy:
 *   Mirrors `capture-happy-path.spec.ts` exactly — same hand-rolled
 *   `Test.createTestingModule` graph, same FakeRedis + FakeMarker, same
 *   ConfigurableContextGuard. The audit interceptor is NOT mounted in
 *   this spec (just like CAPTURE-HAPPY) — audit-event assertion lives
 *   in T546.
 *
 * Docker:
 *   Testcontainers Postgres 16 is required. `MIGRATION_TEST_ALLOW_SKIP=1`
 *   soft-skips the suite when Docker is unavailable (mirrors
 *   capture-happy-path.spec.ts's pattern — addresses the prior dispatch's
 *   CodeRabbit nitpick about uniform soft-skip behavior).
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
  ALIAS_A_BARCODE,
  PRODUCT_A_ACTIVE,
  TENANT_A,
  STORE_A_X,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stand-in POS device principal id (`req.context.userId`). Distinct from
 * the CAPTURE-HAPPY device id so concurrent runs don't tread on each other. */
const DEVICE_USER_ID = "0d000000-0000-7000-8000-00000000d5e3";

/** Identifier value matching the seeded `product_aliases` row
 * (TENANT_A, barcode, 'T340-A-BAR-001') → PRODUCT_A_ACTIVE.
 * See isolation-harness.ts:344 — this is a tenant-wide alias
 * (`store_id` NULL, `retired_at` NULL). */
const RESOLVED_IDENTIFIER_VALUE = "T340-A-BAR-001";

/** Identifier value NOT present in `product_aliases` for any tenant —
 * exercises the capture fallthrough branch (regression guard for
 * CAPTURE-HAPPY behavior). Uses a T513-prefixed namespace so the
 * afterEach cleanup is precise. */
const UNRESOLVED_IDENTIFIER_VALUE = "T513-CAPTURE-FALLTHROUGH-001";

/** 32-char ASCII idempotency key (passes the interceptor's regex). */
const IDEMP_KEY_RESOLVED = "abcdef1234567890abcdef1234567513";
const IDEMP_KEY_UNRESOLVED = "abcdef1234567890abcdef1234567514";
const IDEMP_KEY_REPLAY = "abcdef1234567890abcdef1234567515";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same shape as capture-happy-path.spec.ts
// ---------------------------------------------------------------------------

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

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
      requestId?: string;
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
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  // Soft-skip when Docker is unavailable AND `MIGRATION_TEST_ALLOW_SKIP=1`
  // is set (mirrors capture-happy-path.spec.ts).
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T513 capture-resolves-to-alias.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — integration suite soft-skipped.\n`,
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
    pgReader: { async find() { return null; } },
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
      // PG_POOL bound to app (non-superuser app_test role, RLS-active) —
      // this spec exercises the capture data path, so RLS policies must run
      // for real. Pattern set by link-happy-path.spec.ts:181-184 after PR #357.
      {
        provide: PG_POOL,
        useFactory: (): Pool => localEnv.app,
      },
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
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = DEVICE_USER_ID;
});

afterEach(async () => {
  if (dockerSkipped) return;
  // Clean up only the rows this suite created (the resolved branch
  // doesn't INSERT anything; the fallthrough branch creates rows under
  // the T513-prefixed namespace).
  if (env) {
    await env.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1
          AND store_id = $2
          AND value LIKE 'T513-%'`,
      [TENANT_A, STORE_A_X],
    );
  }
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T513 — alias-resolution prelude wins over capture
// ---------------------------------------------------------------------------

describe("T513 / 005-WAVE1-CAPTURE-RESOLVE — POS submission resolves via active alias", () => {
  it("returns 200 with resolved-response shape when an alias matches (FR-022, FR-030, FR-031) and creates NO unknown_items row", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_RESOLVED)
      .send({
        identifier_type: "barcode",
        identifier_value: RESOLVED_IDENTIFIER_VALUE,
      });

    // FR-022: alias hit → 200, not 201 (no row inserted).
    expect(res.status).toBe(200);

    // Discriminated `PosCaptureResolvedResponse` shape per contract:
    //   kind:       "resolved" (literal)
    //   product_id: tenant-product uuid that the alias points at
    //   alias_id:   the resolving alias's uuid (optional in YAML but we
    //               always emit it — convenience for auditing)
    expect(res.body).toEqual({
      kind: "resolved",
      product_id: PRODUCT_A_ACTIVE,
      alias_id: ALIAS_A_BARCODE,
    });

    // FR-022 — no `unknown_items` row was created for the resolved tuple.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value = $2`,
      [TENANT_A, RESOLVED_IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("0");
  });

  it("falls through to capture (201 with kind: \"unknown\") when no alias matches — regression guard for CAPTURE-HAPPY", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_UNRESOLVED)
      .send({
        identifier_type: "barcode",
        identifier_value: UNRESOLVED_IDENTIFIER_VALUE,
      });

    // No alias for this value → capture path. 201 + unknown variant.
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: UNRESOLVED_IDENTIFIER_VALUE,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
      },
    });

    // Exactly one pending row created.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_X, UNRESOLVED_IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("1");
  });

  // -------------------------------------------------------------------------
  // T539b — Idempotency replay on the 200/resolved branch.
  //
  // Slice brief (Hard constraints → Contract compliance):
  //   "Both responses are still subject to the existing `@Idempotent('required')`
  //    interceptor — idempotency replay must work on BOTH branches (a resolved
  //    response replays as resolved; an unknown response replays as unknown)."
  //
  // History: this assertion was `.skip`'d when authored (PR #321) because the
  // existing `IdempotencyInterceptor` at `idempotency.interceptor.ts:274`
  // hard-coded the replay status to `HttpStatus.CREATED`, so a 200-resolved
  // response replayed as 201 (body correct, status wrong). The 005-WAVE1-
  // IDEMP-STATUS-CAPTURE slice (T539a) replaced that literal with
  // `execCtx.switchToHttp().getResponse().statusCode`, so the handler's
  // actual status (set via `@Res({ passthrough: true })` + `res.status(...)`)
  // is now preserved through replay. This test verifies that fix end-to-end
  // on the 005 resolved branch.
  it("replays the resolved response on an identical retry with the same Idempotency-Key (T539b fix verification — status now preserved from handler)", async () => {
    if (dockerSkipped) return;

    const body = {
      identifier_type: "barcode" as const,
      identifier_value: RESOLVED_IDENTIFIER_VALUE,
    };

    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_REPLAY)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.kind).toBe("resolved");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    // Drain the interceptor's fire-and-forget `store.save` tap.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_REPLAY)
      .send(body);

    // Replay preserves the original status (200) AND body.
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    // Still no `unknown_items` row created across both calls.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value = $2`,
      [TENANT_A, RESOLVED_IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("0");
  });
});
