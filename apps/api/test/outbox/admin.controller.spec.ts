/**
 * apps/api/test/outbox/admin.controller.spec.ts (T591, 1C-C1)
 *
 * Docker-free unit coverage for `OutboxAdminController`.
 *
 * Strategy: minimal Nest app mounting only the controller, with scripted
 * `CanActivate` doubles for `DashboardAuthGuard` + `RolesGuard` and a
 * hand-written fake `OutboxAdminService`. No Testcontainers, no DB, no
 * network.
 *
 * Coverage matrix:
 *   * Auth posture: 401 (unauthed), 403 (non-platform-admin), 200 (admin).
 *   * Redaction:    response key allowlist, PII canary never appears.
 *   * Functional:   list shape, empty page, single-item page, pagination
 *                   envelope, filters threaded to service.
 *   * Detail:       404 for missing/non-dead-lettered, 200 for present,
 *                   400 for non-UUID eventId param.
 *
 * The real `RolesGuard.denyAs` / DB-context behaviour is exercised in
 * the integration layer (`packages/db/__tests__/outbox/repository.dead-letter.spec.ts`).
 * Here we pin guard-wiring + response-projection only.
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
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

import { OutboxAdminController } from "../../src/outbox/admin.controller";
import { OutboxAdminService } from "../../src/outbox/admin.service";
import type {
  ListOutboxDeadLettersResponse,
  OutboxDeadLetterDto,
} from "../../src/outbox/admin.dto";

// ---------------------------------------------------------------------------
// Fixed UUIDs + PII canary
// ---------------------------------------------------------------------------
const TENANT_A = "0a195b10-0000-7000-8000-000000000001";
const TENANT_B = "0a195b10-0000-7000-8000-000000000002";
const EVENT_1 = "0e195b10-0000-7000-8000-000000000001";
const EVENT_2 = "0e195b10-0000-7000-8000-000000000002";
const NOT_DL_EVENT = "0e195b10-0000-7000-8000-0000000000aa";
const NON_EXISTENT_EVENT = "0e195b10-0000-7000-8000-0000000000bb";
const CORR_ID = "0c195b10-0000-7000-8000-000000000001";
const PII_CANARY = "pii-canary@example.test";

// ---------------------------------------------------------------------------
// Scripted guard doubles
// ---------------------------------------------------------------------------

type AuthMode = "unauth" | "non-admin" | "platform-admin";
let authMode: AuthMode = "platform-admin";

class ScriptedAuthGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    if (authMode === "unauth") throw new UnauthorizedException("Unauthorized");
    return true;
  }
}

class ScriptedRolesGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    if (authMode === "non-admin") {
      // RolesGuard's PlatformAdminOnly branch throws 403 with this exact message.
      throw new ForbiddenException("Platform admin role required.");
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Hand-written fake service
// ---------------------------------------------------------------------------

class FakeOutboxAdminService {
  public listResponse: ListOutboxDeadLettersResponse = {
    items: [],
    next_cursor: null,
  };
  public detailResponse: OutboxDeadLetterDto | null = null;

  public lastListInput: unknown = null;
  public lastDetailEventId: string | null = null;

  async list(input: unknown): Promise<ListOutboxDeadLettersResponse> {
    this.lastListInput = input;
    return this.listResponse;
  }

  async get(eventId: string): Promise<OutboxDeadLetterDto | null> {
    this.lastDetailEventId = eventId;
    return this.detailResponse;
  }
}

function makeDto(overrides: Partial<OutboxDeadLetterDto> = {}): OutboxDeadLetterDto {
  return {
    event_id: EVENT_1,
    event_type: "audit.event.created",
    tenant_id: TENANT_A,
    store_id: null,
    delivery_state: "dead_lettered" as const,
    attempts: 8,
    correlation_id: CORR_ID,
    last_error_class: "ConsumerTimeout",
    occurred_at: "2026-05-19T10:00:00.000Z",
    created_at: "2026-05-19T10:00:00.000Z",
    updated_at: "2026-05-19T11:30:00.000Z",
    processed_at: "2026-05-19T11:30:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let app: INestApplication;
let fakeService: FakeOutboxAdminService;

beforeAll(async () => {
  fakeService = new FakeOutboxAdminService();

  const moduleRef = await Test.createTestingModule({
    controllers: [OutboxAdminController],
    providers: [{ provide: OutboxAdminService, useValue: fakeService }],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new ScriptedAuthGuard())
    .overrideGuard(RolesGuard)
    .useValue(new ScriptedRolesGuard())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 30_000);

beforeEach(() => {
  authMode = "platform-admin";
  fakeService.listResponse = { items: [], next_cursor: null };
  fakeService.detailResponse = null;
  fakeService.lastListInput = null;
  fakeService.lastDetailEventId = null;
});

function http() {
  return request(app.getHttpServer());
}

// ===========================================================================
// Auth matrix (AC-1)
// ===========================================================================
describe("auth matrix (AC-1)", () => {
  it("unauthenticated -> 401 on list", async () => {
    authMode = "unauth";
    await http().get("/api/v1/admin/outbox/dead-letters").expect(401);
  });

  it("unauthenticated -> 401 on detail", async () => {
    authMode = "unauth";
    await http().get(`/api/v1/admin/outbox/dead-letters/${EVENT_1}`).expect(401);
  });

  it("authenticated non-admin -> 403 on list", async () => {
    authMode = "non-admin";
    await http().get("/api/v1/admin/outbox/dead-letters").expect(403);
  });

  it("authenticated non-admin -> 403 on detail", async () => {
    authMode = "non-admin";
    await http().get(`/api/v1/admin/outbox/dead-letters/${EVENT_1}`).expect(403);
  });

  it("platform-admin -> 200 on list", async () => {
    await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
  });
});

// ===========================================================================
// List response shape + redaction (AC-2)
// ===========================================================================
describe("list response shape and redaction (AC-2)", () => {
  it("empty page -> { items: [], next_cursor: null }", async () => {
    const res = await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
    expect(res.body).toEqual({ items: [], next_cursor: null });
  });

  it("single-item page projects the DTO verbatim and includes next_cursor when set", async () => {
    fakeService.listResponse = {
      items: [makeDto()],
      next_cursor: "dGVzdC1jdXJzb3I",
    };
    const res = await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.next_cursor).toBe("dGVzdC1jdXJzb3I");
    const item = res.body.items[0];
    expect(new Set(Object.keys(item))).toEqual(
      new Set([
        "event_id",
        "event_type",
        "tenant_id",
        "store_id",
        "delivery_state",
        "attempts",
        "correlation_id",
        "last_error_class",
        "occurred_at",
        "created_at",
        "updated_at",
        "processed_at",
      ]),
    );
  });

  it("safe path: when the service hands a properly-redacted DTO, no PII canary appears", async () => {
    fakeService.listResponse = {
      items: [makeDto()],
      next_cursor: null,
    };
    const res = await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
    expect(JSON.stringify(res.body)).not.toContain(PII_CANARY);
  });

  it("last_error_class accepts null in the wire shape", async () => {
    fakeService.listResponse = {
      items: [makeDto({ last_error_class: null })],
      next_cursor: null,
    };
    const res = await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
    expect(res.body.items[0].last_error_class).toBeNull();
  });

  it("last_error_class is a bare class identifier when non-null (pattern probe)", async () => {
    fakeService.listResponse = {
      items: [makeDto({ last_error_class: "ConsumerTimeout" })],
      next_cursor: null,
    };
    const res = await http().get("/api/v1/admin/outbox/dead-letters").expect(200);
    const lec = res.body.items[0].last_error_class;
    expect(typeof lec).toBe("string");
    expect(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(lec)).toBe(true);
  });
});

// ===========================================================================
// List query threading (AC-3)
// ===========================================================================
describe("query param threading (AC-3)", () => {
  it("forwards event_type to the service", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?event_type=audit.event.created")
      .expect(200);
    expect(fakeService.lastListInput).toMatchObject({
      eventType: "audit.event.created",
    });
  });

  it("forwards tenant_id to the service", async () => {
    await http()
      .get(`/api/v1/admin/outbox/dead-letters?tenant_id=${TENANT_B}`)
      .expect(200);
    expect(fakeService.lastListInput).toMatchObject({ tenantId: TENANT_B });
  });

  it("rejects a malformed tenant_id with 400", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?tenant_id=not-a-uuid")
      .expect(400);
  });

  it("rejects a malformed cursor with 400", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?cursor=not%21base64")
      .expect(400);
  });

  it("rejects out-of-range limit with 400", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?limit=0")
      .expect(400);
    await http()
      .get("/api/v1/admin/outbox/dead-letters?limit=999")
      .expect(400);
  });

  it("rejects non-integer limit with 400", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?limit=10.5")
      .expect(400);
    await http()
      .get("/api/v1/admin/outbox/dead-letters?limit=abc")
      .expect(400);
  });

  it("accepts a well-formed cursor and forwards the µs-precision tuple", async () => {
    // CodeRabbit review on PR #240: the cursor's timestamp half is now
    // a verbatim microsecond-precision timestamptz text token (NOT a
    // JS Date) so keyset pagination preserves sub-millisecond ordering.
    // The base64url payload encodes the exact 27-char shape produced by
    // the repository's `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
    // projection -- 6 fractional digits, trailing Z.
    const occurredAtText = "2026-05-19T10:00:00.123456Z";
    const cursor = Buffer.from(
      `${occurredAtText}|${EVENT_1}`,
      "utf8",
    ).toString("base64url");
    await http()
      .get(`/api/v1/admin/outbox/dead-letters?cursor=${cursor}`)
      .expect(200);
    expect(fakeService.lastListInput).toMatchObject({
      cursor: {
        occurredAtText,
        eventId: EVENT_1,
      },
    });
    const decoded = (
      fakeService.lastListInput as { cursor: { occurredAtText: string } }
    ).cursor;
    // The string is forwarded verbatim -- no Date round-trip.
    expect(typeof decoded.occurredAtText).toBe("string");
    expect(decoded.occurredAtText).toBe(occurredAtText);
  });

  it("rejects unknown query keys with 400 (strict schema)", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters?bogus=1")
      .expect(400);
  });
});

// ===========================================================================
// Detail endpoint (AC-4)
// ===========================================================================
describe("detail endpoint (AC-4)", () => {
  it("returns 200 with the DTO when the service finds a dead-letter", async () => {
    fakeService.detailResponse = makeDto({ event_id: EVENT_1 });
    const res = await http()
      .get(`/api/v1/admin/outbox/dead-letters/${EVENT_1}`)
      .expect(200);
    expect(res.body.event_id).toBe(EVENT_1);
    expect(res.body.delivery_state).toBe("dead_lettered");
  });

  it("returns 404 when the service returns null (row missing OR not dead_lettered)", async () => {
    fakeService.detailResponse = null;
    await http()
      .get(`/api/v1/admin/outbox/dead-letters/${NON_EXISTENT_EVENT}`)
      .expect(404);
    // The service was called with the path param.
    expect(fakeService.lastDetailEventId).toBe(NON_EXISTENT_EVENT);

    fakeService.detailResponse = null;
    await http()
      .get(`/api/v1/admin/outbox/dead-letters/${NOT_DL_EVENT}`)
      .expect(404);
  });

  it("returns 400 for a non-UUID eventId path param (ParseUUIDPipe)", async () => {
    await http()
      .get("/api/v1/admin/outbox/dead-letters/not-a-uuid")
      .expect(400);
  });

  it("never returns a payload key on the detail endpoint either", async () => {
    fakeService.detailResponse = makeDto();
    const res = await http()
      .get(`/api/v1/admin/outbox/dead-letters/${EVENT_1}`)
      .expect(200);
    expect(Object.keys(res.body)).not.toContain("payload");
    expect(JSON.stringify(res.body)).not.toContain(PII_CANARY);
  });
});
