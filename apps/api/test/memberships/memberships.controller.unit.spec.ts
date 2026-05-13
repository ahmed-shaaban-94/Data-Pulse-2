/**
 * memberships.controller.unit.spec.ts
 *
 * Docker-free unit coverage for MembershipsController.
 *
 * Strategy: minimal Nest app mounting only MembershipsController.
 * Guards replaced with scripted CanActivate doubles; MembershipsService
 * replaced with a hand-written fake. No Testcontainers, no DB, no network.
 *
 * The Testcontainers integration specs (memberships.controller.spec.ts and
 * memberships.patch.spec.ts) cover the full stack including RLS and real SQL.
 * This spec pins the controller's own responsibilities:
 *   - guard chain wiring (AuthGuard → TenantContextGuard → RolesGuard)
 *   - Zod body/path validation (ParseUUIDPipe, ZodValidationPipe)
 *   - response shape projection from MembershipDetail
 *   - missing request.context safety branch
 *
 * Endpoints:
 *   DELETE /api/v1/memberships/:membership_id → 204 No Content
 *   PATCH  /api/v1/memberships/:membership_id → 200 membership body
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../src/context/types";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { MembershipsController } from "../../src/memberships/memberships.controller";
import { MembershipsService } from "../../src/memberships/memberships.service";
import type { MembershipDetail } from "../../src/context/membership.repository";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID     = "0c000000-0000-7000-8000-000000000001";
const MEMBERSHIP_ID = "0c000000-0000-7000-8000-000000000002";
const USER_ID       = "0c000000-0000-7000-8000-000000000003";
const STORE_ID      = "0c000000-0000-7000-8000-000000000004";
const NOT_A_UUID    = "not-a-uuid";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeMembershipsService {
  public lastRevokeArgs: { ctx: ResolvedContext; membershipId: string } | null = null;
  public lastUpdateArgs: { ctx: ResolvedContext; membershipId: string; dto: unknown } | null = null;
  public updateResult: MembershipDetail = {
    membershipId: MEMBERSHIP_ID,
    user: { id: USER_ID, email: "user@example.com", displayName: "User One" },
    roleCode: "tenant_admin",
    storeAccessKind: "all",
    accessibleStoreIds: [],
    revokedAt: null,
  };

  async revoke(ctx: ResolvedContext, membershipId: string): Promise<void> {
    this.lastRevokeArgs = { ctx, membershipId };
  }

  async update(ctx: ResolvedContext, membershipId: string, dto: unknown): Promise<MembershipDetail> {
    this.lastUpdateArgs = { ctx, membershipId, dto };
    return this.updateResult;
  }
}

class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" = "ok";
  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<{ principal?: object }>();
    req.principal = { kind: "session", sessionId: "sess-1", userId: "user-1" };
    return true;
  }
}

class ScriptedTenantContextGuard implements CanActivate {
  public mode: "ok" | "no-tenant" | "no-context" = "ok";
  public context: ResolvedContext = {
    userId: "user-1",
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "no-tenant") throw new UnauthorizedException("Unauthorized");
    if (this.mode === "no-context") return true; // does NOT set request.context
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = this.context;
    return true;
  }
}

class ScriptedRolesGuard implements CanActivate {
  public mode: "ok" | "forbid" = "ok";
  canActivate(_ctx: ExecutionContext): boolean {
    if (this.mode === "forbid") throw new ForbiddenException("Insufficient role.");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  expect(body).toMatchObject({
    error: {
      code: expectedCode,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture — one app for all tests in this file
// ---------------------------------------------------------------------------

let app: INestApplication;
let svc: FakeMembershipsService;
let auth: ScriptedAuthGuard;
let tenant: ScriptedTenantContextGuard;
let roles: ScriptedRolesGuard;

beforeAll(async () => {
  svc    = new FakeMembershipsService();
  auth   = new ScriptedAuthGuard();
  tenant = new ScriptedTenantContextGuard();
  roles  = new ScriptedRolesGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [MembershipsController],
    providers: [
      { provide: MembershipsService, useValue: svc },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(auth)
    .overrideGuard(TenantContextGuard).useValue(tenant)
    .overrideGuard(RolesGuard).useValue(roles)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  auth.mode   = "ok";
  tenant.mode = "ok";
  roles.mode  = "ok";
  tenant.context = {
    userId: "user-1",
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
  };
  svc.lastRevokeArgs = null;
  svc.lastUpdateArgs = null;
  svc.updateResult = {
    membershipId: MEMBERSHIP_ID,
    user: { id: USER_ID, email: "user@example.com", displayName: "User One" },
    roleCode: "tenant_admin",
    storeAccessKind: "all",
    accessibleStoreIds: [],
    revokedAt: null,
  };
});

function http() {
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/memberships/:membership_id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/memberships/:membership_id", () => {
  it("happy path: returns 204 with empty body", async () => {
    const res = await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("forwards resolved context and membership_id to service.revoke", async () => {
    await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(svc.lastRevokeArgs).not.toBeNull();
    expect(svc.lastRevokeArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastRevokeArgs!.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRevokeArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastRevokeArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastRevokeArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http().delete(`/api/v1/memberships/${MEMBERSHIP_ID}`);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for a non-UUID membership_id — service not called", async () => {
    const res = await http().delete(`/api/v1/memberships/${NOT_A_UUID}`);
    expect(res.status).toBe(400);
    expect(svc.lastRevokeArgs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/memberships/:membership_id
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/memberships/:membership_id", () => {
  it("happy path (role_code only): returns 200 with mapped membership shape", async () => {
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "tenant_admin" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: MEMBERSHIP_ID,
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_code: "tenant_admin",
      store_access_kind: "all",
      accessible_store_ids: [],
      revoked_at: null,
    });
  });

  it("forwards context, membership_id, and dto to service.update", async () => {
    await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "member" });

    expect(svc.lastUpdateArgs).not.toBeNull();
    expect(svc.lastUpdateArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastUpdateArgs!.membershipId).toBe(MEMBERSHIP_ID);
    expect(svc.lastUpdateArgs!.dto).toMatchObject({ role_code: "member" });
  });

  it("maps revokedAt: null → revoked_at: null in response", async () => {
    svc.updateResult = { ...svc.updateResult, revokedAt: null };
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "tenant_admin" });

    expect(res.status).toBe(200);
    expect(res.body.revoked_at).toBeNull();
  });

  it("maps storeAccessKind='specific' and accessibleStoreIds correctly", async () => {
    svc.updateResult = {
      ...svc.updateResult,
      storeAccessKind: "specific",
      accessibleStoreIds: [STORE_ID],
    };
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ store_access_kind: "specific", store_ids: [STORE_ID] });

    expect(res.status).toBe(200);
    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.accessible_store_ids).toEqual([STORE_ID]);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "member" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "member" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "member" });
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "member" });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for a non-UUID membership_id — service not called", async () => {
    const res = await http()
      .patch(`/api/v1/memberships/${NOT_A_UUID}`)
      .send({ role_code: "member" });
    expect(res.status).toBe(400);
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for an empty body (at-least-one-field Zod rule)", async () => {
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({});
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("returns 400 for store_access_kind='specific' without store_ids", async () => {
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ store_access_kind: "specific" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastUpdateArgs).toBeNull();
  });

  it("serializes revokedAt: null → revoked_at: null (wire shape)", async () => {
    svc.updateResult = { ...svc.updateResult, revokedAt: null };
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "tenant_admin" });
    expect(res.status).toBe(200);
    expect(res.body.revoked_at).toBeNull();
  });

  it("serializes revokedAt: Date → revoked_at: ISO string (wire shape)", async () => {
    svc.updateResult = {
      ...svc.updateResult,
      revokedAt: new Date("2024-07-01T00:00:00.000Z"),
    };
    const res = await http()
      .patch(`/api/v1/memberships/${MEMBERSHIP_ID}`)
      .send({ role_code: "tenant_admin" });
    expect(res.status).toBe(200);
    expect(res.body.revoked_at).toBe("2024-07-01T00:00:00.000Z");
  });
});
