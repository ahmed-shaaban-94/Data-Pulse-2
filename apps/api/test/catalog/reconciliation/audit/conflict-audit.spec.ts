/**
 * T644 — 005-WAVE2-AUDIT — Conflict-rejection audit emission (RED).
 *
 * Spec anchors: FR-043, FR-082 — every reconciliation rejection emits
 *               `unknown_item.reconciliation_conflict_rejected` with the
 *               discriminating reason in metadata.
 *
 * The AuditEmitterInterceptor only fires on the success (tap.next) path — a
 * thrown 4xx never reaches it. So the rejection events are emitted explicitly
 * by ReconciliationService AFTER the transaction resolves/rolls back (T645).
 * This spec drives all three reasons through the LINK route (which can produce
 * all three) and asserts the rejection event + reason:
 *
 *   (a) alias_conflict      — link to a product whose store-scoped alias
 *                             collides with the item's identifier.
 *   (b) target_unavailable  — link to a retired product.
 *   (c) already_reconciled  — link to a pre-resolved item.
 *
 * not_found is intentionally NOT audited — a non-disclosing 404 must not
 * confirm the item's existence via an audit row (SI-001 / FR-092).
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
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
} from "../../__support__/isolation-harness";

// alias_conflict fixture: store-scoped alias at STORE_A_X + item sharing it.
const UNK_T644_CONFLICT = "0a000000-0000-7000-8000-00000644c001";
const UNK_T644_CONFLICT_CORR = "0a000000-0000-7000-8000-000006440c01";
const T644_CONFLICT_BARCODE = "T644-CONFLICT-001";
const ALIAS_T644_SCOPED = "0a000000-0000-7000-8000-000006440a01";

// target_unavailable fixture: item linked to a retired product.
const UNK_T644_RETIRED = "0a000000-0000-7000-8000-00000644c002";
const UNK_T644_RETIRED_CORR = "0a000000-0000-7000-8000-000006440c02";
const T644_RETIRED_BARCODE = "T644-RETIRED-001";

// already_reconciled fixture: item pre-resolved before the link attempt.
const UNK_T644_RESOLVED = "0a000000-0000-7000-8000-00000644c003";
const UNK_T644_RESOLVED_CORR = "0a000000-0000-7000-8000-000006440c03";
const T644_RESOLVED_BARCODE = "T644-RESOLVED-001";

const TENANT_A_ADMIN_USER = "0a000000-0000-7000-8000-000006440001";

const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;
const REJECTION_ACTION = "unknown_item.reconciliation_conflict_rejected";

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
        `\n[T644 conflict-audit.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Store-scoped alias for the alias_conflict case.
  await env.admin.query(
    `INSERT INTO product_aliases
       (id, tenant_id, product_id, identifier_type, value,
        source_system, store_id, created_by)
     VALUES ($1, $2, $3, 'barcode', $4, NULL, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      ALIAS_T644_SCOPED,
      TENANT_A,
      PRODUCT_A_ACTIVE,
      T644_CONFLICT_BARCODE,
      STORE_A_X,
      TENANT_A_ADMIN_USER,
    ],
  );

  // Two PENDING unknown items (conflict + retired-target cases).
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value,
        source_system, resolution_status, correlation_id)
     VALUES
       ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5),
       ($6, $2, $3, 'barcode', $7, NULL, 'pending', $8)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T644_CONFLICT, TENANT_A, STORE_A_X, T644_CONFLICT_BARCODE, UNK_T644_CONFLICT_CORR,
      UNK_T644_RETIRED, T644_RETIRED_BARCODE, UNK_T644_RETIRED_CORR,
    ],
  );

  // Pre-RESOLVED item for the already_reconciled case. All resolved fields
  // must be consistent per unknown_items_resolved_fields_consistent +
  // unknown_items_linked_product_present (0007_catalog.sql:414-425):
  // non-pending => resolved_at/resolved_by/resolution_action NOT NULL, and
  // action 'linked'/'created' => resolved_product_id NOT NULL.
  await env.admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by,
        resolved_product_id, correlation_id)
     VALUES ($1, $2, $3, 'barcode', $4, NULL,
             'resolved', 'linked', now(), $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      UNK_T644_RESOLVED, TENANT_A, STORE_A_X, T644_RESOLVED_BARCODE,
      TENANT_A_ADMIN_USER, PRODUCT_A_ACTIVE, UNK_T644_RESOLVED_CORR,
    ],
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

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function rejectionEvents(): AuditJobPayload[] {
  return auditSpy.calls.filter((c) => c.action === REJECTION_ACTION);
}

describe("T644 / 005-WAVE2-AUDIT — conflict-rejection audit emission [FR-043, FR-082]", () => {
  it(
    "(a) alias_conflict rejection emits reconciliation_conflict_rejected{reason=alias_conflict}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_CONFLICT))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("alias_conflict");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "alias_conflict" });
      expect(events[0]!.tenant_id).toBe(TENANT_A);
      expect(events[0]!.actor_user_id).toBe(TENANT_A_ADMIN_USER);
    },
  );

  it(
    "(b) target_unavailable rejection emits reconciliation_conflict_rejected{reason=target_unavailable}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_RETIRED))
        .send({ product_id: PRODUCT_A_RETIRED });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("target_unavailable");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "target_unavailable" });
    },
  );

  it(
    "(c) already_reconciled rejection emits reconciliation_conflict_rejected{reason=already_reconciled}",
    async () => {
      if (dockerSkipped) return;

      const res = await http()
        .post(LINK_URL(UNK_T644_RESOLVED))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("already_reconciled");

      await drainMicrotasks();

      const events = rejectionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ reason: "already_reconciled" });
    },
  );

  it(
    "(d) not_found does NOT emit a rejection event (non-disclosing per SI-001 / FR-092)",
    async () => {
      if (dockerSkipped) return;

      const FABRICATED = "0a000000-0000-7000-8000-0000064400ff";
      const res = await http()
        .post(LINK_URL(FABRICATED))
        .send({ product_id: PRODUCT_A_ACTIVE });
      expect(res.status).toBe(404);

      await drainMicrotasks();

      // No audit row — a non-disclosing 404 must not confirm existence.
      expect(rejectionEvents()).toHaveLength(0);
    },
  );
});
