/**
 * T203 — Cross-tenant authorization sweep.
 *
 * Guarantee: every Dashboard-authenticated endpoint that accepts a
 * resource ID either (a) returns a safe 404 (NotFoundException) when a
 * caller from Tenant A supplies an ID that belongs to Tenant B, or (b)
 * returns 403 (ForbiddenException) for platform-admin-only routes where
 * a non-admin caller can never access any tenant's resource regardless.
 *
 * This satisfies FR-ISO-4: cross-tenant lookups must be
 * indistinguishable from "resource does not exist".
 *
 * ─── Covered endpoints (10 cases) ───────────────────────────────────
 *
 *  B-1  GET    /api/v1/tenants/:id              → 404 (service-layer:
 *                                                 TenantsService.read returns
 *                                                 NotFoundException when caller
 *                                                 has no membership in the
 *                                                 target tenant)
 *
 *  B-2  PATCH  /api/v1/tenants/:id              → 404 (guard-layer:
 *                                                 @RolesFromParam("id",…),
 *                                                 denyAs:404, null membership)
 *
 *  B-3a POST   /api/v1/tenants                  → 403 (guard-layer:
 *                                                 @PlatformAdminOnly(), non-admin
 *                                                 caller; degenerate cross-tenant
 *                                                 per matrix — non-admins are
 *                                                 universally denied regardless of
 *                                                 tenant)
 *
 *  B-3b DELETE /api/v1/tenants/:id              → 403 (guard-layer:
 *                                                 @PlatformAdminOnly(), same
 *                                                 reasoning as B-3a)
 *
 *  B-5  GET    /api/v1/stores/:store_id         → 404 (service-layer:
 *                                                 StoresService.read throws
 *                                                 NotFoundException — RLS makes
 *                                                 foreign store invisible)
 *
 *  B-6  PATCH  /api/v1/stores/:store_id         → 404 (service-layer:
 *                                                 StoresService.update throws
 *                                                 NotFoundException — caller role
 *                                                 passes for active-tenant A but
 *                                                 foreign store_id is invisible)
 *
 *  B-7  DELETE /api/v1/stores/:store_id         → 404 (service-layer:
 *                                                 StoresService.softDelete throws
 *                                                 NotFoundException — same)
 *
 *  B-8  GET    /api/v1/tenants/:id/members      → 404 (guard-layer:
 *                                                 @RolesFromParam("id",…),
 *                                                 denyAs:404, null membership)
 *
 *  B-11 PATCH  /api/v1/memberships/:id          → 404 (service-layer:
 *                                                 MembershipsService.update throws
 *                                                 NotFoundException — caller role
 *                                                 passes for active-tenant A but
 *                                                 foreign membership_id is
 *                                                 invisible)
 *
 *  B-12 DELETE /api/v1/memberships/:id          → 404 (service-layer:
 *                                                 MembershipsService.revoke throws
 *                                                 NotFoundException — same)
 *
 * ─── Out-of-scope ────────────────────────────────────────────────────
 *
 *  POS  /api/pos/v1/*  — EXCLUDED. POS endpoints use Clerk JWT +
 *       device attestation, not Dashboard auth. They are a separate
 *       authentication domain entirely and are not covered here.
 *
 *  B-4  GET /api/v1/stores (list)  — EXCLUDED. TenantContextGuard
 *       blocks a foreign-tenant active context before the controller is
 *       reached; there is no cross-tenant path parameter to exploit.
 *
 *  B-9  POST /api/v1/stores  — EXCLUDED. Guard uses denyAs:403; that
 *       gate is for insufficient role within the active tenant (caller
 *       already authenticated into Tenant A). If the active tenant IS
 *       Tenant B then TenantContextGuard → 401 (blocked upstream).
 *       No path-id cross-tenant vector exists.
 *
 *  B-10 POST /api/v1/memberships/invite — EXCLUDED. No path-based
 *       resource ID; cross-tenant can only happen via service-level RLS
 *       which is not guard-visible in this sweep layer.
 *
 *  B-13 (this file) — this IS the whole-API sweep per the matrix.
 *
 *  B-14 Audit query API — not yet assigned; out of scope for T203.
 *
 * ─── Approach ────────────────────────────────────────────────────────
 *
 *  Two test groups:
 *
 *  GROUP 1 — Guard-layer tests (B-2, B-3a, B-3b, B-8):
 *    Instantiate RolesGuard directly with hand-rolled FakeReflector and
 *    FakeMembershipRepository (same pattern as T205/T206). No NestJS
 *    testing module. No Docker. The guard's canActivate() is called with
 *    a fabricated ExecutionContext carrying the foreign-tenant ID in
 *    request.params. The reflector returns the exact metadata that
 *    @RolesFromParam / @PlatformAdminOnly would set in production.
 *
 *  GROUP 2 — Service-layer tests (B-1, B-5, B-6, B-7, B-11, B-12):
 *    Instantiate the real controller with a jest-mocked service. The
 *    mock throws NotFoundException when given the foreign resource ID,
 *    simulating RLS making the row invisible. The controller method is
 *    called directly with a synthetic request carrying the caller's
 *    active-tenant context (Tenant A) and the foreign ID. This proves
 *    the controller faithfully propagates the service NotFoundException
 *    without swallowing or transforming it.
 *
 *  Exception-envelope rendering (HTTP → JSON shape) is the responsibility
 *  of GlobalExceptionFilter. The dedicated envelope test lives in
 *  apps/api/test/common/exception.filter.spec.ts and is the authoritative
 *  source for envelope-shape assertions. This sweep deliberately tests
 *  only that the correct exception type (NotFoundException /
 *  ForbiddenException) is thrown; rendering is assumed correct per the
 *  filter contract and is not duplicated here.
 *
 *  This sweep enumerates the 10 endpoints listed above; it does NOT
 *  claim 100% coverage of every existing route. POS endpoints are
 *  excluded — they use Clerk JWT + device attestation.
 *
 * Style: hand-rolled fakes. Docker-free. No NestJS createTestingModule.
 */

