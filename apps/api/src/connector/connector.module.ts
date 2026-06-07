/**
 * ConnectorModule — 018-SETUP scaffold.
 *
 * The DP2 side of **Connector Boundary Hardening** (feature 018): the auth /
 * identity boundary the ERPNext connector (separate repo, ADR 0008) crosses to
 * reach the 012 posting-feed contract. The connector authenticates with the
 * **machine** `connectorBearer` scheme (opaque-revocable, tenant-scoped) — NOT
 * the human `cookieAuth`/`DashboardAuthGuard` (013/014) and NOT the POS
 * `clerkJwt`/device scheme (010). This module owns that connector-identity
 * surface; it is auth/identity and therefore lives at the api root, NOT under
 * `catalog/`.
 *
 * US1 (T044) adds the human-operator admin surface: register / list / issue,
 * gated by `SessionOnlyAdminGuard` (human cookie session ONLY — FR-005c) +
 * `RolesGuard` `@Roles("owner","tenant_admin")` (FR-005b) + `TenantContextGuard`.
 * US2/US3 extend the same controller/service (rotate/revoke, disable).
 *
 * Imports mirror the tenant-scoped admin siblings:
 *   - `AuthModule`    — provides `PG_POOL` + the auth primitives + the guards.
 *   - `AuditModule`   — 018 writes a NEW in-transaction `INSERT INTO audit_events`
 *                       for credential atomicity (FR-020), NOT the async path.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ConnectorRegistrationController } from "./connector-registration.controller";
import { ConnectorRegistrationService } from "./connector-registration.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ConnectorRegistrationController],
  providers: [ConnectorRegistrationService],
  exports: [ConnectorRegistrationService],
})
export class ConnectorModule {}
