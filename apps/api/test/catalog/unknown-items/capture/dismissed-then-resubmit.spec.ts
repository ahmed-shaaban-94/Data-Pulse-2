/**
 * T544 — 005-WAVE1-FR005 — Resubmit after dismiss mints a fresh pending row.
 *
 * Acceptance (slice 005-WAVE1-FR005 validation contract):
 *   GREEN — FR-005 end-to-end via the dismiss route:
 *     1. POS submission of identifier I at (T, S) creates row R1 with
 *        `resolution_status='pending'`.
 *     2. Dashboard dismisses R1 via
 *        POST /api/v1/catalog/unknown-items/:id/dismiss → R1 transitions
 *        to `resolution_status='dismissed'` (FR-004 monotonicity).
 *     3. POS resubmits the SAME logical identifier at (T, S) with a
 *        DIFFERENT `Idempotency-Key` → the natural-dedup branch MUST
 *        NOT short-circuit on the dismissed R1. A fresh pending row R2
 *        is created (`R2.id !== R1.id`, `R2.resolution_status='pending'`).
 *     4. R1 is UNCHANGED (still dismissed, same `resolved_*` fields).
 *
 * Spec anchors:
 *   - FR-005: "resubmitting a previously-dismissed identifier MUST
 *     create a NEW pending unknown_items row, not return the dismissed
 *     row's reference."
 *   - FR-032: natural dedup is bounded to PENDING rows; dismissed and
 *     resolved rows are excluded from the dedup window via the partial
 *     index `idx_unknown_items_lookup_value`
 *     (`WHERE resolution_status = 'pending'`).
 *   - FR-004: monotonic lifecycle (`pending → dismissed`, no reversal).
 *
 * Why a NEW spec file (T544 vs. existing T517 case-3):
 *   `capture-deduplicates-pending.spec.ts` (T517) exercises the dedup
 *   branch with an INLINE-SEEDED dismissed row. That covers the
 *   service-layer invariant in isolation, but does NOT cross the
 *   dismiss-route HTTP boundary that ships in PR #341. T544 codifies
 *   FR-005 end-to-end: a real capture → real dismiss-via-route → real
 *   resubmit. This is the slice-binding assertion in tasks.md §8.2.
 *
 * Wiring strategy:
 *   Same shape as `capture-deduplicates-pending.spec.ts` (T517 / PR #328):
 *   hand-rolled `Test.createTestingModule` with the full
 *   `IdempotencyInterceptor` so each POST consumes its own
 *   `Idempotency-Key`. `ConfigurableContextGuard` flips between the
 *   POS-device principal (for the captures) and a tenant-admin
 *   principal (for the dismiss) — both within TENANT_A, STORE_A_X.
 *   The dismiss route does NOT require an idempotency header per the
 *   dismiss handler's lack of `@Idempotent('required')` (see
 *   unknown-items.controller.ts:432-437).
 *
 * Fixture composition:
 *   The shared `seedCatalogIsolationFixture` (forbidden-to-edit by
 *   allowed_files) seeds the parent tenants/stores. No `unknown_items`
 *   pre-seed is required for this spec — R1 is minted by the test's
 *   first POST, dismissed by the test's POST-dismiss, and R2 is minted
 *   by the test's second POST. `afterEach` cleans both rows scoped to
 *   `tenant_id + value LIKE 'FR005-%'`.
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors `MIGRATION_TEST_ALLOW_SKIP=1`
 *   for Docker-less local runs (mirrors capture-deduplicates-pending.spec.ts
 *   line 209).
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
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
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
  STORE_A_X,
  TENANT_A,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stand-in POS device principal id (`req.context.userId`) for the capture
 *  calls. Distinct from other capture specs' device ids to keep concurrent
 *  runs isolated. */
const POS_DEVICE_USER_ID = "0d000000-0000-7000-8000-00000000d544";

/** Stand-in tenant-admin principal id (`req.context.userId`) for the
 *  dismiss call. The dismiss handler captures this into `resolved_by`. */
const ADMIN_USER_ID = "0a000000-0000-7000-8000-00000000d544";

