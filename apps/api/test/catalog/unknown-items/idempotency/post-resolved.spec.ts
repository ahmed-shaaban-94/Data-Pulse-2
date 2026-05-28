/**
 * T536 — 005-WAVE1-IDEMP-EDGES — Post-resolved identifier → alias lookup wins.
 *
 * Acceptance (slice 005-WAVE1-IDEMP-EDGES validation contract, T536 / FR-022):
 *   GREEN — POS captures identifier `I` at `(T, S)` → a new pending
 *   `unknown_items` row R1 is created (CAPTURE-HAPPY behavior). Wave 2's
 *   eventual "link" reconciliation is simulated via direct DB writes:
 *     - `UPDATE unknown_items SET resolution_status='resolved', ...
 *        WHERE id = R1`
 *     - `INSERT INTO product_aliases (tenant_id, identifier_type, value,
 *        product_id, created_by, ...)` so the same logical identifier now
 *        resolves via the alias.
 *
 *   POS submits identifier `I` AGAIN at `(T, S)` with a NEW
 *   `Idempotency-Key` (so the IdempotencyInterceptor cannot replay the
 *   prior 201 envelope from its cache). Expected outcome:
 *     - 200 OK + discriminated `kind: "resolved"` shape carrying
 *       `product_id` (and `alias_id`) — the alias-resolution prelude in
 *       `captureItem` short-circuits before the dedup/INSERT branches.
 *     - The pre-existing `unknown_items` row count for `(T, identifier
 *       value)` stays at exactly 1 (only R1; no second pending row is
 *       inserted on the resolved branch — that's the FR-022 contract).
 *     - `unknown_item_captured_total` counter does NOT increment on the
 *       second call (the alias-hit branch returns BEFORE the INSERT, so
 *       captureItem never calls `recordUnknownItemCaptured()` —
 *       service.ts:462-471 + 479).
 *
 * Spec anchors:
 *   - FR-022: post-resolved identifier → alias lookup wins (the catalog
 *     service's alias-resolution prelude takes precedence over both the
 *     pending-dedup branch AND the capture fallthrough).
 *   - FR-021 boundary: this scenario also confirms that the idempotency
 *     interceptor does NOT mask the resolved/unknown shape divergence —
 *     a NEW `Idempotency-Key` on the second call ensures the interceptor
 *     computes fresh, and the OUTCOME comes entirely from the service
 *     layer's alias lookup.
 *
 * Wave-status note (already on main per PR #321):
 *   The alias-resolution prelude in `UnknownItemsService.captureItem` is
 *   active. T513 (`capture-resolves-to-alias.spec.ts`) proves the
 *   resolved branch against the seeded `ALIAS_A_BARCODE` row. This spec
 *   constructs the alias DYNAMICALLY mid-test (mimicking Wave 2's
 *   eventual link reconciliation), which exercises the same prelude
 *   from a different starting state (a previously-captured pending row
 *   gets "linked" by an out-of-band actor).
 *
 * Wiring strategy
 * ---------------
 * Mirrors `retry-identical.spec.ts` (T530 / PR #336) — same real-route
 * Testcontainer fixture, FakeRedis + FakeMarker, ConfigurableContextGuard.
 * The post-capture mutation (mark resolved + insert alias) runs through
 * `env.admin.query(...)` per the established inline-seed pattern from
 * `capture-deduplicates-pending.spec.ts:31-38` (the harness is forbidden
 * to edit, so per-spec seeds use `admin.query`).
 *
 * Why two different `Idempotency-Key` values?
 *   T536 / FR-022 verifies the SERVICE-LAYER alias-resolution prelude
 *   takes precedence over `unknown_items` natural dedup AND over the
 *   capture fallthrough. The idempotency interceptor sits at a different
 *   layer entirely; if we reused the first call's key the interceptor
 *   would replay the cached 201 envelope and never reach the service —
 *   that would be a (useful, but separate) replay test, not the FR-022
 *   proof. Using a NEW key forces the interceptor to compute fresh and
 *   lets the service's alias prelude do its job.
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
import { IdempotencyKeyStore, newId } from "@data-pulse-2/shared";

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

const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005d1";

/** Idempotency-Key for the FIRST capture (creates R1). */
const IDEMP_KEY_FIRST = "abcdef1234567890abcdef1234567536";
/**
 * Idempotency-Key for the SECOND capture (after the simulated link). MUST
 * differ from the first — see the file-header note for why a new key is
 * required to reach the service's alias-resolution prelude.
 */
