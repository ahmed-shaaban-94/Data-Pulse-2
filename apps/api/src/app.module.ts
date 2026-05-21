import { Injectable, Module, type OnModuleDestroy, type OnModuleInit, Inject } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "./audit/audit.module";
import { AuthModule, PG_POOL } from "./auth/auth.module";
import { ContextModule } from "./context/context.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { OutboxAdminModule } from "./outbox/admin.module";
import { PosAuditEventsModule } from "./pos-audit-events/pos-audit-events.module";
import { PosOperatorsModule } from "./pos-operators/pos-operators.module";
import { PosShiftsModule } from "./pos-shifts/pos-shifts.module";
import { StoresModule } from "./stores/stores.module";
import { TenantsModule } from "./tenants/tenants.module";
import { registerDbPoolGauges } from "./observability/metrics/db.metrics";

/**
 * Nest-aware registrar for the `db_pool_in_use` and `db_pool_waiters`
 * ObservableGauge callbacks (T483 / P4 W1).
 *
 * On `onModuleInit` registers both callbacks against the API's pg.Pool
 * (injected via PG_POOL, exported by AuthModule). On `onModuleDestroy`
 * removes them so the callbacks do not reference a closed pool during
 * graceful shutdown.
 *
 * The pool reads are synchronous in-memory counters — no DB round-trip,
 * no re-entrancy risk, no async I/O.
 */
@Injectable()
class ApiDbPoolGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit(): void {
    this.handle = registerDbPoolGauges({ pool: this.pool });
  }

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}

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
  providers: [ApiDbPoolGaugeRegistrar],
})
export class AppModule {}