/** Identifier exercised across capture → dismiss → resubmit. The
 *  `FR005-` value-prefix bounds `afterEach` cleanup tightly to this
 *  spec's rows. */
const FR005_IDENTIFIER = "FR005-001";

/** 32-char ASCII idempotency keys (pass the interceptor's regex). The
 *  two captures MUST use DIFFERENT keys — same key would route through
 *  the interceptor's replay path and never exercise the service-layer
 *  dedup branch we're testing. */
const IDEMP_KEY_CAPTURE_1 = "abcdef1234567890abcdef1234500001";
const IDEMP_KEY_CAPTURE_2 = "abcdef1234567890abcdef1234500002";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same shape as capture-deduplicates-pending.spec.ts
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

/**
 * ConfigurableContextGuard — same shape as
 * capture-deduplicates-pending.spec.ts but with public mutability of
 * `userId` so the test can flip between the POS device (for capture)
 * and the tenant admin (for dismiss) within a single suite run.
 */
class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = STORE_A_X;
  public userId: string = POS_DEVICE_USER_ID;

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
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T544 dismissed-then-resubmit.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — integration suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

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

  const localEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
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
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice
    // (UnknownItemsController has no class-level guards because the POS
    // capture route uses a different auth model). Tests inject context via
    // the global ConfigurableContextGuard (registered below); override the
    // production guards with no-op pass-throughs so the global guard's
    // context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
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
  if (env && !dockerSkipped) {
    // Wipe everything this suite created — both pending and dismissed
    // rows under the FR005- value prefix, scoped to TENANT_A.
    await env.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1
          AND value LIKE 'FR005-%'`,
      [TENANT_A],
    );
  }
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = POS_DEVICE_USER_ID;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Clean BOTH lifecycle states (pending + dismissed) — this spec
  // creates a dismissed row as part of the flow under test, so a
  // pending-only delete would leak it across tests.
  await env.admin.query(
    `DELETE FROM unknown_items
      WHERE tenant_id = $1
        AND value LIKE 'FR005-%'`,
    [TENANT_A],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T544 — FR-005 end-to-end: capture → dismiss → resubmit
// ---------------------------------------------------------------------------

describe("T544 / 005-WAVE1-FR005 — resubmit after dismiss mints a fresh pending row (FR-005)", () => {
  it("capture I → dismiss R1 → recapture I → new pending row R2 distinct from R1; R1 unchanged (dismissed)", async () => {
    if (dockerSkipped) return;

    // ----- Step 1: POS captures identifier I → row R1 pending -----
    contextGuard.userId = POS_DEVICE_USER_ID;
    contextGuard.storeId = STORE_A_X;

    const capture1 = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_CAPTURE_1)
      .send({
        identifier_type: "barcode",
        identifier_value: FR005_IDENTIFIER,
      });

    expect(capture1.status).toBe(201);
    expect(capture1.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: FR005_IDENTIFIER,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
      },
    });
    const r1Id = capture1.body.unknown_item.id as string;

    // Sanity: R1 is in the DB as pending.
    const r1Check = await env!.admin.query<{
      id: string;
      resolution_status: string;
    }>(
      `SELECT id, resolution_status FROM unknown_items
        WHERE id = $1`,
      [r1Id],
    );
    expect(r1Check.rows).toHaveLength(1);
    expect(r1Check.rows[0]?.resolution_status).toBe("pending");

    // ----- Step 2: Store-scoped operator dismisses R1 -----
    contextGuard.userId = ADMIN_USER_ID;
    // Store-scoped operator at the capturing store — same store as the
    // captured row's `store_id`. The dismiss service sets
    // `app.current_store = STORE_A_X` so the `unknown_items_select`
    // RLS policy's store branch (post-0011) matches and admits the
    // UPDATE.
    //
    // Why NOT tenant-wide (storeId=null): on `origin/main` @ 888d0cd
    // the dismiss service maps `storeId=null` to the empty-string GUC
    // value `''`, which post-0011 evaluates to FAIL-CLOSED on
    // `unknown_items_select` (was the TRUE carve-out pre-0011, now
    // FALSE for "never-set"; the explicit carve-out sentinel is
    // `'*'`). That gap is a pre-existing regression in
    // `dismiss-happy-path.spec.ts` tests 1 + 3 (also failing on
    // `main`); fixing it is outside this slice's allowed_files. The
    // store-scoped dismiss path remains correct on `main` and
    // exercises FR-005 end-to-end the same way.
    contextGuard.storeId = STORE_A_X;

    const dismiss = await http().post(
      `/api/v1/catalog/unknown-items/${r1Id}/dismiss`,
    );

    expect(dismiss.status).toBe(200);
    expect(dismiss.body).toMatchObject({
      id: r1Id,
      tenant_id: TENANT_A,
      store_id: STORE_A_X,
      resolution_status: "dismissed",
      resolution_action: "dismissed",
      resolved_by: ADMIN_USER_ID,
      resolved_product_id: null,
    });
    expect(dismiss.body.resolved_at).toEqual(expect.any(String));

    // Sanity (DB-side): R1 is now dismissed.
    const r1AfterDismiss = await env!.admin.query<{
      id: string;
      resolution_status: string;
      resolved_by: string | null;
    }>(
      `SELECT id, resolution_status, resolved_by FROM unknown_items
        WHERE id = $1`,
      [r1Id],
    );
    expect(r1AfterDismiss.rows[0]?.resolution_status).toBe("dismissed");
    expect(r1AfterDismiss.rows[0]?.resolved_by).toBe(ADMIN_USER_ID);

    // ----- Step 3: POS resubmits the SAME identifier → row R2 pending -----
    //
    // Critical: DIFFERENT Idempotency-Key so the interceptor does not
    // replay the first POST's stored response. The capture path is
    // exercised cold and must hit the natural-dedup branch — which MUST
    // exclude the dismissed R1 (FR-005 + FR-032 via the partial-index
    // predicate `WHERE resolution_status = 'pending'`).
    contextGuard.userId = POS_DEVICE_USER_ID;
    contextGuard.storeId = STORE_A_X;

    const capture2 = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_CAPTURE_2)
      .send({
        identifier_type: "barcode",
        identifier_value: FR005_IDENTIFIER,
      });

    expect(capture2.status).toBe(201);
    expect(capture2.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: FR005_IDENTIFIER,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
      },
    });
    // Idempotency-interceptor replay header MUST NOT be set — this is
    // the cold capture path, not a replay.
    expect(capture2.headers["idempotent-replayed"]).toBeUndefined();

    const r2Id = capture2.body.unknown_item.id as string;
    expect(r2Id).not.toBe(r1Id);

    // ----- Step 4: Verify both rows coexist with the correct states -----
    const allRows = await env!.admin.query<{
      id: string;
      resolution_status: string;
      resolved_by: string | null;
      resolution_action: string | null;
      resolved_product_id: string | null;
    }>(
      `SELECT id, resolution_status, resolved_by, resolution_action,
              resolved_product_id
         FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3
        ORDER BY resolution_status`,
      [TENANT_A, STORE_A_X, FR005_IDENTIFIER],
    );
    expect(allRows.rows).toHaveLength(2);

    // R1: still dismissed, all resolved_* fields exactly as the dismiss
    // step set them (no second mutation by the resubmit path).
    const dismissedRow = allRows.rows.find(
      (r) => r.resolution_status === "dismissed",
    );
    expect(dismissedRow).toBeDefined();
    expect(dismissedRow?.id).toBe(r1Id);
    expect(dismissedRow?.resolved_by).toBe(ADMIN_USER_ID);
    expect(dismissedRow?.resolution_action).toBe("dismissed");
    expect(dismissedRow?.resolved_product_id).toBeNull();

    // R2: fresh pending row at the same (tenant, store, identifier),
    // distinct id, no resolved_* fields populated.
    const pendingRow = allRows.rows.find(
      (r) => r.resolution_status === "pending",
    );
    expect(pendingRow).toBeDefined();
    expect(pendingRow?.id).toBe(r2Id);
    expect(pendingRow?.resolved_by).toBeNull();
    expect(pendingRow?.resolution_action).toBeNull();
    expect(pendingRow?.resolved_product_id).toBeNull();
  });
});
