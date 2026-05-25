/**
 * T515 — 005-WAVE1-CAPTURE-STORE-SCOPE — POS capture honors FR-030a
 * submitting-store scope on alias resolution.
 *
 * Acceptance (slice 005-WAVE1-CAPTURE-STORE-SCOPE validation contract):
 *   GREEN — T515/T516 acceptance criteria met:
 *     - A store-scoped alias bound to store S1 of tenant T does NOT
 *       resolve a submission from store S2 of the same tenant T.
 *       Such a submission falls through to capture (`kind: "unknown"`).
 *     - Tenant-wide aliases (`store_id IS NULL`) still resolve at every
 *       store of the tenant (backward compatibility with T514 / FR-022).
 *     - When BOTH a store-scoped alias (matching the submitting store)
 *       AND a tenant-wide alias exist for the same `(tenant_id,
 *       identifier_type, value)`, the store-scoped row wins (precedence
 *       per spec.md §6.3 narrative + data-model.md FR-030a row).
 *
 *   Fixture composition strategy:
 *     The shared catalog isolation harness seeds tenant-wide and
 *     store-scoped aliases under the `T340-` namespace. This slice's
 *     allowed_files do NOT include the harness — per execution-map.yaml
 *     line 414. So we seed our store-scope test aliases inline via
 *     `env.admin.query(...)` inside `beforeAll`, under a `STORE-SCOPE-`
 *     identifier namespace, and clean them up in `afterAll`. Per-test
 *     `unknown_items` rows created by the fallthrough branch are wiped
 *     in `afterEach`.
 *
 * Wiring strategy:
 *   Mirrors `capture-resolves-to-alias.spec.ts` (T513 / PR #321) — same
 *   hand-rolled `Test.createTestingModule` graph, same FakeRedis +
 *   FakeMarker, same ConfigurableContextGuard. The store guard is
 *   reconfigured per-test to flip between STORE_A_X and STORE_A_Y for
 *   the cross-store invariant assertion.
 *
 * Docker:
 *   Testcontainers Postgres 16 is required. `MIGRATION_TEST_ALLOW_SKIP=1`
 *   soft-skips the suite when Docker is unavailable (mirrors
 *   capture-happy-path.spec.ts and capture-resolves-to-alias.spec.ts).
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
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stand-in POS device principal id (`req.context.userId`). Distinct from
 * other capture specs' device ids to keep concurrent runs isolated. */
const DEVICE_USER_ID = "0d000000-0000-7000-8000-00000000d515";

/** Identifier value backed by both a STORE_A_X-scoped alias (-> PRODUCT_A_ACTIVE)
 *  AND a tenant-wide alias (-> PRODUCT_A_RETIRED). Used to assert precedence:
 *  the store-scoped row wins when the submission comes from STORE_A_X; the
 *  tenant-wide row wins when no store-scoped match exists for the submitting
 *  store. */
const PRECEDENCE_IDENTIFIER = "STORE-SCOPE-001";

/** Identifier with ONLY a tenant-wide alias seeded → PRODUCT_A_ACTIVE.
 *  Asserts the fallback behavior (tenant-wide resolves everywhere). */
const TENANT_WIDE_ONLY_IDENTIFIER = "STORE-SCOPE-002";

/** Identifier with ONLY a STORE_A_Y-scoped alias seeded → PRODUCT_A_ACTIVE.
 *  Asserts the FR-030a invariant: a submission from STORE_A_X (different
 *  store of the same tenant) MUST NOT resolve and MUST fall through to
 *  capture (`kind: "unknown"`). */
const OTHER_STORE_ONLY_IDENTIFIER = "STORE-SCOPE-003";

// UUIDv7-shaped literals for the inline-seeded aliases (mnemonic prefix
// stays within a-f per memory: feedback_uuid_hex_literals).
const ALIAS_STORE_SCOPED_AX_PRECEDENCE = "0a000000-0000-7000-8000-00000000a515";
const ALIAS_TENANT_WIDE_PRECEDENCE     = "0a000000-0000-7000-8000-00000000a516";
const ALIAS_TENANT_WIDE_FALLBACK       = "0a000000-0000-7000-8000-00000000a517";
const ALIAS_STORE_SCOPED_AY_OTHER      = "0a000000-0000-7000-8000-00000000a518";

