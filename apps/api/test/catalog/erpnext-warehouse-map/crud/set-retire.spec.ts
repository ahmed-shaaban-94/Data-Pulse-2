/**
 * 014-CRUD (T030–T034) — manual set → list → retire MVP (US1, P1) 🎯.
 *
 * Exercises the tenant-admin store↔ERPNext-Warehouse mapping surface end-to-end
 * against a Testcontainers Postgres 16, mirroring the 013 suggest-confirm
 * harness (ConfigurableContextGuard + overridden production guards +
 * SpyAuditEnqueuer + RLS-active PG_POOL bound to env.app).
 *
 * Routes under test (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml):
 *   POST /api/v1/catalog/erpnext-warehouse-mappings              (set,    201)
 *   GET  /api/v1/catalog/erpnext-warehouse-mappings              (list,   200)
 *   POST /api/v1/catalog/erpnext-warehouse-mappings/:id/retire   (retire, 200)
 *
 * Sub-cases:
 *   §1 set happy path — lands purpose='stock', version=1; body has no
 *      tenant_id/purpose; §IV projection (no raw entity).
 *   §2 mass-assignment ban — smuggled tenant_id/purpose/version/set_by →
 *      400 validation_error (strict DTO, §XII).
 *   §3 idempotency / 1:1 — a 2nd active set for the same store_id → 409 conflict
 *      (OQ-2 1:1 active partial-unique on (tenant, store, 'stock')).
 *   §4 unknown / cross-tenant store → non-disclosing 404.
 *   §5 retire happy path — sets retired_at + version++.
 *   §6 retire with stale version → 409 conflict (§III optimistic concurrency).
 *   §7 re-point — retire then a fresh set for the same store succeeds (append-only).
 *   §8 cross-tenant retire — tenant B retiring tenant A's mapping → 404.
 *   §9 list — returns the tenant's active mappings; never another tenant's.
 *   §10 audit — set + retire each emit exactly one audit subject.
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

import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import { ErpnextWarehouseMapController } from "../../../../src/catalog/erpnext-warehouse-map/erpnext-warehouse-map.controller";
import { ErpnextWarehouseMapService } from "../../../../src/catalog/erpnext-warehouse-map/erpnext-warehouse-map.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  WAREHOUSE_MAP_FIXTURE_IDS,
  MAP_A_STOCK,
  MAP_B_STOCK,
  seedWarehouseMapFixture,
} from "../__support__/seed-warehouse-map";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const TENANT_A = WAREHOUSE_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = WAREHOUSE_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = WAREHOUSE_MAP_FIXTURE_IDS.actorA;
const ACTOR_B = WAREHOUSE_MAP_FIXTURE_IDS.actorB;

// A tenant-A store with NO existing active mapping (STORE_A_X holds the active
// 'stock' one, STORE_A_Y holds a retired row — so we seed a fresh unmapped
// store for the set happy path).
const STORE_A_UNMAPPED = "0a000000-0000-7000-8000-00000d014f01";
const NON_EXISTENT_STORE = "0f000000-0000-7000-8000-00000000dead";

const BASE_URL = "/api/v1/catalog/erpnext-warehouse-mappings";
const retireUrl = (id: string) => `${BASE_URL}/${id}/retire`;

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer + ConfigurableContextGuard (013 harness pattern)
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

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null; // tenant-wide admin; no store axis
  public userId: string = ACTOR_A;

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
      source: "session",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
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
      console.warn(`\n[set-retire.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedWarehouseMapFixture(env);

  // A fresh unmapped tenant-A store for the set happy path.
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $2, 'AUNM', '014 Unmapped Store')
     ON CONFLICT DO NOTHING`,
    [STORE_A_UNMAPPED, TENANT_A],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextWarehouseMapController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextWarehouseMapService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
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
  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Remove any mappings created against the unmapped store so sub-cases are
  // independent.
  await env.admin.query(
    `DELETE FROM erpnext_warehouse_map WHERE store_id = $1`,
    [STORE_A_UNMAPPED],
  );
  // Reset the seed active 'stock' row to its seeded state (un-retire / v1).
  await env.admin.query(
    `UPDATE erpnext_warehouse_map
        SET version = 1, retired_at = NULL
      WHERE id = $1`,
    [MAP_A_STOCK],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[set-retire.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// §1 — set happy path
// ---------------------------------------------------------------------------

describe("014-CRUD §1 — set (manual)", () => {
  it("creates a mapping (purpose='stock', version 1)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        store_id: STORE_A_UNMAPPED,
        erpnext_warehouse_ref: "ERP-NEW-001",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      store_id: STORE_A_UNMAPPED,
      erpnext_warehouse_ref: "ERP-NEW-001",
      purpose: "stock",
      version: 1,
      retired_at: null,
    });
    expect(typeof res.body.id).toBe("string");
    // No raw DB entity leakage — only the projected fields (§IV).
    expect(res.body).not.toHaveProperty("tenant_id");
    expect(res.body).not.toHaveProperty("correlation_id");
  });
});

// ---------------------------------------------------------------------------
// §2 — mass-assignment ban (§XII strict DTO)
// ---------------------------------------------------------------------------

describe("014-CRUD §2 — mass-assignment ban", () => {
  it.each([
    ["tenant_id", { tenant_id: TENANT_B }],
    ["purpose", { purpose: "returns" }],
    ["version", { version: 99 }],
    ["set_by", { set_by: ACTOR_A }],
  ])("rejects a smuggled %s with 400 validation_error", async (_label, extra) => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        store_id: STORE_A_UNMAPPED,
        erpnext_warehouse_ref: "ERP-SMUGGLE",
        ...extra,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// §3 — 1:1 active partial-unique (second active set → 409)
// ---------------------------------------------------------------------------

describe("014-CRUD §3 — 1:1 (OQ-2)", () => {
  it("a 2nd active set for the same store → 409 conflict", async () => {
    if (maybeSkip()) return;
    const first = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-1" });
    expect(first.status).toBe(201);
    const second = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-2" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// §4 — unknown / out-of-scope store → non-disclosing 404
// ---------------------------------------------------------------------------

describe("014-CRUD §4 — non-disclosing 404 on set", () => {
  it("setting against a non-existent store → 404", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        store_id: NON_EXISTENT_STORE,
        erpnext_warehouse_ref: "ERP-X",
      });
    expect(res.status).toBe(404);
  });

  it("setting against another tenant's store → 404 (non-disclosing)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        store_id: WAREHOUSE_MAP_FIXTURE_IDS.storeBMapped,
        erpnext_warehouse_ref: "ERP-CROSS",
      });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §5 — retire happy path
// ---------------------------------------------------------------------------

describe("014-CRUD §5 — retire", () => {
  it("retiring an active mapping sets retired_at + version++", async () => {
    if (maybeSkip()) return;
    const set = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-R1" });
    expect(set.status).toBe(201);
    const { id, version } = set.body;

    const res = await http().post(retireUrl(id)).send({ version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, version: version + 1 });
    expect(typeof res.body.retired_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// §6 — optimistic concurrency (stale version → 409)
// ---------------------------------------------------------------------------

describe("014-CRUD §6 — optimistic concurrency", () => {
  it("retire with a stale version → 409 conflict", async () => {
    if (maybeSkip()) return;
    const set = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-V" });
    const { id, version } = set.body;
    // retire once (version -> version+1)
    await http().post(retireUrl(id)).send({ version });
    // retire again with the now-stale version
    const stale = await http().post(retireUrl(id)).send({ version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// §7 — re-point (retire + fresh set, append-only)
// ---------------------------------------------------------------------------

describe("014-CRUD §7 — re-point (append-only)", () => {
  it("after retiring, a fresh set for the same store succeeds", async () => {
    if (maybeSkip()) return;
    const first = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-OLD" });
    expect(first.status).toBe(201);
    const retired = await http()
      .post(retireUrl(first.body.id))
      .send({ version: first.body.version });
    expect(retired.status).toBe(200);
    const second = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-NEW" });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});

// ---------------------------------------------------------------------------
// §8 — cross-tenant retire → non-disclosing 404
// ---------------------------------------------------------------------------

describe("014-CRUD §8 — cross-tenant retire", () => {
  it("tenant B retiring tenant A's mapping → 404 (RLS non-disclosing)", async () => {
    if (maybeSkip()) return;
    contextGuard.tenantId = TENANT_B;
    contextGuard.userId = ACTOR_B;
    const res = await http().post(retireUrl(MAP_A_STOCK)).send({ version: 1 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §9 — list
// ---------------------------------------------------------------------------

describe("014-CRUD §9 — list", () => {
  it("lists the tenant's active mappings; never another tenant's", async () => {
    if (maybeSkip()) return;
    const res = await http().get(BASE_URL);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const ids = res.body.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(MAP_A_STOCK);
    expect(ids).not.toContain(MAP_B_STOCK);
  });

  it("never returns retired mappings", async () => {
    if (maybeSkip()) return;
    const res = await http().get(BASE_URL);
    expect(res.status).toBe(200);
    for (const m of res.body.items as { retired_at: string | null }[]) {
      expect(m.retired_at).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// §10 — audit
// ---------------------------------------------------------------------------

describe("014-CRUD §10 — audit", () => {
  it("set emits exactly one audit subject", async () => {
    if (maybeSkip()) return;
    auditSpy.reset();
    await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-AUD" });
    const subjects = auditSpy.calls.map((c) => c.action);
    expect(subjects).toContain("erpnext_warehouse_map.set");
    expect(auditSpy.calls).toHaveLength(1);
  });

  it("retire emits exactly one audit subject", async () => {
    if (maybeSkip()) return;
    const set = await http()
      .post(BASE_URL)
      .send({ store_id: STORE_A_UNMAPPED, erpnext_warehouse_ref: "ERP-AUD2" });
    const { id, version } = set.body;
    auditSpy.reset();
    await http().post(retireUrl(id)).send({ version });
    const subjects = auditSpy.calls.map((c) => c.action);
    expect(subjects).toContain("erpnext_warehouse_map.retired");
    expect(auditSpy.calls).toHaveLength(1);
  });
});
