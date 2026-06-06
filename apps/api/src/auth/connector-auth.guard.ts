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
    if (principal.kind !== "token" || principal.scope !== "connector") {
      throw new UnauthorizedException("Unauthorized");
    }

    // 018-US4 (FR-015): the connector token MUST be linked to a non-disabled
    // connector_registration in its own tenant. Resolve via a connector-only
    // lookup; null → a single non-disclosing 401 (FR-016) covering expired /
    // revoked / unlinked / disabled-instance / cross-tenant. The generic
    // dashboard/POS path is untouched (FR-019).
    const resolved = await this.authTokens.findActiveConnectorCredentialByTokenId(
      principal.tokenId,
    );
    if (!resolved) {
      throw new UnauthorizedException("Unauthorized");
    }

    // Attach the calling connector instance identity (FR-017) for handlers/audit.
    request.connector = resolved;
    return true;
  }
}
