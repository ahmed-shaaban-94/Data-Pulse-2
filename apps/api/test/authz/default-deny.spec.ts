/**
 * T206 — SC-3/SC-9 default-deny exhaustiveness.
 *
 * Guarantee: RolesGuard throws ForbiddenException for ANY caller when
 * no authorization metadata is present on the route. This is the
 * "fail-closed" posture: handlers added to the codebase without
 * explicit @Roles / @RolesFromParam / @PlatformAdminOnly are forbidden
 * to ALL callers — including platform admins.
 *
 * What roles.guard.spec.ts already covers
 * ----------------------------------------
 * Line 220-227 tests one case: a session principal with no metadata →
 * ForbiddenException. That single case proves the guard code path.
 *
 * What this file adds (the exhaustiveness angle)
 * -----------------------------------------------
 * Parametrize over every principal variant that could plausibly claim
 * special treatment — platform admin via context, platform admin via
 * DB fallback, platform-scoped token, tenant-bound token, session —
 * and prove ALL are denied by the default-deny gate before any identity
 * check runs. Step 1 of the guard decision matrix fires first; no
 * caller identity can bypass it.
 *
 * This gives SC-3 and SC-9 a machine-checked guarantee that the guard
 * itself enforces the "opt-in" invariant, not just the current set of
 * decorated handlers.
 *
 * Style: hand-rolled fakes matching roles.guard.spec.ts idioms.
 * Docker-free. No NestJS test module required.
 */

import "reflect-metadata";

import {
  ForbiddenException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { RolesGuard } from "../../src/auth/roles.guard";
import type { Principal } from "../../src/auth/auth.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { TenantContextRequest } from "../../src/context/types";
import type { ResolvedContext } from "../../src/context/types";
import type { BearerAuthScope } from "@data-pulse-2/db/schema";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const USER_ID = "0c000000-0000-7000-8000-00000000aa01";
const SESSION_ID = "0c000000-0000-7000-8000-0000000ses01";
const TOKEN_ID = "0c000000-0000-7000-8000-0000000tok01";
const TENANT_ID = "0c000000-0000-7000-8000-0000000ten01";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeReflector {
  metadata: undefined = undefined;

  getAllAndOverride<T>(_key: string, _targets: unknown[]): T | undefined {
    return undefined;
  }
}

class FakeMembershipRepository {
  platformAdmin = true;

  async findRoleCodeForUserInTenant(
    _userId: string,
    _tenantId: string,
  ): Promise<string | null> {
    return "owner";
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
  memberships: FakeMembershipRepository;
} {
  const reflector = new FakeReflector();
  const memberships = new FakeMembershipRepository();
  const guard = new RolesGuard(
    reflector as unknown as Reflector,
    memberships as unknown as MembershipRepository,
  );
  return { guard, memberships };
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

const platformAdminContext: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: true,
  source: "session",
};

const regularContext: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

// ---------------------------------------------------------------------------
// Default-deny cases — parametrized over principal/context variants
// ---------------------------------------------------------------------------

describe("T206 — default-deny: every principal variant is forbidden when no metadata", () => {
  const cases: Array<{
    name: string;
    principal?: Principal;
    context?: ResolvedContext;
    membershipsSetup?: (m: FakeMembershipRepository) => void;
  }> = [
    {
      name: "session principal with no active context",
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
    },
    {
      name: "session principal with active context (regular user)",
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
      context: regularContext,
    },
    {
      name: "session principal with context flagging isPlatformAdmin=true",
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
      context: platformAdminContext,
    },
    {
      name: "session principal where DB repo returns platformAdmin=true (no context)",
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
      membershipsSetup: (m) => {
        m.platformAdmin = true;
      },
    },
    {
      name: "tenant-bound token (regular scope)",
      principal: {
        kind: "token",
        tokenId: TOKEN_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        storeId: null,
        scope: "dashboard_api" as BearerAuthScope,
      },
    },
    {
      name: "platform-scoped token (tenantId=null, bearer_safe scope)",
      principal: {
        kind: "token",
        tokenId: TOKEN_ID,
        tenantId: null,
        userId: USER_ID,
        storeId: null,
        scope: "dashboard_api" as BearerAuthScope,
      },
    },
    {
      name: "POS token (pos scope)",
      principal: {
        kind: "token",
        tokenId: TOKEN_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        storeId: null,
        scope: "pos" as BearerAuthScope,
      },
    },
    {
      name: "no principal attached at all (unauthenticated)",
    },
  ];

  for (const tc of cases) {
    it(`denies: ${tc.name}`, async () => {
      const { guard, memberships } = buildGuard();
      tc.membershipsSetup?.(memberships);

      const request: TenantContextRequest = {
        headers: {},
        params: {},
        ...(tc.principal ? { principal: tc.principal } : {}),
        ...(tc.context ? { context: tc.context } : {}),
      } as unknown as TenantContextRequest;

      await expect(guard.canActivate(makeCtx(request))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Confirm guard step 1 fires BEFORE identity checks
// ---------------------------------------------------------------------------

describe("T206 — default-deny: step 1 fires before membership repo is consulted", () => {
  it("isPlatformAdmin is never called when no metadata (step 1 wins)", async () => {
    const { guard, memberships } = buildGuard();
    memberships.platformAdmin = true;

    const isPlatformAdminSpy = jest
      .spyOn(memberships, "isPlatformAdmin")
      .mockResolvedValue(true);

    const request: TenantContextRequest = {
      headers: {},
      params: {},
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
    } as unknown as TenantContextRequest;

    await expect(guard.canActivate(makeCtx(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(isPlatformAdminSpy).not.toHaveBeenCalled();
  });

  it("findRoleCodeForUserInTenant is never called when no metadata (step 1 wins)", async () => {
    const { guard, memberships } = buildGuard();

    const findRoleSpy = jest
      .spyOn(memberships, "findRoleCodeForUserInTenant")
      .mockResolvedValue("owner");

    const request: TenantContextRequest = {
      headers: {},
      params: {},
      principal: { kind: "session", sessionId: SESSION_ID, userId: USER_ID },
      context: regularContext,
    } as unknown as TenantContextRequest;

    await expect(guard.canActivate(makeCtx(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(findRoleSpy).not.toHaveBeenCalled();
  });
});
