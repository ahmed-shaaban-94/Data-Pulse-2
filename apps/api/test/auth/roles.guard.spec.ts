/**
 * T200 — RolesGuard + decorator family spec.
 *
 * Pure unit-level. The guard's two collaborators (`Reflector`,
 * `MembershipRepository`) are faked at the class boundary; no Nest
 * test module, no Postgres, no `runWithTenantContext`.
 *
 * The shape mirrors the established repo idiom (PR #14/#15/#19/#20):
 * tiny `Fake*` classes that record calls and return canned values,
 * then a hand-rolled `ExecutionContext` shim so the guard's
 * `canActivate(ctx)` runs end-to-end without HTTP plumbing.
 *
 * Coverage maps to the approved test list (15 cases + decorator
 * metadata sanity checks).
 */
import {
  type ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type {
  AuthedRequest,
  Principal,
} from "../../src/auth/auth.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type {
  ResolvedContext,
  TenantContextRequest,
} from "../../src/context/types";
import {
  PlatformAdminOnly,
  ROLES_METADATA_KEY,
  Roles,
  RolesFromParam,
  type RolesMetadata,
} from "../../src/auth/roles.decorator";
import { RolesGuard } from "../../src/auth/roles.guard";

// --- IDs (UUIDv7-ish, easy to eyeball) ---------------------------------

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const TOKEN_ID = "0a000000-0000-7000-8000-0000000tok01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const PARAM_TENANT_ID = "0a000000-0000-7000-8000-0000000ten02";

// --- Fakes -------------------------------------------------------------

class FakeReflector {
  metadata: RolesMetadata | undefined = undefined;
  calls: Array<{ key: string; targetCount: number }> = [];

  getAllAndOverride<T>(key: string, targets: unknown[]): T | undefined {
    this.calls.push({ key, targetCount: targets.length });
    return this.metadata as T | undefined;
  }
}

interface FindRoleCall {
  readonly userId: string;
  readonly tenantId: string;
}

class FakeMembershipRepository {
  /** `findRoleCodeForUserInTenant` return value. */
  roleCode: string | null = null;
  /** `isPlatformAdmin` return value. */
  platformAdmin = false;

  findRoleCalls: FindRoleCall[] = [];
  isPlatformAdminCalls: string[] = [];

  async findRoleCodeForUserInTenant(
    userId: string,
    tenantId: string,
  ): Promise<string | null> {
    this.findRoleCalls.push({ userId, tenantId });
    return this.roleCode;
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    this.isPlatformAdminCalls.push(userId);
    return this.platformAdmin;
  }
}

// --- Helpers -----------------------------------------------------------

const sessionPrincipal = (overrides: Partial<Principal> = {}): Principal =>
  ({
    kind: "session",
    sessionId: SESSION_ID,
    userId: USER_ID,
    ...overrides,
  }) as Principal;

const tokenPrincipal = (overrides: Partial<Principal> = {}): Principal =>
  ({
    kind: "token",
    tokenId: TOKEN_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    ...overrides,
  }) as Principal;

const ctxFor = (
  request: TenantContextRequest,
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: <T>(): T => request as unknown as T,
      getResponse: <T>(): T => ({}) as T,
      getNext: <T>(): T => ({}) as T,
    }),
    getHandler: () => () => undefined,
    getClass: () => class StubController {},
    // The rest of ExecutionContext is unused by the guard.
  }) as unknown as ExecutionContext;

const buildRequest = (parts: {
  principal?: Principal;
  context?: ResolvedContext;
  params?: Record<string, string>;
}): TenantContextRequest => {
  const req = {
    headers: {},
  } as unknown as AuthedRequest;
  const tcReq = req as TenantContextRequest;
  if (parts.principal) tcReq.principal = parts.principal;
  if (parts.context) tcReq.context = parts.context;
  if (parts.params) {
    (tcReq as unknown as { params: Record<string, string> }).params =
      parts.params;
  }
  return tcReq;
};

