/**
 * T515 — Expiry test.
 *
 * A key past the 72h replay window is treated as a new request.
 * The original response is no longer replayed (strategy.md §6.5 / §10).
 *
 * Uses a controllable clock injected into IdempotencyKeyStore.
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
const IDEMPOTENCY_KEY = "abcdef1234567890abcdef1234567890";
const EXPIRES_AT = new Date("2030-01-01T00:00:00.000Z");

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

function buildApp(clock: () => Date) {
  let app: INestApplication;
  let svc: FakeInvitationsService;
  let fakeRedis: FakeRedis;

  return {
    async init() {
      svc = new FakeInvitationsService();
      fakeRedis = new FakeRedis();
      const fakeMarker = new FakeMarker();

      const store = new IdempotencyKeyStore({
        redis: fakeRedis,
        pgWriter: { async insert() {} },
        pgReader: { async find() { return null; } },
        defaultTtlMs: 72 * 60 * 60 * 1000,
        clock,
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
      return { app, svc, fakeRedis };
    },
  };
}

describe("T515 — expiry: key past 72h window treated as new request", () => {
  it("within window: replay returns cached response", async () => {
    const now = Date.now();
    const clock = jest.fn().mockReturnValue(new Date(now));
    const { app, svc, fakeRedis } = await buildApp(clock).init();

    try {
      fakeRedis.clear();
      svc.callCount = 0;

      // First request
      await request(app.getHttpServer())
        .post("/api/v1/memberships/invite")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(VALID_BODY);

      // Advance clock slightly (1 hour) — still within 72h
      clock.mockReturnValue(new Date(now + 1 * 60 * 60 * 1000));

      const replay = await request(app.getHttpServer())
        .post("/api/v1/memberships/invite")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(VALID_BODY);

      expect(replay.status).toBe(HttpStatus.CREATED);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
    } finally {
      await app.close();
    }
  });

  it("past 72h window: retry is treated as new request (no replay header)", async () => {
    const now = Date.now();
    const clock = jest.fn().mockReturnValue(new Date(now));
    const { app, svc, fakeRedis } = await buildApp(clock).init();

    try {
      fakeRedis.clear();
      svc.callCount = 0;

      // First request at T=0
      await request(app.getHttpServer())
        .post("/api/v1/memberships/invite")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(VALID_BODY);

      const afterFirst = svc.callCount;

      // Advance clock by 73 hours — past 72h window
      clock.mockReturnValue(new Date(now + 73 * 60 * 60 * 1000));

      const res = await request(app.getHttpServer())
        .post("/api/v1/memberships/invite")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(VALID_BODY);

      // Treated as new — handler invoked again, no replay header
      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.headers["idempotent-replayed"]).toBeUndefined();
      expect(svc.callCount).toBeGreaterThan(afterFirst);
    } finally {
      await app.close();
    }
  });
});
