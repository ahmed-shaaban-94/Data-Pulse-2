/**
 * T642 — 005-WAVE2-AUDIT — Create-new action audit emission + dual-emission guard (RED).
 *
 * Spec anchors: FR-080 (audit subject on resolve), tasks.md L477 (no
 *               dual-emission of catalog.product.create).
 *
 * A successful create-new emits exactly one `unknown_item.resolved.created`
 * audit payload AND zero `catalog.product.create` payloads. The dual-emission
 * guard is the reason createProductFromUnknownItem owns the raw
 * INSERT INTO tenant_products rather than calling TenantCatalogService.create
 * (which emits its own catalog.product.create audit row in-transaction). This
 * spec's catalog.product.create==0 assertion is the regression tripwire that
 * would catch a future refactor reintroducing that call.
 *
 * Harness: ReconciliationController + ReconciliationService against
 * Testcontainers Postgres 16. AuditEmitterInterceptor + SpyAuditEnqueuer.
 * PG_POOL bound to localEnv.app (RLS-active). Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";

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

const UNK_T642_CREATE = "0a000000-0000-7000-8000-00000642a001";
const UNK_T642_CREATE_CORR = "0a000000-0000-7000-8000-000006420c01";
const T642_BARCODE = "T642-CREATE-AUDIT-001";
const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006420001";

const CREATE_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/create-product`;
const CREATE_BODY = { name: "Widget T642", tax_category: "standard" };

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
  public storeId: string | null = STORE_A_X;
  public userId: string = TENANT_A_ADMIN_USER;

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
      console.warn(
        `\n[T642 create-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [UNK_T642_CREATE, TENANT_A, STORE_A_X, T642_BARCODE, UNK_T642_CREATE_CORR],
  );

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
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
  auditSpy.reset();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = TENANT_A_ADMIN_USER;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  // Reset U1 to pending + scrub the created product so the test is repeatable.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'pending',
            resolution_action   = NULL,
            resolved_at         = NULL,
            resolved_by         = NULL,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_T642_CREATE],
  );
  await env.admin.query(
    `DELETE FROM product_aliases WHERE tenant_id = $1 AND value = $2`,
    [TENANT_A, T642_BARCODE],
  );
  await env.admin.query(
    `DELETE FROM tenant_products WHERE tenant_id = $1 AND name = $2`,
    [TENANT_A, CREATE_BODY.name],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("T642 / 005-WAVE2-AUDIT — create-new emits resolved.created; no dual emission [FR-080]", () => {
  it(
    "emits exactly one unknown_item.resolved.created event attributed to the actor",
    async () => {
      if (dockerSkipped) return;

      const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
      expect(res.status).toBe(201);

      await drainMicrotasks();

      const createdEvents = auditSpy.calls.filter(
        (c) => c.action === "unknown_item.resolved.created",
      );
      expect(createdEvents).toHaveLength(1);

      const payload = createdEvents[0]!;
      expect(payload.tenant_id).toBe(TENANT_A);
      expect(payload.store_id).toBe(STORE_A_X);
      expect(payload.actor_user_id).toBe(TENANT_A_ADMIN_USER);
    },
  );

  it(
    "DUAL-EMISSION GUARD: emits ZERO catalog.product.create events (tasks.md L477)",
    async () => {
      if (dockerSkipped) return;

      const res = await http().post(CREATE_URL(UNK_T642_CREATE)).send(CREATE_BODY);
      expect(res.status).toBe(201);

      await drainMicrotasks();

      // The whole reason createProductFromUnknownItem uses a raw
      // INSERT INTO tenant_products instead of TenantCatalogService.create is
      // to avoid a second `catalog.product.create` audit row. If a future
      // refactor reintroduces that call, this assertion fails loudly.
      const productCreateEvents = auditSpy.calls.filter(
        (c) => c.action === "catalog.product.create",
      );
      expect(productCreateEvents).toHaveLength(0);
    },
  );
});
