/**
 * 013-CRUD (T030–T035) — manual suggest → confirm MVP (US1, P1) 🎯.
 *
 * Exercises the tenant-admin ERPNext Item-mapping surface end-to-end against a
 * Testcontainers Postgres 16, mirroring the reconciliation integration harness
 * (ConfigurableContextGuard + overridden production guards + SpyAuditEnqueuer +
 * RLS-active PG_POOL bound to env.app).
 *
 * Routes under test (packages/contracts/openapi/catalog/erpnext-item-map.yaml):
 *   POST /api/v1/catalog/erpnext-item-mappings              (suggest, 201)
 *   GET  /api/v1/catalog/erpnext-item-mappings[?state=]     (list,    200)
 *   POST /api/v1/catalog/erpnext-item-mappings/:id/confirm  (confirm, 200)
 *
 * Sub-cases:
 *   §1 suggest happy path — lands state='suggested', confirmed_* NULL,
 *      suggestion_source='manual', version=1; body has no tenant_id/state.
 *   §2 mass-assignment ban — smuggled tenant_id/state/version/confirmed_by →
 *      400 validation_error (strict DTO, §XII).
 *   §3 idempotency / 1:1 — a 2nd active suggest for the same tenant_product_id
 *      → 409 conflict (OQ-2 1:1 active partial-unique).
 *   §4 unknown tenant_product → non-disclosing 404.
 *   §5 confirm happy path — state='confirmed' + confirmed_by/at set, version++.
 *   §6 confirm with stale version → 409 conflict (§III optimistic concurrency).
 *   §7 confirm an already-confirmed row (stale version) → 409.
 *   §8 cross-tenant confirm — tenant B confirming tenant A's mapping → 404.
 *   §9 list — returns the tenant's active mappings; state=suggested filters.
 *   §10 audit — suggest + confirm each emit exactly one audit subject.
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
import { ErpnextItemMapController } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.controller";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ITEM_MAP_FIXTURE_IDS,
  MAP_A_CONFIRMED,
  MAP_B_CONFIRMED,
  seedItemMapFixture,
} from "../__support__/seed-item-map";

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = ITEM_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const ACTOR_B = ITEM_MAP_FIXTURE_IDS.actorB;

// A tenant-A product with NO existing active mapping (PRODUCT_A_RETIRED's slot
// holds a suggested + retired row already, PRODUCT_A_ACTIVE holds the confirmed
// one — so we seed a fresh unmapped product for the suggest happy path).
const PRODUCT_A_UNMAPPED = "0a000000-0000-7000-8000-00000d013f01";
const NON_EXISTENT_PRODUCT = "0f000000-0000-7000-8000-00000000dead";

const BASE_URL = "/api/v1/catalog/erpnext-item-mappings";
const confirmUrl = (id: string) => `${BASE_URL}/${id}/confirm`;

// ---------------------------------------------------------------------------
// SpyAuditEnqueuer + ConfigurableContextGuard (reconciliation harness pattern)
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
      console.warn(`\n[suggest-confirm.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);

  // A fresh unmapped tenant-A product for the suggest happy path.
  await env.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '013 Unmapped Widget', 'standard', $3, $3)
     ON CONFLICT DO NOTHING`,
    [PRODUCT_A_UNMAPPED, TENANT_A, ACTOR_A],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextItemMapController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextItemMapService,
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
  // Remove any mappings created by suggest tests so sub-cases are independent.
  await env.admin.query(
    `DELETE FROM erpnext_item_map WHERE tenant_product_id = $1`,
    [PRODUCT_A_UNMAPPED],
  );
  // Reset the seed confirmed/suggested rows to their seeded state.
  await env.admin.query(
    `UPDATE erpnext_item_map
        SET state = 'confirmed', confirmed_by = $2, confirmed_at = now(),
            version = 1, retired_at = NULL
      WHERE id = $1`,
    [MAP_A_CONFIRMED, ACTOR_A],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[suggest-confirm.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// §1 — suggest happy path
// ---------------------------------------------------------------------------

describe("013-CRUD §1 — suggest (manual)", () => {
  it("creates a suggested mapping (state=suggested, manual, version 1)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        tenant_product_id: PRODUCT_A_UNMAPPED,
        erpnext_item_ref: "ERP-NEW-001",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenant_product_id: PRODUCT_A_UNMAPPED,
      erpnext_item_ref: "ERP-NEW-001",
      state: "suggested",
      suggestion_source: "manual",
      version: 1,
      confirmed_by: null,
      confirmed_at: null,
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

describe("013-CRUD §2 — mass-assignment ban", () => {
  it.each([
    ["tenant_id", { tenant_id: TENANT_B }],
    ["state", { state: "confirmed" }],
    ["version", { version: 99 }],
    ["confirmed_by", { confirmed_by: ACTOR_A }],
    ["suggestion_source", { suggestion_source: "barcode" }],
  ])("rejects a smuggled %s with 400 validation_error", async (_label, extra) => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        tenant_product_id: PRODUCT_A_UNMAPPED,
        erpnext_item_ref: "ERP-SMUGGLE",
        ...extra,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// §3 — 1:1 active partial-unique (second active suggest → 409)
// ---------------------------------------------------------------------------

describe("013-CRUD §3 — 1:1 (OQ-2)", () => {
  it("a 2nd active suggest for the same product → 409 conflict", async () => {
    if (maybeSkip()) return;
    const first = await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-1" });
    expect(first.status).toBe(201);
    const second = await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-2" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// §4 — unknown / out-of-scope product → non-disclosing 404
// ---------------------------------------------------------------------------

describe("013-CRUD §4 — non-disclosing 404 on suggest", () => {
  it("suggesting against a non-existent product → 404", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        tenant_product_id: NON_EXISTENT_PRODUCT,
        erpnext_item_ref: "ERP-X",
      });
    expect(res.status).toBe(404);
  });

  it("suggesting against another tenant's product → 404 (non-disclosing)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(BASE_URL)
      .send({
        tenant_product_id: ITEM_MAP_FIXTURE_IDS.productBConfirmed,
        erpnext_item_ref: "ERP-CROSS",
      });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §5 — confirm happy path
// ---------------------------------------------------------------------------

describe("013-CRUD §5 — confirm", () => {
  it("confirming a suggested row sets confirmed state + provenance, version++", async () => {
    if (maybeSkip()) return;
    // suggest first
    const suggested = await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-C1" });
    expect(suggested.status).toBe(201);
    const { id, version } = suggested.body;

    const res = await http().post(confirmUrl(id)).send({ version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      state: "confirmed",
      version: version + 1,
    });
    expect(res.body.confirmed_by).toBe(ACTOR_A);
    expect(typeof res.body.confirmed_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// §6 / §7 — optimistic concurrency (stale version → 409)
// ---------------------------------------------------------------------------

describe("013-CRUD §6 — optimistic concurrency", () => {
  it("confirm with a stale version → 409 conflict", async () => {
    if (maybeSkip()) return;
    const suggested = await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-V" });
    const { id, version } = suggested.body;
    // confirm once (version -> version+1)
    await http().post(confirmUrl(id)).send({ version });
    // confirm again with the now-stale version
    const stale = await http().post(confirmUrl(id)).send({ version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// §8 — cross-tenant confirm → non-disclosing 404
// ---------------------------------------------------------------------------

describe("013-CRUD §8 — cross-tenant confirm", () => {
  it("tenant B confirming tenant A's mapping → 404 (RLS non-disclosing)", async () => {
    if (maybeSkip()) return;
    contextGuard.tenantId = TENANT_B;
    contextGuard.userId = ACTOR_B;
    const res = await http().post(confirmUrl(MAP_A_CONFIRMED)).send({ version: 1 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §9 — list
// ---------------------------------------------------------------------------

describe("013-CRUD §9 — list", () => {
  it("lists the tenant's active mappings; never another tenant's", async () => {
    if (maybeSkip()) return;
    const res = await http().get(BASE_URL);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const ids = res.body.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(MAP_A_CONFIRMED);
    expect(ids).not.toContain(MAP_B_CONFIRMED);
  });

  it("state=suggested filters to the review queue", async () => {
    if (maybeSkip()) return;
    const res = await http().get(BASE_URL).query({ state: "suggested" });
    expect(res.status).toBe(200);
    for (const m of res.body.items as { state: string }[]) {
      expect(m.state).toBe("suggested");
    }
  });
});

// ---------------------------------------------------------------------------
// §10 — audit
// ---------------------------------------------------------------------------

describe("013-CRUD §10 — audit", () => {
  it("suggest emits exactly one audit subject", async () => {
    if (maybeSkip()) return;
    auditSpy.reset();
    await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-AUD" });
    const subjects = auditSpy.calls.map((c) => c.action);
    expect(subjects).toContain("erpnext_item_map.suggested");
    expect(auditSpy.calls).toHaveLength(1);
  });

  it("confirm emits exactly one audit subject", async () => {
    if (maybeSkip()) return;
    const suggested = await http()
      .post(BASE_URL)
      .send({ tenant_product_id: PRODUCT_A_UNMAPPED, erpnext_item_ref: "ERP-AUD2" });
    const { id, version } = suggested.body;
    auditSpy.reset();
    await http().post(confirmUrl(id)).send({ version });
    const subjects = auditSpy.calls.map((c) => c.action);
    expect(subjects).toContain("erpnext_item_map.confirmed");
    expect(auditSpy.calls).toHaveLength(1);
  });
});
