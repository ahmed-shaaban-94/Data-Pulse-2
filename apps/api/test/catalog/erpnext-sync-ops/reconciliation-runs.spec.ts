/**
 * 025-US3 — the console reconciliation run-history.
 *
 * Exercises `consoleListReconciliationRuns` end-to-end against Testcontainers
 * Postgres 16 (same harness; reuses the 017 seedReconciliationFixture, which
 * seeds RUN_A for tenant A + RUN_B for tenant B). Read-projection over 017
 * erpnext_reconciliation_run, newest-first.
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/reconciliation-runs
 *
 * Sub-cases (T022/T023/T024):
 *   §1 newest-first ordering + projection (runId/status/trigger/timestamps/mismatchSummary).
 *   §2 tenant isolation — tenant B's run never appears for tenant A.
 *   §3 §XII strict DTO — smuggled tenant_id → 400.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../src/auth/auth.module";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { ErpnextSyncOpsController } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller";
import { ErpnextSyncOpsReadModelService } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.read-model.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  RECONCILIATION_FIXTURE_IDS,
  RUN_A,
  RUN_B,
  seedReconciliationFixture,
} from "../erpnext-reconciliation/__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
const BASE = "/api/v1/catalog/erpnext-sync-ops/reconciliation-runs";

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
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[reconciliation-runs.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextSyncOpsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextSyncOpsReadModelService,
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
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

interface RunView {
  runId: string;
  storeId: string;
  kind: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  mismatchSummary: Record<string, number> | null;
}

describe("025-US3 §1 — run-history projection, newest-first", () => {
  it("returns tenant-A run(s) with the projected fields", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const items: RunView[] = res.body.items;
    const run = items.find((r) => r.runId === RUN_A);
    expect(run).toBeDefined();
    expect(run!.kind).toBe("stock");
    expect(["on_demand", "scheduled"]).toContain(run!.trigger);
    expect(["running", "completed", "failed"]).toContain(run!.status);
    expect(run!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("orders newest-first (startedAt descending)", async () => {
    if (skip()) return;
    const items: RunView[] = (await http().get(BASE).expect(200)).body.items;
    const times = items.map((r) => Date.parse(r.startedAt));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });
});

describe("025-US3 §2 — tenant isolation", () => {
  it("tenant A never sees tenant B's run; tenant B sees its own", async () => {
    if (skip()) return;
    const a = (await http().get(BASE).expect(200)).body.items as RunView[];
    expect(a.map((r) => r.runId)).not.toContain(RUN_B);
    contextGuard.tenantId = TENANT_B;
    const b = (await http().get(BASE).expect(200)).body.items as RunView[];
    expect(b.map((r) => r.runId)).toContain(RUN_B);
    expect(b.map((r) => r.runId)).not.toContain(RUN_A);
  });
});

describe("025-US3 §3 — §XII strict DTO", () => {
  it("a smuggled tenant_id → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });
});
