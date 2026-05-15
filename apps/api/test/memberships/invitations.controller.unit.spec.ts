/**
 * invitations.controller.unit.spec.ts
 *
 * Docker-free unit coverage for InvitationsController.
 *
 * Strategy: minimal Nest app mounting only InvitationsController.
 * Guards replaced with scripted CanActivate doubles; InvitationsService
 * replaced with a hand-written fake. No Testcontainers, no DB, no network.
 *
 * Endpoint:
 *   POST /api/v1/memberships/invite → 201 invitation body
 *
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

import { InvitationsController } from "../../src/memberships/invitations.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import type { InvitationRow } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Fixed UUIDs
// ---------------------------------------------------------------------------

const TENANT_ID     = "0d000000-0000-7000-8000-000000000001";
const INVITATION_ID = "0d000000-0000-7000-8000-000000000002";
const ROLE_ID       = "0d000000-0000-7000-8000-000000000003";
const USER_ID       = "0d000000-0000-7000-8000-000000000004";
const STORE_ID      = "0d000000-0000-7000-8000-000000000005";
const ROLE_CODE     = "tenant_admin";

const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeInvitationsService {
  public lastInviteArgs: { ctx: ResolvedContext; dto: unknown } | null = null;
  public inviteRow: InvitationRow = {
    id: INVITATION_ID,
    tenantId: TENANT_ID,
    email: "user@example.com",
    roleId: ROLE_ID,
    storeAccessKind: "all",
    invitedStoreIds: [],
    invitedByUserId: USER_ID,
    tokenHash: Buffer.alloc(0),
    status: "pending",
    expiresAt: EXPIRES_AT,
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: EXPIRES_AT,
    updatedAt: EXPIRES_AT,
    deletedAt: null,
  };
  public inviteRoleCode: string = ROLE_CODE;

  async invite(ctx: ResolvedContext, dto: unknown): Promise<{ row: InvitationRow; roleCode: string }> {
    this.lastInviteArgs = { ctx, dto };
    return { row: this.inviteRow, roleCode: this.inviteRoleCode };
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
// Fixture
// ---------------------------------------------------------------------------

let app: INestApplication;
let svc: FakeInvitationsService;
let auth: ScriptedAuthGuard;
let tenant: ScriptedTenantContextGuard;
let roles: ScriptedRolesGuard;

beforeAll(async () => {
  svc    = new FakeInvitationsService();
  auth   = new ScriptedAuthGuard();
  tenant = new ScriptedTenantContextGuard();
  roles  = new ScriptedRolesGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: svc },
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
  svc.lastInviteArgs = null;
  svc.inviteRow = {
    id: INVITATION_ID,
    tenantId: TENANT_ID,
    email: "user@example.com",
    roleId: ROLE_ID,
    storeAccessKind: "all",
    invitedStoreIds: [],
    invitedByUserId: USER_ID,
    tokenHash: Buffer.alloc(0),
    status: "pending",
    expiresAt: EXPIRES_AT,
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: EXPIRES_AT,
    updatedAt: EXPIRES_AT,
    deletedAt: null,
  };
  svc.inviteRoleCode = ROLE_CODE;
});

function http() {
  return request(app.getHttpServer());
}

const VALID_BODY = {
  email: "USER@Example.COM",
  role_code: "tenant_admin",
  store_access_kind: "all",
};

// ---------------------------------------------------------------------------
// POST /api/v1/memberships/invite
// ---------------------------------------------------------------------------

describe("POST /api/v1/memberships/invite", () => {
  it("happy path: returns 201", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it("Zod pipe normalizes email (trim + toLowerCase) before passing to service", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .send({ ...VALID_BODY, email: "  ADMIN@EXAMPLE.COM  " });

    expect(svc.lastInviteArgs).not.toBeNull();
    const dto = svc.lastInviteArgs!.dto as { email: string };
    expect(dto.email).toBe("admin@example.com");
  });

  it("forwards resolved context and dto to service.invite", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);

    expect(svc.lastInviteArgs).not.toBeNull();
    expect(svc.lastInviteArgs!.ctx.tenantId).toBe(TENANT_ID);
    expect(svc.lastInviteArgs!.dto).toMatchObject({
      role_code: "tenant_admin",
      store_access_kind: "all",
    });
  });

  it("response projection: maps InvitationRow fields and returns role_code (not role_id)", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: INVITATION_ID,
      tenant_id: TENANT_ID,
      email: "user@example.com",
      role_code: ROLE_CODE,
      store_access_kind: "all",
      invited_store_ids: [],
      status: "pending",
    });
    expect(res.body.expires_at).toBeDefined();
  });

  it("response does NOT expose role_id", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).not.toContain("role_id");
  });

  it("specific-store invite: forwards store_ids in dto", async () => {
    svc.inviteRow = {
      ...svc.inviteRow,
      storeAccessKind: "specific",
      invitedStoreIds: [STORE_ID],
    };

    const res = await http()
      .post("/api/v1/memberships/invite")
      .send({
        ...VALID_BODY,
        store_access_kind: "specific",
        store_ids: [STORE_ID],
      });

    expect(res.status).toBe(201);
    expect(res.body.store_access_kind).toBe("specific");
    expect(res.body.invited_store_ids).toEqual([STORE_ID]);
  });

  it("returns 401 when AuthGuard rejects — service not called", async () => {
    auth.mode = "reject";
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastInviteArgs).toBeNull();
  });

  it("returns 401 when TenantContextGuard rejects — service not called", async () => {
    tenant.mode = "no-tenant";
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
    expect(svc.lastInviteArgs).toBeNull();
  });

  it("returns 403 when RolesGuard rejects — service not called", async () => {
    roles.mode = "forbid";
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, "forbidden");
    expect(svc.lastInviteArgs).toBeNull();
  });

  it("returns 401 when request.context is absent despite guards passing", async () => {
    tenant.mode = "no-context";
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, "unauthorized");
  });

  it("returns 400 for invalid email — service not called", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send({ ...VALID_BODY, email: "not-an-email" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastInviteArgs).toBeNull();
  });

  it("returns 400 for store_access_kind='specific' without store_ids — service not called", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send({ ...VALID_BODY, store_access_kind: "specific" });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastInviteArgs).toBeNull();
  });

  it("returns 400 for store_access_kind='all' with non-empty store_ids — service not called", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send({ ...VALID_BODY, store_access_kind: "all", store_ids: [STORE_ID] });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, "validation_error");
    expect(svc.lastInviteArgs).toBeNull();
  });
});
