/**
 * RolesGuard — slice US5 (T201).
 *
 * Authorization primitive that consumes `@Roles()`, `@RolesFromParam()`,
 * and `@PlatformAdminOnly()` metadata (see `roles.decorator.ts`) and
 * decides whether the caller's principal + active tenant satisfy the
 * gate.
 *
 * Composition
 * -----------
 * Designed to run AFTER `AuthGuard` (and, on routes that use it, AFTER
 * `TenantContextGuard`):
 *
 *   @UseGuards(AuthGuard, TenantContextGuard, RolesGuard)
 *   @Roles("owner", "tenant_admin")
 *   @Patch(...)
 *
 * For path-as-context routes the chain is just:
 *
 *   @UseGuards(AuthGuard, RolesGuard)
 *   @RolesFromParam("id", "owner", "tenant_admin")
 *
 * Why no module wiring yet
 * ------------------------
 * This slice introduces the primitive only — no controller mounts it.
 * The retrofit of inline checks in `TenantsService` is intentionally a
 * separate PR. When the first controller actually applies it, that PR
 * will register the guard as a provider on the relevant module.
 *
 * Decision matrix
 * ---------------
 * The guard runs in this exact order; the first match wins.
 *
 *   1. No `RolesMetadata` on the route                 → 403 (default deny).
 *      Fail-closed posture: a handler with no decorator is unauthorized
 *      to everyone, including platform admins. Forces the team to opt in
 *      explicitly via `@Roles()` / `@PlatformAdminOnly()` / (future)
 *      `@Public()`.
 *
 *   2. No `request.principal`                          → 401.
 *      AuthGuard didn't run, or ran and failed silently. Either way,
 *      this is a wiring bug surfaced as Unauthorized — the correct
 *      shape for "no caller identity attached".
 *
 *   3. `@PlatformAdminOnly()` + caller is platform admin → allow.
 *      `@PlatformAdminOnly()` + caller is NOT             → 403.
 *      403 (not 404) per FR-ISO-4 split documented in
 *      `tenants.service.ts:23-29` — platform-admin status is
 *      self-knowable, so a forbidden response leaks no side-channel.
 *
 *   4. Platform-admin bypass for `@Roles` / `@RolesFromParam`:
 *        a. `request.context?.isPlatformAdmin === true`         → allow.
 *        b. Token principal with `tenantId === null`            → allow
 *           (only platform admins mint platform-scoped tokens; see
 *           `tenant-context.guard.ts:111-122`).
 *        c. `MembershipRepository.isPlatformAdmin(userId)`      → allow.
 *           This last check covers path-as-context routes that don't
 *           mount `TenantContextGuard` (so 4a is unavailable) and
 *           cookie-session admins (so 4b doesn't fire).
 *
 *   5. Resolve tenant id from `RolesMetadata.tenantFrom`:
 *        - `"context"`     → `request.context?.tenantId`
 *                            null/undefined → 403 ("active tenant
 *                            required"). The caller authenticated but
 *                            hasn't picked a tenant; this is distinct
 *                            from "wrong tenant".
 *        - `"param:<key>"` → `request.params[<key>]`
 *                            null/undefined → 403 (route wiring bug —
 *                            decorator names a param the path doesn't
 *                            expose).
 *
 *   6. Extract user id from principal:
 *        - sessions always carry `userId`.
 *        - tokens may have `userId === null` (device-bound tokens). A
 *          userless token attempting a role-gated route is mapped to
 *          404 — same shape as "no membership" — to avoid leaking
 *          tenant existence.
 *
 *   7. `MembershipRepository.findRoleCodeForUserInTenant(userId, tenantId)`:
 *        - `null` or role NOT in `metadata.any`:
 *            - `metadata.denyAs === 404` (default)  → `NotFoundException`
 *               No active membership / wrong role rides the same shape
 *               as cross-tenant per FR-ISO-4. Use this for path-as-
 *               context routes where the tenant id IS a secret being
 *               protected (e.g. `PATCH /tenants/:id`).
 *            - `metadata.denyAs === 403`           → `ForbiddenException`
 *               Use when the caller is acting within their already-
 *               resolved active tenant and existence is not a secret
 *               (e.g. `POST /api/v1/stores`). Returning 404 there would
 *               be misleading.
 *        - role in `metadata.any`          → allow.
 *
 * No state, no caching, no ALS bridging. The guard is pure policy on
 * top of `request.principal`, `request.context`, and a single
 * repository call.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { Principal } from "./auth.guard";
import { MembershipRepository } from "../context/membership.repository";
import type { TenantContextRequest } from "../context/types";
import {
  ROLES_METADATA_KEY,
  type RoleCode,
  type RolesMetadata,
} from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(MembershipRepository)
    private readonly memberships: MembershipRepository,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<
      RolesMetadata | undefined
    >(ROLES_METADATA_KEY, [execCtx.getHandler(), execCtx.getClass()]);

    // (1) Default deny.
    if (!metadata) throw forbidden("Forbidden");

    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();
    const principal = request.principal;

    // (2) No identity attached.
    if (!principal) throw unauthorized();

    // (3) Platform-admin-only branch.
    if (metadata.platformAdminOnly) {
      const isAdmin = await this.isPlatformAdmin(principal, request);
      if (isAdmin) return true;
      throw forbidden("Platform admin role required.");
    }

    // (4) Platform-admin bypass for @Roles / @RolesFromParam.
    if (await this.isPlatformAdmin(principal, request)) return true;

    // (5) Resolve tenant id.
    const tenantId = resolveTenantId(metadata, request);
    if (!tenantId) {
      throw forbidden(
        metadata.tenantFrom === "context"
          ? "Active tenant required."
          : "Tenant id missing from request path.",
      );
    }

    // (6) User id from principal.
    const userId = principal.userId;
    if (!userId) throw denied(metadata);

    // (7) Membership + role check.
    const role = await this.memberships.findRoleCodeForUserInTenant(
      userId,
      tenantId,
    );
    if (!role) throw denied(metadata);
    if (!isAcceptedRole(role, metadata.any)) throw denied(metadata);
    return true;
  }

  /**
   * Three-way platform-admin probe (see decision matrix #4):
   *   - explicit context flag (TenantContextGuard already resolved it),
   *   - platform-scoped token (tenantId === null at issuance), or
   *   - fallback DB lookup for path-as-context routes.
   */
  private async isPlatformAdmin(
    principal: Principal,
    request: TenantContextRequest,
  ): Promise<boolean> {
    if (request.context?.isPlatformAdmin === true) return true;
    if (principal.kind === "token" && principal.tenantId === null) return true;
    const userId = principal.userId;
    if (!userId) return false;
    return this.memberships.isPlatformAdmin(userId);
  }
}

