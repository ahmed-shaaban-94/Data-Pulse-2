/**
 * PosOperatorAuthGuard — scope gate for POS-operator route families.
 *
 * Mirror of `DashboardAuthGuard`. Delegates to `AuthGuard` first (handles
 * bearer authentication and attaches `request.principal`), then enforces
 * that ONLY the internal `pos_operator`-scoped bearer token may enter
 * POS-operator routes:
 *
 *   - `principal.kind === "session"`                          → 401
 *     (dashboard cookie sessions never reach POS surfaces)
 *   - `principal.kind === "token"` + scope === "pos_operator" → allow
 *   - `principal.kind === "token"` + scope === "dashboard_api" → 401
 *   - `principal.kind === "token"` + scope === "pos"          → 401
 *     (POS service-account tokens are not operator-session state — see
 *     002 FR-POS-AUTH-4 and FR-POS-AUTH-5)
 *
 * Apply to: POS-operator-authenticated routes such as the unknown-items
 * POS capture (`POST /api/pos/v1/catalog/unknown-items`).
 *
 * Spec anchor: specs/002-pos-operator-identity FR-POS-AUTH-4 —
 *   "The internal POS operator session token has scope `pos_operator` and
 *    is rejected on non-POS routes by a scope guard. Conversely, dashboard
 *    cookies and non-POS bearer tokens are rejected on POS routes."
 */
import {
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import type { AuthedRequest } from "./auth.guard";

@Injectable()
export class PosOperatorAuthGuard extends AuthGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;

    if (!principal) throw new UnauthorizedException("Unauthorized");
    if (principal.kind === "token" && principal.scope === "pos_operator") {
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }
}
