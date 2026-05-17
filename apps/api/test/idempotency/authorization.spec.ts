/**
 * T518 — Authorization preservation test.
 *
 * FR-D-009 / strategy.md §6.3:
 *   "The replay returns the original authorization decision, not a fresh one."
 *
 * When user A retries the same key with the same body:
 *   - The original response is replayed (service not invoked again).
 *   - The replayed body contains the data from the original response
 *     (including the invitation id created by user A's first call).
 *
 * Cross-user isolation:
 *   Users A and B share the same tenant but have different `userId` values.
 *   The dedup tuple includes `clientId` (= userId), so user A's key X and
 *   user B's key X are distinct tuples → both are processed independently.
 *   This asserts FR-D-002 (same key, different client = independent requests).
 *
 * Docker-free unit test.
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

const TENANT_ID     = "0d000000-0000-7000-8000-000000000001";
const USER_A        = "aaaaaaaa-0000-7000-8000-000000000001";
const USER_B        = "bbbbbbbb-0000-7000-8000-000000000001";
const INVITATION_A  = "inv-aaaa-0000-7000-8000-000000000001";
const INVITATION_B  = "inv-bbbb-0000-7000-8000-000000000001";
const ROLE_ID       = "0d000000-0000-7000-8000-000000000003";
const SHARED_KEY    = "abcdef1234567890abcdef1234567890";
const EXPIRES_AT    = new Date("2026-05-17T00:00:00.000Z");

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
  public lastUserId: string | null = null;

  async invite(ctx: ResolvedContext): Promise<{ row: InvitationRow; roleCode: string }> {
    this.callCount++;
    this.lastUserId = ctx.userId;
    const invId = ctx.userId === USER_A ? INVITATION_A : INVITATION_B;
    return {
      row: {
        id: invId,
        tenantId: TENANT_ID,
        email: "user@example.com",
        roleId: ROLE_ID,
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

class ConfigurableContextGuard implements CanActivate {
  public userId = USER_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ principal?: object; context?: ResolvedContext }>();
    req.principal = { userId: this.userId };
    req.context = {
      userId: this.userId, tenantId: TENANT_ID, storeId: null,
      isPlatformAdmin: false, source: "session",
    };
    return true;
  }
}

class PassAuthGuard implements CanActivate { canActivate(): boolean { return true; } }
class PassRolesGuard implements CanActivate { canActivate(): boolean { return true; } }

let app: INestApplication;
let svc: FakeInvitationsService;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;

beforeAll(async () => {
  svc = new FakeInvitationsService();
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  contextGuard = new ConfigurableContextGuard();

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
    .overrideGuard(TenantContextGuard).useValue(contextGuard)
    .overrideGuard(RolesGuard).useValue(new PassRolesGuard())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => { if (app) await app.close(); });
beforeEach(() => { svc.callCount = 0; fakeRedis.clear(); svc.lastUserId = null; });

function http() { return request(app.getHttpServer()); }

describe("T518 — authorization preservation: replay returns original actor's response", () => {
  it("same user retrying: replay returns original response with Idempotent-Replayed: true", async () => {
    contextGuard.userId = USER_A;

    // First call
    const original = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);
    expect(original.status).toBe(HttpStatus.CREATED);
    expect(original.body.id).toBe(INVITATION_A);
    const firstCallCount = svc.callCount;

    // Same user retrying
    const replay = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    expect(replay.status).toBe(HttpStatus.CREATED);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.id).toBe(INVITATION_A); // original actor's invitation
    expect(svc.callCount).toBe(firstCallCount); // service NOT re-invoked
  });

  it("replay body reflects original call's response (authorization decision at original call time)", async () => {
    contextGuard.userId = USER_A;

    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    // Replay
    const replay = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    // The body was captured at the original call time and is returned as-is
    expect(replay.body.tenant_id).toBe(TENANT_ID);
    expect(replay.body.status).toBe("pending");
  });

  it("cross-client isolation: user A and user B use same key independently (separate tuples)", async () => {
    // User A requests
    contextGuard.userId = USER_A;
    const resA = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);
    expect(resA.status).toBe(HttpStatus.CREATED);
    expect(resA.body.id).toBe(INVITATION_A);
    expect(resA.headers["idempotent-replayed"]).toBeUndefined();

    // User B uses same key — different clientId tuple → processed independently
    contextGuard.userId = USER_B;
    const resB = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);
    expect(resB.status).toBe(HttpStatus.CREATED);
    expect(resB.body.id).toBe(INVITATION_B); // user B's own invitation
    expect(resB.headers["idempotent-replayed"]).toBeUndefined(); // fresh, not a replay
  });

  it("cross-client: user B replaying their own key gets their own original response", async () => {
    contextGuard.userId = USER_A;
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    contextGuard.userId = USER_B;
    await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    // User B retries with same key
    const replayB = await http()
      .post("/api/v1/memberships/invite")
      .set("Idempotency-Key", SHARED_KEY)
      .send(VALID_BODY);

    expect(replayB.status).toBe(HttpStatus.CREATED);
    expect(replayB.headers["idempotent-replayed"]).toBe("true");
    expect(replayB.body.id).toBe(INVITATION_B); // user B's result, NOT user A's
  });
});
