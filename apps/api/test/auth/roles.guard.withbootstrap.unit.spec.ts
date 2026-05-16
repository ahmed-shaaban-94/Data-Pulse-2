/**
 * roles.guard.withbootstrap.unit.spec.ts
 *
 * Covers the `withBootstrapCtx` path in RolesGuard when a real `Pool` is
 * injected (the `runWithTenantContext` branch at lines 208-212).
 *
 * `runWithTenantContext` is mocked so no DB connection is required.
 * The guard is constructed with a fake pool to exercise the non-fallback
 * branch of `withBootstrapCtx`.
 */

// Mock must appear before any import that transitively loads @data-pulse-2/db.
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(
    async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
  ),
}));

import "reflect-metadata";

import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";

import { ROLES_METADATA_KEY, Roles } from "../../src/auth/roles.decorator";
import type { RolesMetadata } from "../../src/auth/roles.decorator";
import { RolesGuard } from "../../src/auth/roles.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { TenantContextRequest } from "../../src/context/types";
import type { Principal } from "../../src/auth/auth.guard";

void Roles;

const USER_ID   = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";

const fakePool = {} as Pool;

function makeCtx(request: Partial<TenantContextRequest>): ExecutionContext {
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

describe("RolesGuard — withBootstrapCtx pool path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: unknown) => unknown) => fn({}),
    );
  });

  it("calls runWithTenantContext when pool is present (covers withBootstrapCtx pool branch)", async () => {
    const fakeReflector = {
      getAllAndOverride: jest.fn().mockReturnValue({
        any: ["owner"],
        tenantFrom: "context",
        platformAdminOnly: false,
        denyAs: 404,
      } satisfies RolesMetadata),
    };

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findRoleCodeForUserInTenant: jest.fn().mockResolvedValue("owner"),
    } as unknown as MembershipRepository;

    const guard = new RolesGuard(
      fakeReflector as unknown as Reflector,
      fakeMemberships,
      fakePool,
    );

    const request: Partial<TenantContextRequest> = {
      principal: {
        kind: "session",
        sessionId: SESSION_ID,
        userId: USER_ID,
      } as Principal,
      context: {
        userId: USER_ID,
        tenantId: TENANT_ID,
        storeId: null,
        isPlatformAdmin: false,
        source: "session",
      },
    };

    const result = await guard.canActivate(makeCtx(request));
    expect(result).toBe(true);
    expect(runWithTenantContext).toHaveBeenCalledTimes(1);
    expect(fakeMemberships.findRoleCodeForUserInTenant).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      expect.anything(),
    );
  });

  it("runWithTenantContext rejection propagates (DB bootstrap failure)", async () => {
    const fakeReflector = {
      getAllAndOverride: jest.fn().mockReturnValue({
        any: ["owner"],
        tenantFrom: "context",
        platformAdminOnly: false,
        denyAs: 404,
      } satisfies RolesMetadata),
    };

    const fakeMemberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      findRoleCodeForUserInTenant: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipRepository;

    (runWithTenantContext as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException("DB error"),
    );

    const guard = new RolesGuard(
      fakeReflector as unknown as Reflector,
      fakeMemberships,
      fakePool,
    );

    const request: Partial<TenantContextRequest> = {
      principal: {
        kind: "session",
        sessionId: SESSION_ID,
        userId: USER_ID,
      } as Principal,
      context: {
        userId: USER_ID,
        tenantId: TENANT_ID,
        storeId: null,
        isPlatformAdmin: false,
        source: "session",
      },
    };

    await expect(guard.canActivate(makeCtx(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(runWithTenantContext).toHaveBeenCalledTimes(1);
  });
});
