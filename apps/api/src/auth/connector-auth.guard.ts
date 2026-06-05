/**
 * ConnectorAuthGuard — scope gate for the 015 ERPNext posting-feed surface.
 *
 * Delegates to `AuthGuard` first (handles bearer authentication + attaches
 * `request.principal`), then enforces that ONLY the opaque, revocable MACHINE
 * connector principal may enter the connector feed/ack routes
 * (`/api/connector/v1/erpnext/...`, 012 `connectorBearer`):
 *
 *   - `principal.kind === "token"` + scope === "connector" → allow
 *   - everything else (session, dashboard_api, pos, pos_operator)  → 401
 *
 * The connector is a machine, never a human session and never a POS device — so
 * a cookie session is refused too (unlike DashboardAuthGuard, which allows it).
 * Tenant scope comes from the token's `tenantId` on `request.principal`, never
 * from the body/query (§XII). Non-disclosing 401 on any mismatch.
 *
 * Apply to: ErpnextPostingController (connectorPullPostings + connectorAckOutcome).
 */
import {
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import type { AuthedRequest } from "./auth.guard";

@Injectable()
export class ConnectorAuthGuard extends AuthGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const principal = request.principal;

    if (!principal) throw new UnauthorizedException("Unauthorized");
    if (principal.kind === "token" && principal.scope === "connector") {
      return true;
    }

    throw new UnauthorizedException("Unauthorized");
  }
}
