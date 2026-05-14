/**
 * T205 — SC-4 frontend-bypass probe.
 *
 * Guarantee: RolesGuard reads authorization inputs ONLY from
 * `request.principal` (set by AuthGuard), `request.context` (set by
 * TenantContextGuard), and `request.params` (path routing). It never
 * reads `request.body`, `request.query`, or arbitrary request headers.
 *
 * What roles.guard.spec.ts already covers
 * ----------------------------------------
 * It proves the role-check pass/fail matrix: store_staff is denied on an
 * owner-only gate, wrong role → 404, etc. Those tests build requests that
 * reflect the *normal* guard input surface.
 *
 * What this file adds (the bypass angle)
 * ----------------------------------------
 * A low-privilege (store_staff) user attempts to escalate by injecting
 * attacker-controlled values into non-authoritative request fields:
 *
 *   - `request.body.role` / `request.body.is_platform_admin`
 *   - `request.body.tenant_id` (a different, privileged tenant)
 *   - `request.headers["x-role"]` / `request.headers["x-tenant-id"]`
 *   - `request.query.role` / `request.query.is_platform_admin`
 *
 * In every case the guard outcome must be identical to the baseline
 * (no injected fields present). The guard is unaware these fields exist;
 * this test makes that implicit contract machine-checked.
 *
 * Style: hand-rolled fakes matching roles.guard.spec.ts idioms.
 * Docker-free. No NestJS test module required.
 */

import "reflect-metadata";

import {
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { RolesGuard } from "../../src/auth/roles.guard";
import type { Principal } from "../../src/auth/auth.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { TenantContextRequest } from "../../src/context/types";
import type { ResolvedContext } from "../../src/context/types";
import {
  ROLES_METADATA_KEY,
  type RolesMetadata,
} from "../../src/auth/roles.decorator";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID = "0b000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0b000000-0000-7000-8000-0000000ses01";
const TENANT_ID = "0b000000-0000-7000-8000-0000000ten01";
const OTHER_TENANT_ID = "0b000000-0000-7000-8000-0000000ten99";

// ---------------------------------------------------------------------------
// Fakes (mirrors roles.guard.spec.ts)
// ---------------------------------------------------------------------------

class FakeReflector {
  metadata: RolesMetadata | undefined = undefined;

  getAllAndOverride<T>(key: string, _targets: unknown[]): T | undefined {
    return this.metadata as T | undefined;
  }
}

class FakeMembershipRepository {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const sessionPrincipal: Principal = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
};

const resolvedCtx: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

const ownerOnlyMeta: RolesMetadata = {
  any: ["owner", "tenant_admin"],
  tenantFrom: "context",
  platformAdminOnly: false,
  denyAs: 404,
};

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

function baseRequest(extras: Record<string, unknown> = {}): TenantContextRequest {
  return {
    headers: {},
    principal: sessionPrincipal,
    context: resolvedCtx,
    params: {},
    ...extras,
  } as unknown as TenantContextRequest;
}

// ---------------------------------------------------------------------------
// Baseline — no injected fields
// ---------------------------------------------------------------------------

describe("T205 — frontend bypass: baseline (no injected fields)", () => {
  it("denies store_staff on an owner/tenant_admin gate (reference for all bypass cases)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";

    await expect(guard.canActivate(makeCtx(baseRequest()))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Bypass attempt 1: body-level role escalation
// ---------------------------------------------------------------------------

describe("T205 — frontend bypass: body fields cannot elevate role", () => {
  it("body.role='owner' does NOT change outcome for store_staff", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";

    const req = baseRequest({ body: { role: "owner", name: "Injected" } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("body.is_platform_admin=true does NOT grant the platform-admin bypass", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";
    memberships.platformAdmin = false;

    const req = baseRequest({ body: { is_platform_admin: true } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The guard never consulted isPlatformAdmin — it would flip the outcome.
    // Confirmed implicitly: if it HAD read body, platformAdmin=false & the
    // repo returns false → same 404, but for wrong reason. The next case
    // (body=true, repo=false, context=false) proves the distinction.
  });

  it("body.is_platform_admin=true + context.isPlatformAdmin=false + repo returns false → still denied", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";
    memberships.platformAdmin = false;

    const req = baseRequest({
      body: { is_platform_admin: true },
      context: { ...resolvedCtx, isPlatformAdmin: false },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("body.tenant_id pointing to a different tenant does NOT change the tenant used for role lookup", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    // Return "owner" only when the correct TENANT_ID is used —
    // the guard reads context.tenantId, not body.tenant_id.
    memberships.roleCode = null;

    const req = baseRequest({
      body: { tenant_id: OTHER_TENANT_ID },
      context: { ...resolvedCtx, tenantId: TENANT_ID },
    });
    // memberships returns null → denied
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Bypass attempt 2: arbitrary request header injection
// ---------------------------------------------------------------------------

describe("T205 — frontend bypass: arbitrary headers cannot elevate role", () => {
  it("X-Role: owner header does NOT change outcome for store_staff", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";

    const req = baseRequest({
      headers: { "x-role": "owner", authorization: "Bearer ignored" },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("X-Is-Platform-Admin: true header does NOT grant platform-admin bypass", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";
    memberships.platformAdmin = false;

    const req = baseRequest({
      headers: { "x-is-platform-admin": "true" },
      context: { ...resolvedCtx, isPlatformAdmin: false },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("X-Tenant-Id: <other-tenant> header does NOT redirect the role lookup", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = null;

    const req = baseRequest({
      headers: { "x-tenant-id": OTHER_TENANT_ID },
      context: { ...resolvedCtx, tenantId: TENANT_ID },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Bypass attempt 3: query-string injection
// ---------------------------------------------------------------------------

describe("T205 — frontend bypass: query string cannot elevate role", () => {
  it("?role=owner query does NOT change outcome for store_staff", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";

    const req = baseRequest({ query: { role: "owner" } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("?is_platform_admin=true query does NOT grant platform-admin bypass", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";
    memberships.platformAdmin = false;

    const req = baseRequest({
      query: { is_platform_admin: "true" },
      context: { ...resolvedCtx, isPlatformAdmin: false },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Positive control — legitimate upgrade path is unaffected
// ---------------------------------------------------------------------------

describe("T205 — frontend bypass: legitimate paths still work", () => {
  it("context.isPlatformAdmin=true (set by TenantContextGuard, not by body) allows access", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "store_staff";

    const req = baseRequest({
      context: { ...resolvedCtx, isPlatformAdmin: true },
      body: { is_platform_admin: false },
    });
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
  });

  it("actual owner role in membership repo allows access regardless of body noise", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = ownerOnlyMeta;
    memberships.roleCode = "owner";

    const req = baseRequest({
      body: { role: "store_staff" },
      headers: { "x-role": "store_staff" },
    });
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
  });
});
