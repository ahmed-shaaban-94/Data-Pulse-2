/**
 * T517 — 005-WAVE1-CAPTURE-DEDUP — POS capture deduplicates pending rows
 * (FR-032 natural dedup).
 *
 * Acceptance (slice 005-WAVE1-CAPTURE-DEDUP validation contract):
 *   GREEN — T517/T518 acceptance criteria met:
 *     - A second POS submission of an identifier already represented by a
 *       `pending` `unknown_items` row in the same (tenant, store) does
 *       NOT create a second row. The first row's `id` is returned
 *       verbatim, the row count remains 1.
 *     - Dedup is store-scoped: the same logical identifier submitted at
 *       a DIFFERENT store of the same tenant creates a FRESH `pending`
 *       row. A pending row at store X must not short-circuit a capture
 *       at store Y (FR-030a invariant extended to the dedup branch).
 *     - Dedup is `resolution_status = 'pending'` only: a `dismissed`
 *       (or `resolved`) row MUST NOT short-circuit a fresh capture.
 *       This guarantees FR-005 (resubmit-after-dismissal mints a new
 *       pending row); T545 codifies this as the service-layer
 *       assertion T518 ships.
 *
 *   Critical: the two POST calls in test 1 use DIFFERENT
 *   `Idempotency-Key` values. With the SAME key the idempotency
 *   interceptor short-circuits at the wrapping layer and the dedup
 *   path is never exercised — that's the wrong primitive. T517
 *   verbatim: "with a different idempotency token — returns the same
 *   unknown_items.id, no second row created."
 *
 * Fixture composition strategy:
 *   The shared catalog isolation harness (forbidden-to-edit by
 *   allowed_files) seeds the parent tenants/stores. This spec inline-seeds
 *   ONE `dismissed` `unknown_items` row for test 3 via
 *   `env.admin.query(...)` — same pattern as `capture-store-scope.spec.ts`
 *   (T515) since the harness is out of allowed_files for this slice. All
 *   fresh `pending` rows created by the capture path are wiped in
 *   `afterEach` scoped to `tenant_id + value LIKE 'DEDUP-%'`. The
 *   dismissed seed is removed in `afterAll`.
 *
 * Wiring strategy:
 *   Mirrors `capture-store-scope.spec.ts` (T515 / PR #326) — same
 *   hand-rolled `Test.createTestingModule`, same FakeRedis + FakeMarker,
 *   same ConfigurableContextGuard. The store guard is reconfigured
 *   per-test to flip between STORE_A_X and STORE_A_Y for the
 *   cross-store dedup invariant.
 *
 * Docker:
 *   Testcontainers Postgres 16 is required. `MIGRATION_TEST_ALLOW_SKIP=1`
 *   soft-skips the suite when Docker is unavailable (mirrors
 *   capture-happy-path.spec.ts, capture-resolves-to-alias.spec.ts, and
 *   capture-store-scope.spec.ts).
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
  ACTOR_A,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stand-in POS device principal id (`req.context.userId`). Distinct from
 * other capture specs' device ids to keep concurrent runs isolated. */
const DEVICE_USER_ID = "0d000000-0000-7000-8000-00000000d517";

/** Identifier with NO alias seeded — every submission falls through to
 *  the dedup branch / fresh capture. */
const DEDUP_PRIMARY_IDENTIFIER = "DEDUP-001";

/** Identifier exercised at both STORE_A_X and STORE_A_Y to prove dedup
 *  is store-scoped. */
const DEDUP_CROSS_STORE_IDENTIFIER = "DEDUP-002";

/** Identifier whose only pre-existing row is `dismissed`. The capture
 *  path MUST NOT return the dismissed row; it MUST insert a fresh
 *  `pending` row (FR-005 invariant carried by T518's
 *  `resolution_status = 'pending'` filter). */
const DEDUP_DISMISSED_IDENTIFIER = "DEDUP-003";

/** UUIDv7-shaped literal for the inline-seeded dismissed row.
 *  Mnemonic prefix stays within `a-f` per memory:
 *  `feedback_uuid_hex_literals` (was burned twice on `d0g` / `0dle`). */
const DISMISSED_ROW_ID = "0d000000-0000-7000-8000-00000000d518";

/** 32-char ASCII idempotency keys (pass the interceptor's regex).
 *  Each `it` uses two DISTINCT keys for the two POST calls — same key
 *  would route through the interceptor's replay path, not the
 *  service-layer dedup we are testing. */
