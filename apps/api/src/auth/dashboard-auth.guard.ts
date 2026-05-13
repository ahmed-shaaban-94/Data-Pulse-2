/**
 * DashboardAuthGuard — scope gate for SaaS dashboard/admin route families.
 *
 * Delegates to `AuthGuard` first (handles all cookie/bearer authentication
 * and attaches `request.principal`), then enforces that POS-scoped bearer
 * tokens cannot enter dashboard routes:
 *
 *   - `principal.kind === "session"`                → allow (cookie session)
 *   - `principal.kind === "token"` + scope === "dashboard_api" → allow
 *   - `principal.kind === "token"` + scope === "pos"           → 401
 *   - `principal.kind === "token"` + scope === "pos_operator"  → 401
 *
 * Apply to: StoresController, TenantsController, ContextController,
 * MembershipsController, AuditController.
 *
 * Do NOT apply to POS controllers — those should keep AuthGuard directly.
 */
import {
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import type { AuthedRequest } from "./auth.guard";

@Injectable()
export class DashboardAuthGuard extends AuthGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;

    if (!principal) throw new UnauthorizedException("Unauthorized");
    if (principal.kind === "session") return true;
    if (principal.kind === "token" && principal.scope === "dashboard_api") {
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }
}
