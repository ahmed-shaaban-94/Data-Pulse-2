/**
 * ReconciliationModule — 005-WAVE2-LINK-HAPPY (T622 skeleton).
 *
 * Wires the tenant-admin reconciliation surface. Wave 2 fills this in
 * incrementally; downstream slices add the create-new endpoint (T630).
 *
 * Imports:
 *   - `AuthModule`   — provides `PG_POOL` (shared connection pool).
 *   - `AuditModule`  — registers the global APP_INTERCEPTOR
 *                      (`AuditEmitterInterceptor`) that the
 *                      `@Auditable("unknown_item.resolved.linked")`
 *                      decorator on the link route triggers.
 *
 * NOTE on root wiring:
 *   This module is NOT registered in `apps/api/src/app.module.ts` by the
 *   LINK-HAPPY slice. The slice brief lists `app.module.ts` as forbidden
 *   surface; production root-module registration is left to a subsequent
 *   wiring slice that has explicit authorisation to touch the root module.
 *   Until that slice ships, integration tests exercise the controller via
 *   `Test.createTestingModule` — same pattern as `UnknownItemsModule`.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";

@Module({
  // ContextModule is imported for both TenantContextGuard (class-level on
  // ReconciliationController) and MembershipRepository (transitively
  // required by RolesGuard for membership-role lookup). Mirrors the
  // StoresModule wiring — see stores.module.ts for the canonical pattern.
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ReconciliationController],
  // RolesGuard is registered as a plain class provider; @nestjs/core auto-
  // provides Reflector, and MembershipRepository is reachable via the
  // ContextModule import. No useFactory needed.
  providers: [ReconciliationService, RolesGuard],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
