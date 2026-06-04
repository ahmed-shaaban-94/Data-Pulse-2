/**
 * ErpnextItemMapModule — 013-SETUP (T003) scaffold.
 *
 * Wires the tenant-admin ERPNext Item-mapping suggest/confirm/retire surface
 * (013 product-master-from-erpnext). It links a DP2 `tenant_products` row to an
 * ERPNext **Item** reference (`erpnext_item_map`, migration 0017) so a future
 * sale posting (015) can resolve each sale line to a real Item — a
 * MAPPING/RECONCILIATION layer, NOT a catalog-authority handover (OQ-1, §IX).
 *
 * Authentication is the HUMAN Tenant-Admin cookie session
 * (`packages/contracts/openapi/catalog/erpnext-item-map.yaml` → `cookieAuth`,
 * the httpOnly `dp2_session`), resolved by `DashboardAuthGuard` — NOT the 012
 * `connectorBearer` machine scheme and NOT the POS `clerkJwt` device scheme.
 *
 * Imports mirror `reconciliation.module.ts` (the closest tenant-admin sibling):
 *   - `AuthModule`    — provides `PG_POOL` + `DashboardAuthGuard`.
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the
 *                       `@Auditable(...)` route decorators trigger.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       the `MembershipRepository` that `RolesGuard` needs.
 *
 * 013 adds NO worker and NO outbox event (OQ-8): suggest/confirm/retire are
 * synchronous human actions; the posting-time read belongs to 015.
 *
 * The controller/service land in 013-CRUD; this slice ships the empty,
 * registered module (no routes yet) so the DI graph + build stay green.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";

/**
 * SETUP scaffold: imports + the `RolesGuard` provider are wired now so the
 * 013-CRUD slice adds only its controller/service (no module-graph churn). No
 * controllers or routes ship yet — the surface is empty-but-registered.
 */
@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [],
  providers: [RolesGuard],
})
export class ErpnextItemMapModule {}
