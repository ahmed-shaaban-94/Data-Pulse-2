/**
 * T516 — Missing-header policy test.
 *
 * `@Idempotent('required')` on createInvitation:
 *   - Missing Idempotency-Key → 400 Bad Request with error code
 *     `idempotency_key_required` (wrapped in uniform error envelope).
 *   - Malformed Idempotency-Key (too short / non-ASCII) → 400.
 *   - Valid Idempotency-Key → passes through.
 *
 * strategy.md §2.2 / §12.2.
 */
import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { InvitationsController } from "../../src/memberships/invitations.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import { InProgressMarker, INFLIGHT_REDIS } from "../../src/idempotency/in-progress-marker";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import type { InvitationRow } from "@data-pulse-2/db/schema";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import type { ResolvedContext } from "../../src/context/types";

const TENANT_ID = "0d000000-0000-7000-8000-000000000001";
const USER_ID = "0d000000-0000-7000-8000-000000000004";
const VALID_KEY = "abcdef1234567890abcdef1234567890"; // 32 chars
const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

const VALID_BODY = { email: "user@example.com", role_code: "tenant_admin", store_access_kind: "all" };

class FakeRedis {
  private store: Map<string, { value: string; expiresAt: number }> = new Map();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expiresAt) { this.store.delete(key); return null; }
    return e.value;
  }
  async set(key: string, value: string, opts: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + opts.px });
    return "OK";
  }
  clear(): void { this.store.clear(); }
}

class FakeMarker {
  async trySet(): Promise<boolean> { return true; }
  async del(): Promise<void> {}
}

class FakeInvitationsService {
  public callCount = 0;
  async invite(): Promise<{ row: InvitationRow; roleCode: string }> {
    this.callCount++;
    return {
      row: {
        id: "inv-1", tenantId: TENANT_ID, email: "user@example.com",
        roleId: "role-1", storeAccessKind: "all", invitedStoreIds: [],
        invitedByUserId: USER_ID, tokenHash: Buffer.alloc(0),
        status: "pending", expiresAt: EXPIRES_AT,
        acceptedByUserId: null, acceptedAt: null,
        createdAt: EXPIRES_AT, updatedAt: EXPIRES_AT, deletedAt: null,
      },
      roleCode: "tenant_admin",
    };
  }
}

class PassAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ principal?: object }>().principal = { userId: USER_ID };
    return true;
  }
}
class PassTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>().context = {
      userId: USER_ID, tenantId: TENANT_ID, storeId: null,
      isPlatformAdmin: false, source: "session",
    };
    return true;
  }
}
class PassRolesGuard implements CanActivate { canActivate(): boolean { return true; } }

let app: INestApplication;
let svc: FakeInvitationsService;
let fakeRedis: FakeRedis;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();

  const store = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const interceptor = new IdempotencyInterceptor(reflector, store, fakeMarker as unknown as InProgressMarker);

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: svc },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(new PassAuthGuard())
    .overrideGuard(TenantContextGuard).useValue(new PassTenantGuard())
    .overrideGuard(RolesGuard).useValue(new PassRolesGuard())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => { if (app) await app.close(); });
beforeEach(() => { svc.callCount = 0; fakeRedis.clear(); });

function http() { return request(app.getHttpServer()); }

describe("T516 — missing header policy: required → 400, valid header → passes", () => {
  it("missing Idempotency-Key header → 400 Bad Request", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("missing header returns error envelope with code validation_error or idempotency_key_required", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(res.body).toHaveProperty("error");
    // The exception filter maps BadRequestException to 400; check code
    expect(res.body.error.code).toMatch(/validation_error|idempotency_key_required/);
  });

  it("service is NOT called when header is missing", async () => {
    await http()
      .post("/api/v1/memberships/invite")
      .send(VALID_BODY);
    expect(svc.callCount).toBe(0);
  });

  it("too-short key (< 16 chars) → 400", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", "short")
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("key longer than 128 chars → 400", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", "a".repeat(129))
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("key with whitespace → 400", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", "has a space in it padding12345")
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it("valid key (32 printable ASCII chars) → 201", async () => {
    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", VALID_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(HttpStatus.CREATED);
    expect(svc.callCount).toBe(1);
  });
});