const IDEMP_KEY_PRIMARY_1   = "abcdef1234567890abcdef1234567601";
const IDEMP_KEY_PRIMARY_2   = "abcdef1234567890abcdef1234567602";
const IDEMP_KEY_CROSS_AX    = "abcdef1234567890abcdef1234567603";
const IDEMP_KEY_CROSS_AY    = "abcdef1234567890abcdef1234567604";
const IDEMP_KEY_DISMISSED   = "abcdef1234567890abcdef1234567605";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same shape as capture-store-scope.spec.ts
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
  // is set (mirrors capture-store-scope.spec.ts).
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T517 capture-deduplicates-pending.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — integration suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Inline-seed ONE dismissed unknown_items row under the `DEDUP-`
  // namespace. Composed to satisfy 003's CHK constraints:
  //   - unknown_items_resolved_fields_consistent: non-pending status
  //     requires resolved_at + resolved_by + resolution_action NOT NULL.
  //   - unknown_items_linked_product_present: action='dismissed' MUST
  //     have resolved_product_id IS NULL.
  //   - unknown_items_source_system_required: identifier_type !=
  //     'external_pos_id' MUST have source_system IS NULL.
  //
  // ON CONFLICT DO NOTHING keeps the spec idempotent under suite-reuse
  // (defensive — mirrors STORE-SCOPE's pattern).
  const localEnv = env;
  await localEnv.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, resolution_action,
        resolved_at, resolved_by, resolved_product_id,
        sale_context, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4,
        NULL, 'dismissed', 'dismissed',
        now(), $5, NULL,
        NULL, gen_random_uuid())
     ON CONFLICT (id) DO NOTHING`,
    [
      DISMISSED_ROW_ID,
      TENANT_A,
      STORE_A_X,
      DEDUP_DISMISSED_IDENTIFIER,
      ACTOR_A,
    ],
  );

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
  // Wipe the inline-seeded dismissed row AND any leftover fresh-pending
  // rows from the suite. Scoped tightly to TENANT_A + DEDUP- value
  // prefix so we never touch other specs' rows.
  if (env && !dockerSkipped) {
    await env.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1
          AND value LIKE 'DEDUP-%'`,
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
  contextGuard.userId = DEVICE_USER_ID;
});

