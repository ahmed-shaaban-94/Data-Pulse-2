/**
 * TenantContextGuard — slice 9 (T151).
 *
 * Resolves the active **tenant** + **store** context for an
 * authenticated request and publishes it as `request.context`.
 *
 * Composition
 * -----------
 * Designed to run AFTER `AuthGuard` in the guard pipeline:
 *
 *     @UseGuards(AuthGuard, TenantContextGuard)
 *
 * `AuthGuard` populates `request.principal`. This guard reads that
 * field and resolves the active tenant / store via the appropriate
 * source for each principal kind:
 *
 *   - `kind === "session"` — `SessionRepository.findActiveById(...)`,
 *     then `session.activeTenantId` / `session.activeStoreId`.
 *   - `kind === "token"` — `principal.tenantId` (baked at issuance);
 *     storeId from `principal` if/when tokens carry one (today the
 *     `Principal` type only exposes `tenantId`, so storeId resolves
 *     to `null` for tokens — a future slice can add it).
 *
 * Validation
 * ----------
 * For session principals (the common dashboard path):
 *
 *   - **No `principal`**         → `UnauthorizedException`.
 *   - **No active tenant**       → `UnauthorizedException`. The caller
 *                                  has authenticated but hasn't picked
 *                                  a tenant yet (FR-CTX-1).
 *   - **No active membership**   → `NotFoundException` (FR-ISO-4 — do
 *                                  not leak that the tenant exists).
 *   - **Cross-tenant store**     → `NotFoundException`.
 *   - **Cross-store policy**     → `NotFoundException` (membership has
 *                                  `kind='specific'`, no `store_access`
 *                                  row).
 *
 * Platform admins (`users.is_platform_admin = true`) bypass the
 * membership check (FR-TEN-6); they may have an active tenant set
 * without a membership row. Store-access validation still applies if
 * `activeStoreId` is set, falling back to the `'all'` branch.
 *
 * Token principals
 * ----------------
 * Tokens carry a tenant binding from issuance. We do NOT re-validate
 * the tenant per-request in this slice; if the tenant was deleted, the
 * eventual DB middleware (T155) sets `app.current_tenant` to the
 * deleted UUID and RLS naturally returns no rows — defence in depth.
 *
 * A token with `principal.tenantId === null` is a platform-scoped
 * token; the guard resolves it as `{ tenantId: null,
 * isPlatformAdmin: true, source: "token" }`.
 *
 * What this guard does NOT do
 * ---------------------------
 *   - Set the Postgres GUCs (`app.current_tenant`,
 *     `app.is_platform_admin`). That's the DB middleware's job (T155).
 *   - Wrap downstream handlers in `runInContext(...)`. That's the
 *     companion interceptor's job (also T155). The guard exposes
 *     `runInContext` / `getResolvedContext` from `context.als.ts` so
 *     the interceptor can bridge `request.context` into the ALS once
 *     it lands.
 *   - Audit context switches. That's `ContextController` (T152/T153).
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Principal } from "../auth/auth.guard";
import { SessionRepository } from "../auth/session.repository";
import { MembershipRepository } from "./membership.repository";
import type { ResolvedContext, TenantContextRequest } from "./types";

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(SessionRepository)
    private readonly sessions: SessionRepository,
    @Inject(MembershipRepository)
    private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();
    const principal = request.principal;
    if (!principal) throw unauthorized();

    const resolved = await this.resolve(principal);
    request.context = resolved;
    return true;
  }

  /**
   * Top-level dispatch on principal kind. Public-on-class so tests can
   * call it directly without going through the Nest `ExecutionContext`
   * shim.
   */
  async resolve(principal: Principal): Promise<ResolvedContext> {
    if (principal.kind === "token") {
      return this.resolveToken(principal);
    }
    return this.resolveSession(principal);
  }

  private resolveToken(
    principal: Extract<Principal, { kind: "token" }>,
  ): ResolvedContext {
    // Platform-scoped tokens (`tenantId === null`) resolve as platform
    // admins by definition — only platform admins can mint them.
    if (principal.tenantId === null) {
      return {
        userId: principal.userId,
        tenantId: null,
        storeId: null,
        isPlatformAdmin: true,
        source: "token",
      };
    }
    return {
      userId: principal.userId,
      tenantId: principal.tenantId,
      storeId: null, // tokens don't carry a store binding in the current Principal type
      isPlatformAdmin: false,
      source: "token",
    };
  }

  private async resolveSession(
    principal: Extract<Principal, { kind: "session" }>,
  ): Promise<ResolvedContext> {
    const session = await this.sessions.findActiveById(principal.sessionId);
    // AuthGuard already validated the session; treat a now-missing/expired
    // row as an unauthenticated edge case (TOCTOU between guards).
    if (!session) throw unauthorized();
    if (!session.activeTenantId) throw unauthorized();

    const tenantId = session.activeTenantId;
    const storeId = session.activeStoreId;

    const isPlatformAdmin = await this.memberships.isPlatformAdmin(
      principal.userId,
    );

    if (!isPlatformAdmin) {
      // FR-CTX-2: validate active membership.
      const membership = await this.memberships.findActiveMembership(
        principal.userId,
        tenantId,
      );
      if (!membership) throw notFound();

      // FR-CTX-3: validate active-store reachability if set.
      if (storeId !== null) {
        const ok = await this.memberships.canAccessStore(
          membership.membershipId,
          tenantId,
          storeId,
          membership.storeAccessKind,
        );
        if (!ok) throw notFound();
      }
    } else if (storeId !== null) {
      // Platform admin with an active store: only validate the store
      // belongs to the active tenant (no membership/access policy
      // applies to platform admins). The repo's 'all' branch does
      // exactly that check; we pass a synthetic membershipId because
      // 'all' never references it.
      const ok = await this.memberships.canAccessStore(
        "00000000-0000-0000-0000-000000000000",
        tenantId,
        storeId,
        "all",
      );
      if (!ok) throw notFound();
    }

    return {
      userId: principal.userId,
      tenantId,
      storeId,
      isPlatformAdmin,
      source: "session",
    };
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function notFound(): NotFoundException {
  // 404 (not 403) per FR-ISO-4: error responses must NOT distinguish
  // "resource exists in another tenant" from "resource does not exist".
  return new NotFoundException("Not Found");
}
