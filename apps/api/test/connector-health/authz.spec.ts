/**
 * 020-US1 / US2 (T011, T019, T020) — controller authz + object-safety sweep.
 *
 * Boots a minimal Nest app with BOTH connector-health controllers against a
 * Testcontainers Postgres 16 (RLS-active `app` pool), mirroring the 018
 * register-and-issue harness (ConfigurableContextGuard + overridden production
 * guards). Proves the controller-layer contract:
 *
 *   READ surface (cookieAuth/session-only):
 *     - list returns the tenant's instances (200) with the derived verdicts;
 *     - detail of a cross-tenant registration -> non-disclosing 404;
 *     - detail of an absent registration -> 404.
 *
 *   HEARTBEAT surface (connectorBearer):
 *     - identity is taken from request.connector (the guard context), NEVER the
 *       body: a body smuggling tenant_id/registration_id/last_seen_at is REJECTED
 *       by the strict DTO (400) — mass-assignment ban (§XII);
 *     - a valid self-reported-only body is accepted (200) and writes to the
 *       guard-identified registration;
 *     - no request.connector attached -> 401 (the guard usability predicate is
 *       proven separately in 018's connector-auth-guard.spec).
 *
 * The 018 session-only kind-check (rejecting dashboard_api bearers) is enforced
 * by SessionOnlyAdminGuard and proven in 018's session-only-admin.guard.spec —
 * overridden here, as the 018 harness does.
 *
 * Docker-gated (WSL).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { PG_POOL } from "../../src/auth/auth.module";
import { ConnectorAuthGuard } from "../../src/auth/connector-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../src/auth/session-only-admin.guard";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import {
  ConnectorHealthHeartbeatController,
  ConnectorHealthReadController,
} from "../../src/connector-health/connector-health.controller";
import { ConnectorHealthService } from "../../src/connector-health/connector-health.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  HEALTH_FIXTURE_IDS,
  REG_A_HEALTHY,
  REG_A_NEVER,
  REG_B,
  seedConnectorHealthFixture,
} from "./__support__/seed-connector-health";

const TENANT_A = HEALTH_FIXTURE_IDS.tenantA;
const ACTOR_A = HEALTH_FIXTURE_IDS.actorA;

const READ_BASE = "/api/v1/connector/health";
const HEARTBEAT = "/api/connector/v1/erpnext/health/heartbeat";

/** Overrides the read controller's session guard — publishes request.context. */
class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

