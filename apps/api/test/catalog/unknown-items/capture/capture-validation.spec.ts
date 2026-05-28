/**
 * T519 — 005-WAVE1-VALIDATION — POS capture payload validation spec.
 *
 * Acceptance (slice 005-WAVE1-VALIDATION validation contract):
 *   GREEN — FR-070 / FR-071 / FR-072 boundary rejection:
 *     - Missing required fields (identifier_type, identifier_value) → 400
 *     - Malformed values (length out of bounds, unsupported type) → 400
 *     - Cross-field violations of 003 CHK `unknown_items_source_system_required`
 *       (external_pos_id without source_system, AND
 *        non-external_pos_id WITH source_system) → 400
 *     - No `unknown_items` row created on any rejection (FR-070 / FR-071
 *       "without side-effects")
 *     - FR-072: raw `identifier_value` sentinel does not appear in the
 *       error envelope's `details` array (empirical redaction guard)
 *
 * Spec anchors:
 *   - FR-070 — missing-required-field rejection (no side-effects)
 *   - FR-071 — malformed-value rejection (length, type, cross-field)
 *   - FR-072 — deterministic outcome; raw values absent from observability
 *   - 003 CHK constraints `unknown_items_identifier_type_valid`,
 *     `unknown_items_value_length`, `unknown_items_source_system_required`
 *     (packages/db/drizzle/0007_catalog.sql:406-429)
 *
 * Note on `error.code`:
 *   The repo's `GlobalExceptionFilter` formats `ZodError` into
 *   `code: ErrorCodes.VALIDATION = "validation_error"` (see
 *   `apps/api/src/common/exception.filter.ts:106-117` +
 *   `packages/shared/src/errors/codes.ts`). This is the implementation
 *   reality. `research.md §R2` drafted `"validation_failure"`; that's a
 *   doc drift in research.md to be reconciled in T564 polish, not a
 *   code bug to fix in this slice — `GlobalExceptionFilter` and
 *   `ErrorCodes` are forbidden surface for 005-WAVE1-VALIDATION.
 *
 * Note on scope — "no store binding from auth principal":
 *   tasks.md T519 lists missing-store-binding as a validation case, but
 *   the existing CAPTURE-HAPPY controller (line 220) raises
 *   `UnauthorizedException("store_context_required")` → 401 for that
 *   path, not a 400 validation rejection. Re-shaping the 401 → 400
 *   would be a behavior change to existing CAPTURE-HAPPY semantics and
 *   exceeds the VALIDATION slice's scope-creep guardrail. The auth
 *   contract for `store_context_required` is locked in CAPTURE-HAPPY's
 *   controller-guard unit tests and is not exercised here. A future
 *   auth-failure-status alignment slice can revisit if needed.
 *
 * Wiring strategy:
 *   Pure controller-pipe spec — no Testcontainers, no Postgres, no
 *   service. The Zod `.strict().superRefine()` happens inside the
 *   NestJS pipe BEFORE the handler runs. Spinning up the
 *   `UnknownItemsService` would require Docker for no incremental
 *   value: every assertion here is on the request-side boundary, and
 *   the "no row was created on rejection" claim is structurally true
 *   because the service is never reached. CAPTURE-HAPPY integration
 *   tests already prove the service writes rows; this spec proves the
 *   pipe rejects bad inputs before the service is asked to.
 *
 *   The controller is wired with:
 *     - real UnknownItemsController
 *     - real ZodValidationPipe (via @Body decorator)
 *     - real GlobalExceptionFilter (formats ZodError → envelope)
 *     - a UnknownItemsService stub that records calls (asserts the
 *       service is never invoked on a rejected payload)
 *     - a ConfigurableContextGuard providing valid POS principal
 *
 *   No IdempotencyInterceptor, no AuditEmitterInterceptor — neither
 *   runs before the pipe in NestJS's lifecycle, so excluding them
 *   keeps the spec focused.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

// ---------------------------------------------------------------------------
// Fixed UUIDs — hex-only per the user feedback memory `feedback_uuid_hex_literals`.
// ---------------------------------------------------------------------------

const TENANT_ID = "0d000000-0000-7000-8000-0000000005f1";
const STORE_ID = "0d000000-0000-7000-8000-0000000005f2";
const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005f3";

/** 32-char ASCII idempotency key (passes the interceptor's regex; the
 * interceptor isn't wired here, but the controller's decorator metadata
 * is still present — supertest can send the header harmlessly). */
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";

/**
 * Sentinel value used to assert the raw `identifier_value` never appears
 * in the error envelope (FR-072 redaction). Distinct enough that an
 * accidental substring match in JSON.stringify(res.body) is unambiguous.
 */
const REDACTION_SENTINEL = "LEAK-SENTINEL-cafe1234";