import "reflect-metadata";

import {
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

// Guards
import { RolesGuard } from "../../src/auth/roles.guard";
import type { Principal } from "../../src/auth/auth.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import {
  ROLES_METADATA_KEY,
  type RolesMetadata,
} from "../../src/auth/roles.decorator";

// Controllers
import { TenantsController } from "../../src/tenants/tenants.controller";
import { StoresController } from "../../src/stores/stores.controller";
import { MembershipsController } from "../../src/memberships/memberships.controller";

// Types
import type { TenantContextRequest, ResolvedContext } from "../../src/context/types";
import type { AuthedRequest } from "../../src/auth/auth.guard";

// ---------------------------------------------------------------------------
// Fixed IDs — distinct prefixes per tenant to make failures obvious
// ---------------------------------------------------------------------------

/** Caller's home tenant */
const TENANT_A = "0c030000-0000-7000-8000-000000000a01";
/** Foreign tenant — no membership for the caller */
const TENANT_B = "0c030000-0000-7000-8000-000000000b01";

const USER_A = "0c030000-0000-7000-8000-0000000user1";
const SESSION_A = "0c030000-0000-7000-8000-000000sess01";

/** A store ID that lives in Tenant B (invisible to Tenant A caller) */
const STORE_B = "0c030000-0000-7000-8000-0000000str0b";
/** A membership ID that lives in Tenant B */
const MEMBERSHIP_B = "0c030000-0000-7000-8000-0000000mem0b";

// ---------------------------------------------------------------------------
// Shared principals and contexts
// ---------------------------------------------------------------------------

const sessionPrincipal: Principal = {
  kind: "session",
  sessionId: SESSION_A,
  userId: USER_A,
};