function resolveTenantId(
  metadata: RolesMetadata,
  request: TenantContextRequest,
): string | null {
  if (metadata.tenantFrom === "context") {
    return request.context?.tenantId ?? null;
  }
  // tenantFrom = `param:<key>` — extract the param name after the colon.
  const paramKey = metadata.tenantFrom.slice("param:".length);
  if (paramKey.length === 0) return null;
  const params = request.params as Record<string, string | undefined> | undefined;
  const value = params?.[paramKey];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function isAcceptedRole(actual: string, accepted: readonly RoleCode[]): boolean {
  for (const code of accepted) {
    if (code === actual) return true;
  }
  return false;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException("Unauthorized");
}

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException(message);
}

function notFound(): NotFoundException {
  // 404 (not 403) for cross-tenant or wrong-role per FR-ISO-4: the
  // existence of the resource at this access level must look identical
  // to "doesn't exist".
  return new NotFoundException("Not Found");
}

/**
 * Translate a role-check failure to either 403 or 404 based on the
 * decorator's `denyAs` field. See `RolesMetadata.denyAs` and the
 * decision-matrix step 7 in the class docstring.
 */
function denied(
  metadata: RolesMetadata,
): ForbiddenException | NotFoundException {
  if (metadata.denyAs === 403) {
    return new ForbiddenException("Insufficient role.");
  }
  return notFound();
}