const IDEMP_KEY_SECOND = "abcdef1234567890abcdef1234567537";

/** Identifier value used across both POST calls. Distinct namespace so
 * the afterEach cleanup is precise and does not collide with other
 * idempotency specs in this directory. */
const IDENTIFIER_VALUE = "T536-POST-RESOLVED-001";

// ---------------------------------------------------------------------------
// FakeRedis / FakeMarker / ConfigurableContextGuard / Audit stub
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
let dynamicAliasId: string | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T536 post-resolved.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
      // idempotency over an already-resolved item — admin isolates the
      // lifecycle assertion from RLS, not the data-access path. RLS coverage
      // for the data path is asserted by capture-happy-path.spec.ts. Pattern:
      // dismiss-audit.spec.ts:162-164.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.admin },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
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
    // Clean up the dynamically-inserted alias FIRST (FK references
    // tenant_products which is harness-owned; we only need to scrub
    // T536-prefixed rows).
    if (dynamicAliasId) {
      await env.admin.query(
        "DELETE FROM product_aliases WHERE id = $1",
        [dynamicAliasId],
      );
      dynamicAliasId = null;
    }
    await env.admin.query(
      "DELETE FROM unknown_items WHERE value LIKE 'T536-POST-RESOLVED-%'",
    );
  }
  recordSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T536 — FR-022 post-resolved → alias lookup wins
// ---------------------------------------------------------------------------

