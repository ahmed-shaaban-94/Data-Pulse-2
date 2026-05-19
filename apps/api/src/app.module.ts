import { Module } from "@nestjs/common";

import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { ContextModule } from "./context/context.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { OutboxAdminModule } from "./outbox/admin.module";
import { PosAuditEventsModule } from "./pos-audit-events/pos-audit-events.module";
import { PosOperatorsModule } from "./pos-operators/pos-operators.module";
import { PosShiftsModule } from "./pos-shifts/pos-shifts.module";
import { StoresModule } from "./stores/stores.module";
import { TenantsModule } from "./tenants/tenants.module";

/**
 * Root module.
 *
 * Domain modules wired so far:
 *   - `AuditModule`         — audit event queue producer + global APP_INTERCEPTOR (Scope A)
 *   - `AuthModule`          — sign-in, sign-out, refresh, password-reset (slice 3c)
 *   - `ContextModule`       — active tenant/store switching (US3)
 *   - `TenantsModule`       — tenant CRUD (US2)
 *   - `StoresModule`        — store CRUD within active tenant (US2)
 *   - `MembershipsModule`   — membership revoke (US4, first slice)
 *   - `OutboxAdminModule`   — outbox dead-letter triage (T591, 1C-C1)
 *   - `PosOperatorsModule`  — POS operator sign-in (Wave 1, PR-5)
 *   - `PosAuditEventsModule`— POS audit-event batch sync (Wave 2, PR-6)
 *
 * Cross-cutting interceptors, the global filter, and the global Zod
 * pipe are registered in `main.ts`.
 */
@Module({
  imports: [AuditModule, AuthModule, ContextModule, TenantsModule, StoresModule, MembershipsModule, OutboxAdminModule, PosOperatorsModule, PosAuditEventsModule, PosShiftsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