/** 32-char ASCII idempotency keys (pass the interceptor's regex). */
const IDEMP_KEY_PRECEDENCE_AX = "abcdef1234567890abcdef1234567515";
const IDEMP_KEY_TENANT_WIDE   = "abcdef1234567890abcdef1234567516";
const IDEMP_KEY_OTHER_STORE   = "abcdef1234567890abcdef1234567517";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker — same shape as capture-resolves-to-alias.spec.ts
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
  // is set (mirrors capture-resolves-to-alias.spec.ts).
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T515 capture-store-scope.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — integration suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Inline-seed the store-scope test aliases under the `STORE-SCOPE-`
  // namespace. The harness file is forbidden by allowed_files, so we
  // seed here. ON CONFLICT DO NOTHING keeps the spec idempotent under
  // suite-reuse (defensive — not currently exercised by Jest, but
  // matches the harness pattern).
  //
  // Precedence pair (STORE-SCOPE-001):
  //   - store-scoped at STORE_A_X → PRODUCT_A_ACTIVE
  //   - tenant-wide                → PRODUCT_A_RETIRED
  //   The store-scoped row MUST win for a STORE_A_X submission.
  //
  // Tenant-wide fallback (STORE-SCOPE-002):
  //   - tenant-wide only           → PRODUCT_A_ACTIVE
  //   Resolves from any store of TENANT_A.
  //
  // Cross-store invariant (STORE-SCOPE-003):
  //   - store-scoped at STORE_A_Y → PRODUCT_A_ACTIVE
  //   A STORE_A_X submission MUST NOT resolve; it falls through to
  //   capture (`kind: "unknown"`).
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, $5, $6),
       ($7, $2, $8, 'barcode', $4, NULL, NULL, $6),
       ($9, $2, $3, 'barcode', $10, NULL, NULL, $6),
       ($11, $2, $3, 'barcode', $12, NULL, $13, $6)
     ON CONFLICT DO NOTHING`,
    [
      // STORE-SCOPE-001 store-scoped at STORE_A_X → PRODUCT_A_ACTIVE
      ALIAS_STORE_SCOPED_AX_PRECEDENCE, TENANT_A, PRODUCT_A_ACTIVE,
      PRECEDENCE_IDENTIFIER, STORE_A_X, ACTOR_A,
      // STORE-SCOPE-001 tenant-wide → PRODUCT_A_RETIRED (distinguishable)
      ALIAS_TENANT_WIDE_PRECEDENCE, PRODUCT_A_RETIRED,
      // STORE-SCOPE-002 tenant-wide only → PRODUCT_A_ACTIVE
      ALIAS_TENANT_WIDE_FALLBACK, TENANT_WIDE_ONLY_IDENTIFIER,
      // STORE-SCOPE-003 store-scoped at STORE_A_Y → PRODUCT_A_ACTIVE
      ALIAS_STORE_SCOPED_AY_OTHER, OTHER_STORE_ONLY_IDENTIFIER, STORE_A_Y,
    ],
  );

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
      {
        provide: PG_POOL,
        useFactory: (): Pool => localEnv.admin,
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
  // Wipe the inline-seeded aliases (scoped tightly to this spec's
  // `STORE-SCOPE-` namespace within TENANT_A).
  if (env && !dockerSkipped) {
    await env.admin.query(
      `DELETE FROM product_aliases
        WHERE tenant_id = $1
          AND value LIKE 'STORE-SCOPE-%'`,
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
  // Clean up only the rows this suite's fallthrough branch created.
  // Scoped to `STORE-SCOPE-` value prefix + TENANT_A so we never touch
  // other specs' rows.
  if (env) {
    await env.admin.query(
      `DELETE FROM unknown_items
        WHERE tenant_id = $1
          AND value LIKE 'STORE-SCOPE-%'`,
      [TENANT_A],
    );
  }
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T515 / T516 — submitting-store scope on alias resolution (FR-030a)
// ---------------------------------------------------------------------------

describe("T515 / 005-WAVE1-CAPTURE-STORE-SCOPE — POS capture honors FR-030a submitting-store scope", () => {
  it("store-scoped alias takes priority over tenant-wide alias when submitting store matches", async () => {
    if (dockerSkipped) return;

    // Both aliases exist for `(TENANT_A, barcode, 'STORE-SCOPE-001')`:
    //   - store-scoped at STORE_A_X → PRODUCT_A_ACTIVE
    //   - tenant-wide              → PRODUCT_A_RETIRED
    // POS at STORE_A_X submits — the store-scoped row MUST win.
    contextGuard.storeId = STORE_A_X;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_PRECEDENCE_AX)
      .send({
        identifier_type: "barcode",
        identifier_value: PRECEDENCE_IDENTIFIER,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: "resolved",
      product_id: PRODUCT_A_ACTIVE,
      alias_id: ALIAS_STORE_SCOPED_AX_PRECEDENCE,
    });

    // FR-022: no `unknown_items` row created for the resolved tuple.
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value = $2`,
      [TENANT_A, PRECEDENCE_IDENTIFIER],
    );
    expect(rowCount.rows[0]?.count).toBe("0");
  });

  it("tenant-wide alias resolves when no store-scoped alias exists for the submitting store (fallback)", async () => {
    if (dockerSkipped) return;

    // Only a tenant-wide alias exists for STORE-SCOPE-002 → PRODUCT_A_ACTIVE.
    // POS at STORE_A_X submits — falls back to tenant-wide, resolves.
    contextGuard.storeId = STORE_A_X;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_TENANT_WIDE)
      .send({
        identifier_type: "barcode",
        identifier_value: TENANT_WIDE_ONLY_IDENTIFIER,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: "resolved",
      product_id: PRODUCT_A_ACTIVE,
      alias_id: ALIAS_TENANT_WIDE_FALLBACK,
    });

    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND identifier_type = 'barcode'
          AND value = $2`,
      [TENANT_A, TENANT_WIDE_ONLY_IDENTIFIER],
    );
    expect(rowCount.rows[0]?.count).toBe("0");
  });

  it("store-scoped alias bound to a DIFFERENT store does NOT resolve a submission from another store (FR-030a invariant)", async () => {
    if (dockerSkipped) return;

    // The only alias for STORE-SCOPE-003 is store-scoped at STORE_A_Y.
    // A submission from STORE_A_X (same tenant, different store) MUST
    // NOT match — the lookup falls through to capture.
    contextGuard.storeId = STORE_A_X;

    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_OTHER_STORE)
      .send({
        identifier_type: "barcode",
        identifier_value: OTHER_STORE_ONLY_IDENTIFIER,
      });

    // No alias matched → 201 + unknown variant (capture path taken).
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: OTHER_STORE_ONLY_IDENTIFIER,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
      },
    });

    // Exactly one pending row created at the submitting store STORE_A_X.
    // Critically, NOT at STORE_A_Y (the alias's bound store).
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_X, OTHER_STORE_ONLY_IDENTIFIER],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // And NO row created at STORE_A_Y for this identifier.
    const otherStoreCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_Y, OTHER_STORE_ONLY_IDENTIFIER],
    );
    expect(otherStoreCount.rows[0]?.count).toBe("0");
  });
});