// ---------------------------------------------------------------------------
// ConfigurableContextGuard — same shape as CAPTURE-HAPPY's guard, supplies
// a valid POS principal so the controller's auth checks pass through and
// the only failures come from the Zod pipe (not from missing auth).
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: DEVICE_USER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    };
    req.principal = { userId: DEVICE_USER_ID };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Spy service — records calls so we can assert the pipe rejects payloads
// BEFORE the service is invoked (FR-070 / FR-071 "without side-effects").
// ---------------------------------------------------------------------------

class SpyUnknownItemsService {
  public captureItemCalls: number = 0;
  async captureItem(): Promise<never> {
    this.captureItemCalls += 1;
    throw new Error(
      "SpyUnknownItemsService.captureItem should never run for a rejected payload",
    );
  }
}

let app: INestApplication;
let spyService: SpyUnknownItemsService;

beforeAll(async () => {
  spyService = new SpyUnknownItemsService();

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // PG_POOL is injected by UnknownItemsService — but UnknownItemsService
      // is replaced with the spy, so the pool token only needs a placeholder.
      { provide: PG_POOL, useValue: null },
      { provide: UnknownItemsService, useValue: spyService },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice.
    // Even tests that only hit the POS capture route must override these
    // because NestJS resolves all controller-declared guards at compile time.
    // Override with no-op pass-throughs so the test harness compiles and
    // the global ConfigurableContextGuard's context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ConfigurableContextGuard());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  spyService.captureItemCalls = 0;
});

function http() {
  return request(app.getHttpServer());
}

function postCapture(body: unknown) {
  return http()
    .post("/api/pos/v1/catalog/unknown-items")
    .set("Idempotency-Key", IDEMP_KEY)
    .send(body as object);
}

function expectValidationRejection(res: request.Response) {
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({
    error: {
      code: "validation_error",
      message: expect.any(String),
    },
  });
  // FR-070 / FR-071 — service never called on rejection.
  expect(spyService.captureItemCalls).toBe(0);
}

// ---------------------------------------------------------------------------
// T519 / 005-WAVE1-VALIDATION — Zod boundary rejects malformed payloads
// ---------------------------------------------------------------------------

describe("T519 / 005-WAVE1-VALIDATION — POS capture payload validation", () => {
  describe("FR-070 — missing required fields", () => {
    it("rejects payload missing identifier_type", async () => {
      const res = await postCapture({
        identifier_value: REDACTION_SENTINEL,
      });
      expectValidationRejection(res);
    });

    it("rejects payload missing identifier_value", async () => {
      const res = await postCapture({
        identifier_type: "barcode",
      });
      expectValidationRejection(res);
    });
  });

  describe("FR-071 — value length out of bounds (003 unknown_items_value_length)", () => {
    it("rejects identifier_value of length 0", async () => {
      const res = await postCapture({
        identifier_type: "barcode",
        identifier_value: "",
      });
      expectValidationRejection(res);
    });

    it("rejects identifier_value of length 201", async () => {
      const tooLong = "a".repeat(201);
      const res = await postCapture({
        identifier_type: "barcode",
        identifier_value: tooLong,
      });
      expectValidationRejection(res);
    });
  });

  describe("FR-071 — unsupported identifier_type (003 unknown_items_identifier_type_valid)", () => {
    it("rejects an identifier_type not in the closed enum", async () => {
      const res = await postCapture({
        identifier_type: "upc",
        identifier_value: REDACTION_SENTINEL,
      });
      expectValidationRejection(res);
    });
  });

  describe("FR-071 cross-field — 003 unknown_items_source_system_required", () => {
    it("rejects external_pos_id without source_system", async () => {
      const res = await postCapture({
        identifier_type: "external_pos_id",
        identifier_value: REDACTION_SENTINEL,
        // source_system intentionally omitted
      });
      expectValidationRejection(res);
    });

    it("rejects non-external_pos_id (barcode) WITH source_system", async () => {
      // 003 CHK is bidirectional: barcode/sku/plu/supplier_code MUST have
      // source_system = NULL. A naive one-sided refine would silently let
      // this pass and 500 at the DB INSERT.
      const res = await postCapture({
        identifier_type: "barcode",
        identifier_value: REDACTION_SENTINEL,
        source_system: "POS-X",
      });
      expectValidationRejection(res);
    });
  });

  describe("FR-072 — raw identifier_value MUST NOT leak into the error envelope", () => {
    it("does not echo the submitted identifier_value in error details", async () => {
      const res = await postCapture({
        identifier_type: "external_pos_id",
        identifier_value: REDACTION_SENTINEL,
        // omitting source_system to trigger the cross-field rejection
      });
      expect(res.status).toBe(400);
      // Lowercase substring check — empirical redaction guard. If ANY
      // future Zod issue type starts echoing `received` as the raw value,
      // this assertion catches it.
      const bodyStr = JSON.stringify(res.body).toLowerCase();
      expect(bodyStr).not.toContain(REDACTION_SENTINEL.toLowerCase());
    });
  });
});
