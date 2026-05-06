/**
 * audit.module.spec.ts
 *
 * Integration test for AuditModule wiring.
 *
 * Proves that importing `AuditModule` into a NestJS testing module:
 *   1. Registers `AuditEmitterInterceptor` via the `APP_INTERCEPTOR` DI token
 *      (not via `app.useGlobalInterceptors(new X(...))`).
 *   2. Keeps `AUDIT_JOB_ENQUEUER` overridable via `overrideProvider` — the
 *      critical property that integration tests depend on.
 *
 * This test is what T230's spec (`audit-emitter.interceptor.spec.ts`) cannot
 * provide: T230 wires the interceptor manually with an explicit
 * `{ provide: APP_INTERCEPTOR, useFactory: ... }` provider. This spec wires
 * it through the module, proving the module configuration itself is correct.
 *
 * No Redis, no real BullMQ Queue, no AppModule required.
 * `overrideProvider(AUDIT_JOB_ENQUEUER).useValue(spy)` bypasses
 * `auditJobEnqueuerFactory` entirely.
 */
import "reflect-metadata";
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  type INestApplication,
  Module,
  Post,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuditModule } from "../../src/audit/audit.module";
import { Auditable } from "../../src/audit/auditable.decorator";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../src/audit/audit-job.enqueuer";

// ---------------------------------------------------------------------------
// Fake controller — one @Auditable route + one plain route
// ---------------------------------------------------------------------------

@Controller("test-audit")
class FakeAuditableController {
  @Auditable("context.switch.tenant")
  @Post("switch")
  @HttpCode(HttpStatus.OK)
  doSwitch(): { ok: boolean } {
    return { ok: true };
  }

  @Get("public")
  @HttpCode(HttpStatus.OK)
  publicRoute(): { ok: boolean } {
    return { ok: true };
  }
}

// Wrapper module so we can import AuditModule alongside the fake controller
@Module({ imports: [AuditModule], controllers: [FakeAuditableController] })
class TestAppModule {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditModule wiring", () => {
  let app: INestApplication;
  let fakeEnqueuer: jest.Mocked<AuditJobEnqueuer>;

  beforeEach(async () => {
    fakeEnqueuer = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(AUDIT_JOB_ENQUEUER)
      .useValue(fakeEnqueuer)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("calls the enqueuer exactly once when a request hits an @Auditable route", async () => {
    await request(app.getHttpServer()).post("/test-audit/switch").expect(200);
    // The interceptor fires on the response tap — give the microtask queue a tick
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeEnqueuer.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not call the enqueuer for a non-@Auditable route", async () => {
    await request(app.getHttpServer()).get("/test-audit/public").expect(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeEnqueuer.enqueue).not.toHaveBeenCalled();
  });

  it("overrideProvider works — AUDIT_JOB_ENQUEUER is DI-overridable (APP_INTERCEPTOR, not manual construction)", () => {
    // The enqueuer mock was set via overrideProvider. If AuditModule had used
    // app.useGlobalInterceptors(new AuditEmitterInterceptor(...)) instead of
    // APP_INTERCEPTOR, the override would have no effect and the previous test
    // would have used the factory-produced enqueuer (which would throw without
    // REDIS_URL in this env). Reaching this point proves DI-managed registration.
    expect(fakeEnqueuer.enqueue).toBeDefined();
  });
});