describe("T536 / 005-WAVE1-IDEMP-EDGES — FR-022 post-resolved identifier → alias prelude wins", () => {
  it("after a captured row is linked via Wave-2-style reconciliation, a re-capture returns resolved (no new row, no capture counter)", async () => {
    if (dockerSkipped) return;

    const body = {
      identifier_type: "barcode" as const,
      identifier_value: IDENTIFIER_VALUE,
    };

    // ---- Step 1 — POS submits I → captured as pending row R1 ----------
    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_FIRST)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: IDENTIFIER_VALUE,
        resolution_status: "pending",
      },
    });
    const r1Id: string = first.body.unknown_item.id;
    expect(r1Id).toMatch(/^[0-9a-f-]{36}$/i);

    // First capture fired the counter once.
    expect(captureCounter).toBe(1);

    // Drain the interceptor's fire-and-forget save tap before mutating
    // anything (defensive against the next call accidentally observing
    // a half-flushed cache state).
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // ---- Step 2 — Simulate Wave 2 "link" reconciliation ---------------
    //
    // 2a) Mark R1 as resolved/linked. The 003
    //     `unknown_items_resolved_fields_consistent` CHK requires
    //     `resolution_action`, `resolved_at`, `resolved_by`, and
    //     `resolved_product_id` ALL non-null when status='resolved'
    //     (and `resolved_product_id` only non-null when
    //     action='linked'/'created'). We use action='linked' so the
    //     `resolved_product_id` column is satisfied — that matches the
    //     Wave 2 semantic ("the captured identifier was linked to an
    //     existing product").
    expect(env).not.toBeNull();
    await env!.admin.query(
      `UPDATE unknown_items
          SET resolution_status   = 'resolved',
              resolution_action   = 'linked',
              resolved_at         = now(),
              resolved_by         = $2,
              resolved_product_id = $3
        WHERE id = $1`,
      [r1Id, ACTOR_A, PRODUCT_A_ACTIVE],
    );

    // 2b) Insert a tenant-wide `product_aliases` row mapping the same
    //     `(tenant_id, identifier_type, value)` to PRODUCT_A_ACTIVE.
    //     `store_id=NULL` keeps it tenant-wide (resolves at any store
    //     of TENANT_A). The 0007 catalog migration's
    //     `product_aliases_store_scope_consistency` CHK (store_id IS
    //     NULL OR identifier_type <> 'external_pos_id') is satisfied
    //     because we use 'barcode'. `source_system` is NULL because
    //     that column is required only for 'external_pos_id' aliases.
    //     `created_by` is NOT NULL — uses ACTOR_A from the harness.
    dynamicAliasId = newId();
    await env!.admin.query(
      `INSERT INTO product_aliases
         (id, tenant_id, product_id, identifier_type, value,
          source_system, store_id, created_by)
       VALUES
         ($1, $2, $3, 'barcode', $4, NULL, NULL, $5)`,
      [
        dynamicAliasId,
        TENANT_A,
        PRODUCT_A_ACTIVE,
        IDENTIFIER_VALUE,
        ACTOR_A,
      ],
    );

    // Sanity: exactly one row at (TENANT_A, IDENTIFIER_VALUE) BEFORE
    // the second submit. R1 is now resolved (not pending).
    const preCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, IDENTIFIER_VALUE],
    );
    expect(preCount.rows[0]?.count).toBe("1");

    // Reset the capture counter so we can isolate the SECOND call's
    // effect on it. The first call's counter increment was a valid
    // CAPTURE-HAPPY side-effect; this assertion now isolates the
    // FR-022 "no new INSERT, no counter" property for the resolved
    // branch.
    captureCounter = 0;

    // ---- Step 3 — POS submits I again with a NEW Idempotency-Key -----
    //
    // The idempotency interceptor computes fresh (different key →
    // different dedup tuple). The service's alias-resolution prelude
    // (`captureItem` first SELECT on `product_aliases`) MUST hit the
    // alias we just inserted, returning the `resolved` outcome BEFORE
    // any `unknown_items` INSERT.
    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY_SECOND)
      .send(body);

    // FR-022: alias hit → 200, not 201.
    expect(second.status).toBe(200);

    // Discriminated PosCaptureResolvedResponse shape per contract.
    expect(second.body).toEqual({
      kind: "resolved",
      product_id: PRODUCT_A_ACTIVE,
      alias_id: dynamicAliasId,
    });

    // No `Idempotent-Replayed` header — the second key is fresh, the
    // interceptor computed.
    expect(second.headers["idempotent-replayed"]).toBeUndefined();

    // FR-022: NO new `unknown_items` row was created on the resolved
    // branch (captureItem short-circuits before INSERT). The pre-existing
    // resolved R1 is still the only row for this identifier.
    const postCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1 AND value = $2`,
      [TENANT_A, IDENTIFIER_VALUE],
    );
    expect(postCount.rows[0]?.count).toBe("1");

    // ... and that one row is still R1, still resolved/linked.
    const r1State = await env!.admin.query<{
      id: string;
      resolution_status: string;
      resolution_action: string;
      resolved_product_id: string;
    }>(
      `SELECT id, resolution_status, resolution_action, resolved_product_id
         FROM unknown_items
        WHERE id = $1`,
      [r1Id],
    );
    expect(r1State.rows[0]?.resolution_status).toBe("resolved");
    expect(r1State.rows[0]?.resolution_action).toBe("linked");
    expect(r1State.rows[0]?.resolved_product_id).toBe(PRODUCT_A_ACTIVE);

    // The capture counter did NOT fire on the resolved branch. service.ts
    // documents this at lines 462-471 + 479 — `recordUnknownItemCaptured()`
    // is only called on the FRESH-INSERT path.
    expect(captureCounter).toBe(0);

    // No mismatch audit was fired.
    expect(
      auditSpy.calls.filter(
        (c) => c.action === "unknown_item.idempotency_mismatch_rejected",
      ),
    ).toHaveLength(0);
  });
});