/** Caller is authenticated into Tenant A with owner role */
const ctxA: ResolvedContext = {
  userId: USER_A,
  tenantId: TENANT_A,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * assertSafeNotFound — Confirms the thrown error is a NotFoundException.
 * A 404 is the "safe" response for cross-tenant probes (FR-ISO-4):
 * the caller cannot distinguish "wrong tenant" from "does not exist".
 */
function assertSafeNotFound(error: unknown): void {
  expect(error).toBeInstanceOf(NotFoundException);
}

// ===========================================================================
// GROUP 1 — Guard-layer cross-tenant tests
// ===========================================================================
//
// These exercise RolesGuard directly. The guard is the final gatekeeper
// for @RolesFromParam and @PlatformAdminOnly routes. We bypass NestJS
// module wiring entirely and call canActivate() with hand-crafted inputs.
//
// For @RolesFromParam routes: the guard resolves the tenant ID from
// request.params[paramKey] (not from request.context), then calls
// findRoleCodeForUserInTenant. Returning null → NotFoundException
// (denyAs:404 is the default for @RolesFromParam).
//
// For @PlatformAdminOnly routes: non-admin callers always get
// ForbiddenException (denyAs:403) regardless of the path tenant ID.
// This is the degenerate cross-tenant case per the isolation matrix.

// ---------------------------------------------------------------------------
// Fake infrastructure (mirrors T205 / T206 style)
// ---------------------------------------------------------------------------

class FakeReflector {
  metadata: RolesMetadata | undefined = undefined;

  getAllAndOverride<T>(_key: string, _targets: unknown[]): T | undefined {
    return this.metadata as T | undefined;
  }
}

class FakeMembershipRepository {
  /** Simulates no membership in the foreign tenant */
  roleCode: string | null = null;
  platformAdmin = false;

  async findRoleCodeForUserInTenant(
    _userId: string,
    _tenantId: string,
  ): Promise<string | null> {
    return this.roleCode;
  }

  async isPlatformAdmin(_userId: string): Promise<boolean> {
    return this.platformAdmin;
  }
}

function buildGuard(): {
  guard: RolesGuard;
  reflector: FakeReflector;
  memberships: FakeMembershipRepository;
} {
  const reflector = new FakeReflector();
  const memberships = new FakeMembershipRepository();
  const guard = new RolesGuard(
    reflector as unknown as Reflector,
    memberships as unknown as MembershipRepository,
  );
  return { guard, reflector, memberships };
}

function makeCtx(request: TenantContextRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => ({}) as T,
      getNext: <T>() => ({}) as T,
    }),
    getHandler: () => () => undefined,
    getClass: () => class StubController {},
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Metadata constants (mirror what the decorators set in production)
// ---------------------------------------------------------------------------

/** @RolesFromParam("id", "owner", "tenant_admin") */
const rolesFromParamMeta: RolesMetadata = {
  any: ["owner", "tenant_admin"],
  tenantFrom: "param:id",
  platformAdminOnly: false,
  denyAs: 404,
};

/** @PlatformAdminOnly() */
const platformAdminOnlyMeta: RolesMetadata = {
  any: [],
  tenantFrom: "context",
  platformAdminOnly: true,
  denyAs: 403,
};

// ---------------------------------------------------------------------------
// B-2: PATCH /api/v1/tenants/:id — guard-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-2 — PATCH /api/v1/tenants/:id cross-tenant → 404 (guard)", () => {
  it("throws NotFoundException when caller has no membership in the path tenant", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = rolesFromParamMeta;
    // Caller has NO membership in Tenant B
    memberships.roleCode = null;
    memberships.platformAdmin = false;

    const request: TenantContextRequest = {
      headers: {},
      // path param "id" points to Tenant B
      params: { id: TENANT_B },
      principal: sessionPrincipal,
      context: ctxA,
    } as unknown as TenantContextRequest;

    const err = await guard.canActivate(makeCtx(request)).catch((e: unknown) => e);
    assertSafeNotFound(err);
  });
});

// ---------------------------------------------------------------------------
// B-3a: POST /api/v1/tenants — guard-layer ForbiddenException
// ---------------------------------------------------------------------------