const resolved = (overrides: Partial<ResolvedContext> = {}): ResolvedContext => ({
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
  ...overrides,
});

const buildGuard = (): {
  guard: RolesGuard;
  reflector: FakeReflector;
  memberships: FakeMembershipRepository;
} => {
  const reflector = new FakeReflector();
  const memberships = new FakeMembershipRepository();
  const guard = new RolesGuard(
    reflector as unknown as Reflector,
    memberships as unknown as MembershipRepository,
  );
  return { guard, reflector, memberships };
};

// --- Decorator metadata sanity ----------------------------------------

describe("decorator metadata", () => {
  it("@Roles defaults denyAs to 404 (FR-ISO-4)", () => {
    class C {}
    const decorator = Roles("owner", "tenant_admin");
    decorator(C);
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, C) as RolesMetadata;
    expect(meta).toEqual({
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    });
  });

  it("@Roles accepts a trailing options object with denyAs: 403", () => {
    class C {}
    const decorator = Roles("owner", "tenant_admin", { denyAs: 403 });
    decorator(C);
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, C) as RolesMetadata;
    expect(meta).toEqual({
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 403,
    });
  });

  it("@RolesFromParam hard-wires denyAs to 404 (path-as-context is FR-ISO-4 sensitive)", () => {
    class C {}
    const decorator = RolesFromParam("id", "owner");
    decorator(C);
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, C) as RolesMetadata;
    expect(meta.tenantFrom).toBe("param:id");
    expect(meta.any).toEqual(["owner"]);
    expect(meta.platformAdminOnly).toBe(false);
    expect(meta.denyAs).toBe(404);
  });

  it("@PlatformAdminOnly sets platformAdminOnly=true with denyAs: 403", () => {
    class C {}
    const decorator = PlatformAdminOnly();
    decorator(C);
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, C) as RolesMetadata;
    expect(meta.platformAdminOnly).toBe(true);
    expect(meta.any).toEqual([]);
    expect(meta.denyAs).toBe(403);
  });
});

// --- Guard behavior ---------------------------------------------------