/** Overrides ConnectorAuthGuard — attaches request.connector identity. */
class ConfigurableConnectorGuard implements CanActivate {
  public registrationId: string = REG_A_NEVER;
  public tenantId: string = TENANT_A;
  public attach = true;
  canActivate(ctx: ExecutionContext): boolean {
    // The production ConnectorAuthGuard throws UnauthorizedException (401) on any
    // predicate failure (missing/invalid/revoked/expired/unlinked/disabled/
    // cross-tenant). Returning `false` would yield Nest's default 403 — so model
    // the real guard's 401 by throwing the same exception type.
    if (!this.attach) throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<{
      connector?: { registrationId: string; tenantId: string; environment: string };
    }>();
    req.connector = {
      registrationId: this.registrationId,
      tenantId: this.tenantId,
      environment: "pilot",
    };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let connectorGuard: ConfigurableConnectorGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector-health authz.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConnectorHealthFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  connectorGuard = new ConfigurableConnectorGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ConnectorHealthHeartbeatController, ConnectorHealthReadController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ConnectorHealthService,
    ],
  })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue(contextGuard)
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(ConnectorAuthGuard)
    .useValue(connectorGuard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  void Reflector;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  contextGuard.tenantId = TENANT_A;
  connectorGuard.registrationId = REG_A_NEVER;
  connectorGuard.tenantId = TENANT_A;
  connectorGuard.attach = true;
  await env.admin.query(
    `DELETE FROM connector_health WHERE connector_registration_id = $1`,
    [REG_A_NEVER],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[connector-health authz.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("020-US1 — read controller (session-only)", () => {
  it("GET list returns the tenant's instances with derived verdicts", async () => {
    if (maybeSkip()) return;
    const res = await http().get(READ_BASE).expect(200);
    const ids: string[] = res.body.items.map((i: { connectorId: string }) => i.connectorId);
    expect(ids).toContain(REG_A_HEALTHY);
    expect(ids).not.toContain(REG_B); // cross-tenant absent
  });

  it("GET detail of a cross-tenant registration -> non-disclosing 404", async () => {
    if (maybeSkip()) return;
    const res = await http().get(`${READ_BASE}/${REG_B}`).expect(404);
    expect(res.body.error.code).toBeDefined();
    // Non-disclosing: no tenant data leaks.
    expect(JSON.stringify(res.body)).not.toContain(REG_B);
  });

  it("GET detail of an absent registration -> 404", async () => {
    if (maybeSkip()) return;
    await http().get(`${READ_BASE}/0c200000-0000-7000-8000-00000c020fff`).expect(404);
  });

  it("GET detail of an in-tenant registration -> 200 with the view", async () => {
    if (maybeSkip()) return;
    const res = await http().get(`${READ_BASE}/${REG_A_HEALTHY}`).expect(200);
    expect(res.body.connectorId).toBe(REG_A_HEALTHY);
    expect(["healthy", "stale"]).toContain(res.body.liveness);
  });
});

describe("020-US2 — heartbeat controller (connectorBearer, identity-from-context)", () => {
  it("a self-reported-only body is accepted (200) and writes to the guard-identified registration", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .post(HEARTBEAT)
      .send({ connectorVersion: "3.0.0", backlogIndicator: 1, erpnextReachable: true })
      .expect(200);
    expect(res.body.acknowledgedAt).toEqual(expect.any(String));
    const r = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connector_health WHERE connector_registration_id = $1`,
      [REG_A_NEVER],
    );
    expect(r.rows[0]?.n).toBe("1");
  });

  it("an empty body is accepted (200) — still records last_seen_at", async () => {
    if (maybeSkip()) return;
    await http().post(HEARTBEAT).send({}).expect(200);
  });

  it("a truly bodyless POST is accepted (200) — contract requestBody.required:false", async () => {
    if (maybeSkip()) return;
    await http().post(HEARTBEAT).expect(200);
  });

  it("a body smuggling identity (tenant_id/registration_id/last_seen_at) is REJECTED (400, §XII mass-assignment ban)", async () => {
    if (maybeSkip()) return;
    for (const leak of [
      { tenant_id: "0c200000-0000-7000-8000-00000c020b01" },
      { registration_id: REG_B },
      { connector_registration_id: REG_B },
      { last_seen_at: "2020-01-01T00:00:00.000Z" },
      { lastSeenAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      await http().post(HEARTBEAT).send({ connectorVersion: "1.0.0", ...leak }).expect(400);
    }
    // No row was written by any rejected beat.
    const r = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connector_health WHERE connector_registration_id = $1`,
      [REG_A_NEVER],
    );
    expect(r.rows[0]?.n).toBe("0");
  });

  it("the heartbeat writes to the GUARD-identified registration even if the body is otherwise valid", async () => {
    if (maybeSkip()) return;
    // Point the guard at REG_A_HEALTHY; the write must land there, not anywhere
    // a body could have named (no identity is body-assignable at all).
    connectorGuard.registrationId = REG_A_HEALTHY;
    await http().post(HEARTBEAT).send({ connectorVersion: "guard-wins" }).expect(200);
    const r = await env!.admin.query<{ connector_version: string }>(
      `SELECT connector_version FROM connector_health WHERE connector_registration_id = $1`,
      [REG_A_HEALTHY],
    );
    expect(r.rows[0]?.connector_version).toBe("guard-wins");
    // Restore healthy fixture state.
    await env!.admin.query(
      `UPDATE connector_health SET connector_version = '1.2.3' WHERE connector_registration_id = $1`,
      [REG_A_HEALTHY],
    );
  });

  it("no request.connector attached -> 401 (guard predicate failure surrogate)", async () => {
    if (maybeSkip()) return;
    connectorGuard.attach = false;
    await http().post(HEARTBEAT).send({ connectorVersion: "1.0.0" }).expect(401);
  });
});
