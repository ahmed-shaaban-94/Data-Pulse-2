/**
 * MembershipsController — slice US4 (T174).
 *
 * Implements the revoke endpoint from
 * `specs/001-foundation-auth-tenant-store/contracts/memberships.openapi.yaml`:
 *
 *     DELETE /api/v1/memberships/:membership_id   revokeMembership
 *
 * Authorization model (active-tenant context, same as StoresController)
 * -----------------------------------------------------------------------
 * Class-level `@UseGuards(AuthGuard, TenantContextGuard)`:
 *   - `AuthGuard`          — authenticates the caller.
 *   - `TenantContextGuard` — requires an active tenant (→ 401 on miss)
 *                            and populates `request.context`.
 *
 * Method-level `@UseGuards(RolesGuard) @Roles("owner","tenant_admin",{denyAs:403})`:
 *   - Caller must be `owner` or `tenant_admin` within the active tenant.
 *   - `denyAs: 403` (not 404): the caller is already inside their
 *     active tenant, so denying existence would be misleading. 403
 *     leaks no side-channel compared to the 401 the guard just passed.
 *     This mirrors `POST /stores` which uses the same `denyAs: 403`.
 *
 * 404 semantics (service-level)
 * ------------------------------
 * The service throws 404 when the membership_id is not found, belongs
 * to a different tenant (RLS-filtered), is already revoked, or is
 * soft-deleted. This is indistinguishable from a bad id — correct per
 * FR-ISO-4.
 */
import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { TenantContextGuard } from "../context/tenant-context.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import type { TenantContextRequest } from "../context/types";
import { MembershipsService } from "./memberships.service";

@Controller("api/v1/memberships")
@UseGuards(AuthGuard, TenantContextGuard)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Delete(":membership_id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  async revoke(
    @Req() request: TenantContextRequest,
    @Param("membership_id", new ParseUUIDPipe()) membershipId: string,
  ): Promise<void> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    await this.membershipsService.revoke(ctx, membershipId);
  }
}
