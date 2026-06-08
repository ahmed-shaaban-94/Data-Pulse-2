/**
 * #530 — IdempotencyInterceptor tenant-partition on connector routes.
 *
 * Connector-facing routes (`@UseGuards(ConnectorAuthGuard)`, e.g. the 015
 * posting-ack + 019 bin-view-report surfaces) do NOT run `TenantContextGuard`, so
 * `req.context` is undefined on them — only `req.principal` (the connector token,
 * carrying a non-null `tenantId`) is set. Before the fix, `tenantId(ctx)` read only
 * `req.context?.tenantId` → collapsed to null/"no-tenant" → two tenants sharing an
 * Idempotency-Key collided in one partition (a cross-tenant dedup/replay LEAK).
 *
 * This spec proves the fix: with NO `req.context` and a token principal, the
 * partition is scoped to `principal.tenantId`, so the SAME key + SAME body from
 * tenant A and tenant B do NOT collide — each is its own first-write (handler runs
 * for both; neither replays the other's stored response).
 *
 * Docker-free: FakeRedis + FakeMarker, same pattern as the 001/005 idempotency specs.
 */
import "reflect-metadata";
import {
  Body,
  Controller,
  Post,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../src/idempotency/idempotency.interceptor";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../src/idempotency/in-progress-marker";

const TENANT_A = "0a000000-0000-7000-8000-0000000005a0";
const TENANT_B = "0b000000-0000-7000-8000-0000000005b0";
// One human admin's userId — the SAME on both tenants' connector tokens (the
// real-world collision precondition: memberships UNIQUE is (tenant_id, user_id)).
const SHARED_ADMIN = "0c000000-0000-7000-8000-0000000005c0";
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";
const BODY = { entries: [], readAt: "2026-06-08T10:00:00.000Z" };

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

class HandlerCounter {
  public calls = 0;
}
const COUNTER = new HandlerCounter();

@Controller("/api/connector/v1/test")
class ConnectorIdempController {
  @Post("report")
  @Idempotent("required")
  report(@Body() body: unknown): { ok: true; tenantEcho: string } {
    COUNTER.calls += 1;
    // Echo something tenant-specific so a cross-tenant REPLAY would be detectable.
    return { ok: true, tenantEcho: (body as { _t?: string })._t ?? "?" };
  }
}

/**
 * Connector-shaped guard: sets ONLY `req.principal` (a token principal with a
 * tenantId) — NO `req.context` (mirrors ConnectorAuthGuard, which doesn't run
 * TenantContextGuard). Configurable tenant per request.
 */
class ConnectorPrincipalGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: unknown;
      principal?: unknown;
    }>();
    // Deliberately NO req.context.
    req.principal = {
      kind: "token",
      tokenId: "tok-1",
      tenantId: this.tenantId,
      userId: SHARED_ADMIN,
      storeId: null,
      scope: "connector",
    };
    return true;
  }
}

describe("#530 — connector-route idempotency is tenant-partitioned via principal", () => {
  let app: INestApplication;
  let redis: FakeRedis;
  const guard = new ConnectorPrincipalGuard();

  beforeAll(async () => {
    redis = new FakeRedis();
    const store = new IdempotencyKeyStore({
      redis,
      pgWriter: { async insert(): Promise<void> {} },
      pgReader: { async find(): Promise<null> { return null; } },
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorIdempController],
      providers: [
        Reflector,
        { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
        { provide: INFLIGHT_REDIS, useValue: new FakeRedis() },
        { provide: InProgressMarker, useFactory: () => new FakeMarker() },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalGuards(guard);
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    COUNTER.calls = 0;
    redis.clear();
  });

  it("same key + same body from TWO tenants do NOT collide (no cross-tenant replay)", async () => {
    const http = () => request(app.getHttpServer());

    // Tenant A: first write — handler runs, response stored under A's partition.
    guard.tenantId = TENANT_A;
    const a = await http()
      .post("/api/connector/v1/test/report")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ ...BODY, _t: "A" })
      .expect(201);
    expect(a.body.tenantEcho).toBe("A");
    expect(COUNTER.calls).toBe(1);

    // Tenant B: SAME key, but B's own partition → handler runs AGAIN (not a replay
    // of A). Before the fix this collided in the null/"no-tenant" partition and B
    // either 409'd or replayed A's "A" echo. After the fix B gets its own "B".
    guard.tenantId = TENANT_B;
    const b = await http()
      .post("/api/connector/v1/test/report")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ ...BODY, _t: "B" })
      .expect(201);
    expect(b.body.tenantEcho).toBe("B");
    expect(COUNTER.calls).toBe(2);
  });

  it("same tenant + same key + same body still replays (no double handler call)", async () => {
    const http = () => request(app.getHttpServer());
    guard.tenantId = TENANT_A;
    await http()
      .post("/api/connector/v1/test/report")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ ...BODY, _t: "A" })
      .expect(201);
    // Identical retry within the same tenant → replay, handler NOT called again.
    await http()
      .post("/api/connector/v1/test/report")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({ ...BODY, _t: "A" })
      .expect(201);
    expect(COUNTER.calls).toBe(1);
  });
});
