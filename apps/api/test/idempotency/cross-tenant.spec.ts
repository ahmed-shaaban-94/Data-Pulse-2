/**
 * T513 — Cross-tenant isolation test.
 *
 * Tenant A + key X and Tenant B + key X on the same route MUST be treated
 * as independent requests. Both must be processed; neither should replay
 * the other's result.
 *
 * The dedup tuple includes tenantId, so the key storage namespaces are
 * completely separate (FR-D-002 / strategy.md §11).
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

const TENANT_A = "aaaaaaaa-0000-7000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-7000-8000-000000000001";
const USER_A   = "aaaaaaaa-0000-7000-8000-000000000002";
const USER_B   = "bbbbbbbb-0000-7000-8000-000000000002";
const SHARED_KEY = "abcdef1234567890abcdef1234567890"; // same key both tenants use
const EXPIRES_AT = new Date("2026-05-17T00:00:00.000Z");

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
  async del(): Promise<void> { /* no-op */ }
}

class FakeInvitationsService {
  public callCount = 0;
  public lastTenantId: string | null = null;
  async invite(ctx: ResolvedContext): Promise<{ row: InvitationRow; roleCode: string }> {
    this.callCount++;
    this.lastTenantId = ctx.tenantId;
    const tenantId = ctx.tenantId!;
    return {
      row: {
        id: `inv-${tenantId}`,
        tenantId,
        email: "user@example.com",
        roleId: "role-1",
        storeAccessKind: "all",
        invitedStoreIds: [],
        invitedByUserId: ctx.userId ?? "unknown",
        tokenHash: Buffer.alloc(0),
        status: "pending",
        expiresAt: EXPIRES_AT,
        acceptedByUserId: null, acceptedAt: null,
        createdAt: EXPIRES_AT, updatedAt: EXPIRES_AT, deletedAt: null,
      },
      roleCode: "tenant_admin",
    };
  }
}

/** Guard that sets context based on a runtime tenant/user config. */
class ConfigurableTenantGuard implements CanActivate {
  public tenantId = TENANT_A;
  public userId = USER_A;
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ principal?: object; context?: ResolvedContext }>().principal = { userId: this.userId };
    ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>().context = {
      userId: this.userId, tenantId: this.tenantId, storeId: null,
      isPlatformAdmin: false, source: "session",
    };
    return true;
  }
}

class PassAuthGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
class PassRolesGuard implements CanActivate { canActivate(): boolean { return true; } }

let app: INestApplication;
let svc: FakeInvitationsService;
let fakeRedis: FakeRedis;
let tenantGuard: ConfigurableTenantGuard;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  tenantGuard = new ConfigurableTenantGuard();

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
    .overrideGuard(TenantContextGuard).useValue(tenantGuard)
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

const VALID_BODY = { email: "user@example.com", role_code: "tenant_admin", store_access_kind: "all" };

describe("T513 — cross-tenant isolation: same key, different tenants → independent requests", () => {
  it("tenant A request returns 201 and is processed", async () => {
    tenantGuard.tenantId = TENANT_A;
    tenantGuard.userId = USER_A;

    const res = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(svc.callCount).toBe(1);
  });

  it("tenant B request with same key is also processed (not replayed from tenant A)", async () => {
    // Tenant A makes a request first
    tenantGuard.tenantId = TENANT_A;
    tenantGuard.userId = USER_A;
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    const afterA = svc.callCount;

    // Tenant B uses the same key — must be processed as a new request
    tenantGuard.tenantId = TENANT_B;
    tenantGuard.userId = USER_B;
    const resB = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    expect(resB.status).toBe(HttpStatus.CREATED);
    // Idempotent-Replayed must NOT be present (it's a fresh request in tenant B's namespace)
    expect(resB.headers["idempotent-replayed"]).toBeUndefined();
    // Service was called once more for tenant B
    expect(svc.callCount).toBe(afterA + 1);
  });

  it("same key retried within tenant A namespace replays correctly", async () => {
    tenantGuard.tenantId = TENANT_A;
    tenantGuard.userId = USER_A;

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    const afterFirst = svc.callCount;

    const replay = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    expect(replay.status).toBe(HttpStatus.CREATED);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(svc.callCount).toBe(afterFirst); // no second call
  });
});
