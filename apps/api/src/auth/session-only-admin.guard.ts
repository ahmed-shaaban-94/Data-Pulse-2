/**
 * SessionOnlyAdminGuard — slice 018-US1 (T044a), FR-005c.
 *
 * Authorizes the connector credential-lifecycle surface (register / list /
 * issue / rotate / revoke / disable). This surface MINTS connector machine
 * credentials, so it must be reachable ONLY by a HUMAN cookie session — never
 * by another machine bearer, even an owner/tenant-admin `dashboard_api` token.
 *
 * Delegates to `AuthGuard` first (handles cookie/bearer authentication + attaches
 * `request.principal`), then enforces the KIND check:
 *
 *   - `principal.kind === "session"`  → allow (human cookie session)
 *   - `principal.kind === "token"`    → 401 (ANY bearer, incl. dashboard_api)
 *
 * This is deliberately STRICTER than `DashboardAuthGuard`, which allows
 * `principal.kind === "token" && scope === "dashboard_api"`. The role check
 * (`RolesGuard` `@Roles("owner","tenant_admin")`) is ORTHOGONAL and runs AFTER
 * this guard — a `dashboard_api` bearer belonging to a privileged member would
 * pass the role check, so the kind check is what closes the
 * machine-bearer-mints-machine-credential privilege path (FR-005c).
 *
 * Non-disclosing 401 on any non-session principal (§II). Tenant scope comes
 * from `request.context` (set by `TenantContextGuard`, which runs in the same
 * chain), never from the body/query (§XII).
 *
 * Apply (in order) to the connector admin controller:
 *   @UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
 *   @Roles("owner", "tenant_admin")
 */
import {
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import type { AuthedRequest } from "./auth.guard";

@Injectable()
export class SessionOnlyAdminGuard extends AuthGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;

    if (!principal) throw new UnauthorizedException("Unauthorized");
    // Human cookie session ONLY. Any token principal — including a privileged
    // dashboard_api bearer — is rejected (FR-005c). The role gate is separate.
    if (principal.kind === "session") {
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }
}
