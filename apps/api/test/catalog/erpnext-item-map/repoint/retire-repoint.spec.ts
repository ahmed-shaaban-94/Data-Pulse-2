/**
 * 013-REPOINT (T040–T042) — append-only retire / re-point (US2, P2).
 *
 * Re-point is append-only per the contract + data-model §6: the old active row
 * is RETIRED (retired_at set), then a FRESH suggested row is created via the
 * suggest op — never an in-place identity rewrite. The contract exposes a
 * single `tenantAdminRetireErpnextItemMapping` op
 * (POST /:id/retire, versioned); a re-point is retire-then-suggest (the
 * contract description is explicit). Because retire removes the old row from
 * the ACTIVE set (retired_at IS NOT NULL), the 1:1 active partial-unique
 * (OQ-2) admits the fresh suggest for the same product.
 *
 * Sub-cases:
 *   §1 retire happy path — sets retired_at, version++; row leaves the active set.
 *   §2 retire with stale version → 409 conflict (§III).
 *   §3 retire an already-retired row → 409 (idempotency / lifecycle guard).
 *   §4 cross-tenant retire → non-disclosing 404.
 *   §5 re-point sequence — retire old + suggest new succeeds; the 1:1
 *      partial-unique holds across the transition; history preserved (old row
 *      retained, retired).
 *   §6 FK restrict — retiring the underlying tenant_products row is blocked
 *      while a mapping references it (ON DELETE RESTRICT; data-model §6).
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
  seedItemMapFixture,
} from "../__support__/seed-item-map";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = ITEM_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const ACTOR_B = ITEM_MAP_FIXTURE_IDS.actorB;

const PRODUCT_A_REPOINT = "0a000000-0000-7000-8000-00000d013f02";

const BASE_URL = "/api/v1/catalog/erpnext-item-mappings";
const retireUrl = (id: string) => `${BASE_URL}/${id}/retire`;

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
  public storeId: string | null = null;
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
      console.warn(`\n[retire-repoint.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);

  await env.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '013 Repoint Widget', 'standard', $3, $3)
     ON CONFLICT DO NOTHING`,
    [PRODUCT_A_REPOINT, TENANT_A, ACTOR_A],
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
  await env.admin.query(
    `DELETE FROM erpnext_item_map WHERE tenant_product_id = $1`,
    [PRODUCT_A_REPOINT],
  );
  // Restore MAP_A_CONFIRMED to active confirmed in case a test retired it.
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
    console.warn("[retire-repoint.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function suggest(productId: string, ref: string) {
  return http().post(BASE_URL).send({ tenant_product_id: productId, erpnext_item_ref: ref });
}

// ---------------------------------------------------------------------------
// §1 — retire happy path
// ---------------------------------------------------------------------------

describe("013-REPOINT §1 — retire", () => {
  it("retires an active mapping (retired_at set, version++)", async () => {
    if (maybeSkip()) return;
    const s = await suggest(PRODUCT_A_REPOINT, "ERP-R1");
    const { id, version } = s.body;
    const res = await http().post(retireUrl(id)).send({ version });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.retired_at).not.toBeNull();
    expect(res.body.version).toBe(version + 1);
  });
});

// ---------------------------------------------------------------------------
// §2 / §3 — version + lifecycle guards
// ---------------------------------------------------------------------------

describe("013-REPOINT §2 — optimistic concurrency", () => {
  it("retire with stale version → 409", async () => {
    if (maybeSkip()) return;
    const s = await suggest(PRODUCT_A_REPOINT, "ERP-R2");
    const { id, version } = s.body;
    await http().post(retireUrl(id)).send({ version }); // version -> +1
    const stale = await http().post(retireUrl(id)).send({ version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });

  it("retiring an already-retired row → 409", async () => {
    if (maybeSkip()) return;
    const s = await suggest(PRODUCT_A_REPOINT, "ERP-R3");
    const { id, version } = s.body;
    const first = await http().post(retireUrl(id)).send({ version });
    expect(first.status).toBe(200);
    // current version is now version+1, but the row is retired → 409
    const again = await http()
      .post(retireUrl(id))
      .send({ version: version + 1 });
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// §4 — cross-tenant retire → 404
// ---------------------------------------------------------------------------

describe("013-REPOINT §4 — cross-tenant retire", () => {
  it("tenant B retiring tenant A's mapping → 404", async () => {
    if (maybeSkip()) return;
    contextGuard.tenantId = TENANT_B;
    contextGuard.userId = ACTOR_B;
    const res = await http().post(retireUrl(MAP_A_CONFIRMED)).send({ version: 1 });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// §5 — re-point sequence (retire old + suggest new; 1:1 holds; history kept)
// ---------------------------------------------------------------------------

describe("013-REPOINT §5 — re-point (append-only)", () => {
  it("retire old + suggest new succeeds; 1:1 holds; old row retained", async () => {
    if (maybeSkip()) return;
    // initial mapping
    const first = await suggest(PRODUCT_A_REPOINT, "ERP-OLD");
    const oldId = first.body.id;
    const oldVersion = first.body.version;

    // a 2nd active suggest BEFORE retiring must fail (1:1)
    const blocked = await suggest(PRODUCT_A_REPOINT, "ERP-NEW");
    expect(blocked.status).toBe(409);

    // retire the old row → it leaves the active set
    const retired = await http().post(retireUrl(oldId)).send({ version: oldVersion });
    expect(retired.status).toBe(200);

    // now the fresh suggest for the SAME product succeeds (re-point complete)
    const repointed = await suggest(PRODUCT_A_REPOINT, "ERP-NEW");
    expect(repointed.status).toBe(201);
    expect(repointed.body.id).not.toBe(oldId);
    expect(repointed.body.erpnext_item_ref).toBe("ERP-NEW");

    // history preserved: the old row is still present + retired
    const list = await http().get(BASE_URL);
    const ids = list.body.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(repointed.body.id);
    expect(ids).not.toContain(oldId); // list returns ACTIVE only
    // but the old row exists in the table (retired)
    const raw = await env!.admin.query<{ id: string; retired_at: Date | null }>(
      `SELECT id, retired_at FROM erpnext_item_map WHERE id = $1`,
      [oldId],
    );
    expect(raw.rows[0]?.retired_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §6 — FK restrict (data-model §6)
// ---------------------------------------------------------------------------

describe("013-REPOINT §6 — FK restrict on tenant_products", () => {
  it("deleting the underlying tenant_products row is blocked while mapped", async () => {
    if (maybeSkip()) return;
    await suggest(PRODUCT_A_REPOINT, "ERP-FK");
    let caught: (Error & { code?: string }) | undefined;
    try {
      // admin (RLS-bypass) delete still hits the FK ON DELETE RESTRICT.
      await env!.admin.query(`DELETE FROM tenant_products WHERE id = $1`, [
        PRODUCT_A_REPOINT,
      ]);
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("23503"); // foreign_key_violation (RESTRICT)
  });
});