afterEach(async () => {
  if (dockerSkipped) return;
  // Clean up only the rows this suite's PENDING fallthrough branch
  // created. The dismissed seed (status='dismissed', id=DISMISSED_ROW_ID)
  // is preserved across tests and removed in afterAll. We narrow on
  // resolution_status='pending' so the seed survives.
  if (env) {
    await env.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1
          AND value LIKE 'DEDUP-%'
          AND resolution_status = 'pending'`,
      [TENANT_A],
    );
  }
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T517 / T518 — natural dedup of pending rows (FR-032)
// ---------------------------------------------------------------------------

describe("T517 / 005-WAVE1-CAPTURE-DEDUP — POS capture deduplicates pending rows (FR-032)", () => {
  it("second submission of an identifier with a pending row returns the same row id (no new INSERT)", async () => {
    if (dockerSkipped) return;

    contextGuard.storeId = STORE_A_X;

    // First submission — no alias, no pending row exists → fresh INSERT.
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_PRIMARY_1)
      .send({
        identifier_type: "barcode",
        identifier_value: DEDUP_PRIMARY_IDENTIFIER,
      });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: DEDUP_PRIMARY_IDENTIFIER,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
      },
    });
    const firstRowId = first.body.unknown_item.id as string;

    // Second submission — DIFFERENT idempotency key (avoids interceptor
    // replay) but same logical identifier. The natural dedup path MUST
    // return the SAME row id without an INSERT.
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_PRIMARY_2)
      .send({
        identifier_type: "barcode",
        identifier_value: DEDUP_PRIMARY_IDENTIFIER,
      });

    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: firstRowId,
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: DEDUP_PRIMARY_IDENTIFIER,
        resolution_status: "pending",
      },
    });
    // Replay header NOT set — this is the service-layer dedup, not the
    // idempotency-interceptor replay.
    expect(second.headers["idempotent-replayed"]).toBeUndefined();

    // Exactly ONE pending row for this tuple — no second INSERT.
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3`,
      [TENANT_A, STORE_A_X, DEDUP_PRIMARY_IDENTIFIER],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // And the surviving row's id matches the one returned twice.
    const rowIdLookup = await env!.admin.query<{ id: string }>(
      `SELECT id FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3
          AND resolution_status = 'pending'`,
      [TENANT_A, STORE_A_X, DEDUP_PRIMARY_IDENTIFIER],
    );
    expect(rowIdLookup.rows[0]?.id).toBe(firstRowId);
  });

  it("dedup is store-scoped — a submission from a DIFFERENT store creates a new pending row (FR-030a invariant)", async () => {
    if (dockerSkipped) return;

    // First submission at STORE_A_X — creates pending row R1.
    contextGuard.storeId = STORE_A_X;
    const ax = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_CROSS_AX)
      .send({
        identifier_type: "barcode",
        identifier_value: DEDUP_CROSS_STORE_IDENTIFIER,
      });
    expect(ax.status).toBe(201);
    const axRowId = ax.body.unknown_item.id as string;

    // Second submission at STORE_A_Y — same tenant, DIFFERENT store.
    // Dedup must NOT match the STORE_A_X row; a fresh pending row at
    // STORE_A_Y MUST be created (a distinct id).
    contextGuard.storeId = STORE_A_Y;
    const ay = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_CROSS_AY)
      .send({
        identifier_type: "barcode",
        identifier_value: DEDUP_CROSS_STORE_IDENTIFIER,
      });
    expect(ay.status).toBe(201);
    expect(ay.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_Y,
        identifier_type: "barcode",
        identifier_value: DEDUP_CROSS_STORE_IDENTIFIER,
        resolution_status: "pending",
      },
    });
    const ayRowId = ay.body.unknown_item.id as string;
    expect(ayRowId).not.toBe(axRowId);

    // Two pending rows total for this identifier across the tenant —
    // one per store. The STORE_A_X dedup window did NOT extend to
    // STORE_A_Y.
    const total = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value     = $2
          AND resolution_status = 'pending'`,
      [TENANT_A, DEDUP_CROSS_STORE_IDENTIFIER],
    );
    expect(total.rows[0]?.count).toBe("2");

    const perStore = await env!.admin.query<{ store_id: string; count: string }>(
      `SELECT store_id, COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value     = $2
          AND resolution_status = 'pending'
        GROUP BY store_id
        ORDER BY store_id`,
      [TENANT_A, DEDUP_CROSS_STORE_IDENTIFIER],
    );
    expect(perStore.rows).toHaveLength(2);
    const counts = perStore.rows.reduce<Record<string, string>>((acc, r) => {
      acc[r.store_id] = r.count;
      return acc;
    }, {});
    expect(counts[STORE_A_X]).toBe("1");
    expect(counts[STORE_A_Y]).toBe("1");
  });

  it("dedup only matches PENDING rows — a submission for a previously-dismissed identifier creates a new pending row (FR-005)", async () => {
    if (dockerSkipped) return;

    // Sanity: the seeded dismissed row exists in (TENANT_A, STORE_A_X)
    // for DEDUP-003 with resolution_status='dismissed'.
    const seedCheck = await env!.admin.query<{
      id: string;
      resolution_status: string;
    }>(
      `SELECT id, resolution_status FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3`,
      [TENANT_A, STORE_A_X, DEDUP_DISMISSED_IDENTIFIER],
    );
    expect(seedCheck.rows).toHaveLength(1);
    expect(seedCheck.rows[0]?.id).toBe(DISMISSED_ROW_ID);
    expect(seedCheck.rows[0]?.resolution_status).toBe("dismissed");

    // POS resubmits the identifier — the dismissed row MUST NOT be
    // returned. A fresh PENDING row MUST be inserted, distinct id.
    contextGuard.storeId = STORE_A_X;
    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_DISMISSED)
      .send({
        identifier_type: "barcode",
        identifier_value: DEDUP_DISMISSED_IDENTIFIER,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: DEDUP_DISMISSED_IDENTIFIER,
        resolution_status: "pending",
      },
    });
    const newRowId = res.body.unknown_item.id as string;
    expect(newRowId).not.toBe(DISMISSED_ROW_ID);

    // Two rows now exist for this (tenant, store, identifier): the
    // original dismissed row (preserved) + the new pending row.
    const allRows = await env!.admin.query<{
      id: string;
      resolution_status: string;
    }>(
      `SELECT id, resolution_status FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value     = $3
        ORDER BY resolution_status`,
      [TENANT_A, STORE_A_X, DEDUP_DISMISSED_IDENTIFIER],
    );
    expect(allRows.rows).toHaveLength(2);
    const statuses = allRows.rows.map((r) => r.resolution_status).sort();
    expect(statuses).toEqual(["dismissed", "pending"]);

    // The dismissed row is UNCHANGED — same id, still dismissed.
    const dismissedAfter = allRows.rows.find(
      (r) => r.resolution_status === "dismissed",
    );
    expect(dismissedAfter?.id).toBe(DISMISSED_ROW_ID);
  });
});