describe("RolesGuard", () => {
  it("default-denies when no metadata is published", async () => {
    const { guard, reflector } = buildGuard();
    reflector.metadata = undefined;
    const req = buildRequest({ principal: sessionPrincipal() });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("rejects with 401 when no principal is attached", async () => {
    const { guard, reflector } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({});
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("allows platform admin via request.context.isPlatformAdmin without membership lookup", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved({ isPlatformAdmin: true }),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.findRoleCalls).toEqual([]);
    expect(memberships.isPlatformAdminCalls).toEqual([]);
  });

  it("allows platform-scoped token (tenantId === null) without membership lookup", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({
      principal: tokenPrincipal({ tenantId: null } as Partial<Principal>),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.findRoleCalls).toEqual([]);
    expect(memberships.isPlatformAdminCalls).toEqual([]);
  });

  it("allows platform admin via fallback DB lookup when no context is set", async () => {
    const { guard, reflector, memberships } = buildGuard();
    // Path-as-context route: no TenantContextGuard ran, so request.context
    // is undefined. The repo lookup is the only signal available.
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "param:id",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.platformAdmin = true;
    const req = buildRequest({
      principal: sessionPrincipal(),
      params: { id: PARAM_TENANT_ID },
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.isPlatformAdminCalls).toEqual([USER_ID]);
    expect(memberships.findRoleCalls).toEqual([]);
  });

  it("allows when role is 'owner' and gate accepts owner/tenant_admin", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "owner";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.findRoleCalls).toEqual([
      { userId: USER_ID, tenantId: TENANT_ID },
    ]);
  });

  it("allows when role is 'tenant_admin' and gate accepts owner/tenant_admin", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "tenant_admin";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it("denies (404) when role is 'store_manager' and gate accepts owner/tenant_admin", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "store_manager";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("allows 'store_staff' on a store-staff gate", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["store_manager", "store_staff"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "store_staff";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it("denies (404) when role is 'store_staff' and gate is owner-only", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "store_staff";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("denies (404) when membership is missing entirely (cross-tenant FR-ISO-4)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = null;
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects with 403 when context-mode and request.context is missing", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({ principal: sessionPrincipal() });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Did NOT reach the repo.
    expect(memberships.findRoleCalls).toEqual([]);
  });

  it("rejects with 403 when param-mode and the path param is missing", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "param:id",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({
      principal: sessionPrincipal(),
      // No `params: { id }` — wiring bug.
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(memberships.findRoleCalls).toEqual([]);
  });

  it("denies (404) for a userless tenant-bound token (no userId on a role-gated route)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 404,
    };
    const req = buildRequest({
      principal: tokenPrincipal({ userId: null } as Partial<Principal>),
      context: resolved({ tenantId: TENANT_ID }),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(memberships.findRoleCalls).toEqual([]);
  });

  // --- denyAs: 403 path -----------------------------------------------

  it("denyAs: 403 — wrong role rejected with ForbiddenException (not NotFoundException)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 403,
    };
    memberships.roleCode = "store_staff";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("denyAs: 403 — missing membership also yields 403 (not 404)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 403,
    };
    memberships.roleCode = null;
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("denyAs: 403 — userless tenant-bound token also yields 403 (not 404)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 403,
    };
    const req = buildRequest({
      principal: tokenPrincipal({ userId: null } as Partial<Principal>),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(memberships.findRoleCalls).toEqual([]);
  });

  it("denyAs: 403 — accepted role still allows", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner", "tenant_admin"],
      tenantFrom: "context",
      platformAdminOnly: false,
      denyAs: 403,
    };
    memberships.roleCode = "tenant_admin";
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved(),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it("param-mode happy path calls repo with the path tenant id (not the context one)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: ["owner"],
      tenantFrom: "param:id",
      platformAdminOnly: false,
      denyAs: 404,
    };
    memberships.roleCode = "owner";
    const req = buildRequest({
      principal: sessionPrincipal(),
      params: { id: PARAM_TENANT_ID },
      // request.context could be set by an unrelated upstream guard;
      // path-as-context routes must still trust the path.
      context: resolved({ tenantId: TENANT_ID }),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.findRoleCalls).toEqual([
      { userId: USER_ID, tenantId: PARAM_TENANT_ID },
    ]);
  });

  // --- @PlatformAdminOnly --------------------------------------------

  it("@PlatformAdminOnly allows when context flags isPlatformAdmin", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: [],
      tenantFrom: "context",
      platformAdminOnly: true,
      denyAs: 403,
    };
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved({ isPlatformAdmin: true }),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.findRoleCalls).toEqual([]);
  });

  it("@PlatformAdminOnly allows a platform-scoped token", async () => {
    const { guard, reflector } = buildGuard();
    reflector.metadata = {
      any: [],
      tenantFrom: "context",
      platformAdminOnly: true,
      denyAs: 403,
    };
    const req = buildRequest({
      principal: tokenPrincipal({ tenantId: null } as Partial<Principal>),
    });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it("@PlatformAdminOnly allows when fallback isPlatformAdmin lookup is true", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: [],
      tenantFrom: "context",
      platformAdminOnly: true,
      denyAs: 403,
    };
    memberships.platformAdmin = true;
    const req = buildRequest({ principal: sessionPrincipal() });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(memberships.isPlatformAdminCalls).toEqual([USER_ID]);
  });

  it("@PlatformAdminOnly denies non-admins with 403 (NOT 404)", async () => {
    const { guard, reflector, memberships } = buildGuard();
    reflector.metadata = {
      any: [],
      tenantFrom: "context",
      platformAdminOnly: true,
      denyAs: 403,
    };
    memberships.platformAdmin = false;
    const req = buildRequest({
      principal: sessionPrincipal(),
      context: resolved({ isPlatformAdmin: false }),
    });
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