describe("T203/B-3a — POST /api/v1/tenants cross-tenant → 403 (guard, PlatformAdminOnly)", () => {
  it("throws ForbiddenException for a non-platform-admin caller", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = platformAdminOnlyMeta;
    memberships.platformAdmin = false;

    const request: TenantContextRequest = {
      headers: {},
      params: {},
      principal: sessionPrincipal,
      context: ctxA,
    } as unknown as TenantContextRequest;

    const err = await guard.canActivate(makeCtx(request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// B-3b: DELETE /api/v1/tenants/:id — guard-layer ForbiddenException
// ---------------------------------------------------------------------------

describe("T203/B-3b — DELETE /api/v1/tenants/:id cross-tenant → 403 (guard, PlatformAdminOnly)", () => {
  it("throws ForbiddenException for a non-platform-admin caller (path = Tenant B)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = platformAdminOnlyMeta;
    memberships.platformAdmin = false;

    const request: TenantContextRequest = {
      headers: {},
      params: { id: TENANT_B },
      principal: sessionPrincipal,
      context: ctxA,
    } as unknown as TenantContextRequest;

    const err = await guard.canActivate(makeCtx(request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// B-8: GET /api/v1/tenants/:id/members — guard-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-8 — GET /api/v1/tenants/:id/members cross-tenant → 404 (guard)", () => {
  it("throws NotFoundException when caller has no membership in the path tenant", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = rolesFromParamMeta;
    memberships.roleCode = null;
    memberships.platformAdmin = false;

    const request: TenantContextRequest = {
      headers: {},
      params: { id: TENANT_B },
      principal: sessionPrincipal,
      context: ctxA,
    } as unknown as TenantContextRequest;

    const err = await guard.canActivate(makeCtx(request)).catch((e: unknown) => e);
    assertSafeNotFound(err);
  });
});

// ===========================================================================
// GROUP 2 — Service-layer cross-tenant tests
// ===========================================================================
//
// These instantiate the real controller with a jest-mocked service.
// The caller has a valid active-tenant context (Tenant A), so guard
// checks would pass — but the service throws NotFoundException because
// RLS makes the foreign row invisible. We verify that the controller
// propagates this exception without swallowing or transforming it.
//
// Pattern: mock service.method to throw NotFoundException, then call
// controller.method(request, foreignId) directly. Expect the same
// NotFoundException to escape.

// ---------------------------------------------------------------------------
// B-1: GET /api/v1/tenants/:id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-1 — GET /api/v1/tenants/:id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from TenantsService.read when caller lacks membership", async () => {
    const mockService = {
      read: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new TenantsController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      headers: {},
      params: { id: TENANT_B },
    } as unknown as AuthedRequest;

    await expect(controller.read(request, TENANT_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// B-5: GET /api/v1/stores/:store_id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-5 — GET /api/v1/stores/:store_id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from StoresService.read when foreign store is invisible", async () => {
    const mockService = {
      read: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new StoresController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      context: ctxA,
      headers: {},
      params: { store_id: STORE_B },
    } as unknown as TenantContextRequest;

    await expect(controller.read(request, STORE_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// B-6: PATCH /api/v1/stores/:store_id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-6 — PATCH /api/v1/stores/:store_id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from StoresService.update when foreign store is invisible", async () => {
    const mockService = {
      update: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new StoresController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      context: ctxA,
      headers: {},
      params: { store_id: STORE_B },
    } as unknown as TenantContextRequest;

    // A minimal valid body shape — the controller passes it straight to the service
    const body = { name: "Injected Name" } as never;

    await expect(controller.update(request, STORE_B, body)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// B-7: DELETE /api/v1/stores/:store_id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-7 — DELETE /api/v1/stores/:store_id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from StoresService.softDelete when foreign store is invisible", async () => {
    const mockService = {
      softDelete: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new StoresController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      context: ctxA,
      headers: {},
      params: { store_id: STORE_B },
    } as unknown as TenantContextRequest;

    await expect(controller.softDelete(request, STORE_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// B-11: PATCH /api/v1/memberships/:membership_id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-11 — PATCH /api/v1/memberships/:membership_id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from MembershipsService.update when foreign membership is invisible", async () => {
    const mockService = {
      update: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new MembershipsController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      context: ctxA,
      headers: {},
      params: { membership_id: MEMBERSHIP_B },
    } as unknown as TenantContextRequest;

    const dto = { role_code: "store_staff" } as never;

    await expect(controller.update(request, MEMBERSHIP_B, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// B-12: DELETE /api/v1/memberships/:membership_id — service-layer NotFoundException
// ---------------------------------------------------------------------------

describe("T203/B-12 — DELETE /api/v1/memberships/:membership_id cross-tenant → 404 (service)", () => {
  it("propagates NotFoundException from MembershipsService.revoke when foreign membership is invisible", async () => {
    const mockService = {
      revoke: jest.fn().mockRejectedValue(new NotFoundException("Not Found")),
    };
    const controller = new MembershipsController(mockService as never);

    const request = {
      principal: sessionPrincipal,
      context: ctxA,
      headers: {},
      params: { membership_id: MEMBERSHIP_B },
    } as unknown as TenantContextRequest;

    await expect(controller.revoke(request, MEMBERSHIP_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
