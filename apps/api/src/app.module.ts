import { Injectable, Module, type OnModuleDestroy, type OnModuleInit, Inject } from "@nestjs/common";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
import {
  registerDbPoolGauges,
  registerDbMigrationStatusGauge,
} from "./observability/metrics/db.metrics";

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
 * Count UP migration SQL files in `@data-pulse-2/db/drizzle/`.
 * Called once at module init — throws on any filesystem error so callers
 * can handle discovery failure explicitly rather than silently treating it
 * as "zero migrations" (which would incorrectly mark the gauge as applied).
 */
async function countMigrationFiles(): Promise<number> {
  // `require.resolve` is available in this CJS module (package type: commonjs).
  const pkgJsonPath: string = require.resolve("@data-pulse-2/db/package.json");
  const drizzleDir = resolve(dirname(pkgJsonPath), "drizzle");
  const files = await readdir(drizzleDir);
  return files.filter(
    (f) => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith(".down.sql"),
  ).length;
}

/**
 * Nest-aware registrar for the `db_migration_status` ObservableGauge
 * callback (T483 / P4 W3).
 *
 * On `onModuleInit` resolves the total migration count from the filesystem,
 * then registers the scrape-time callback. On `onModuleDestroy` removes it
 * so a stale callback doesn't fire against a closed pool.
 *
 * If the filesystem count fails, the gauge falls back to `Number.MAX_SAFE_INTEGER`
 * as the total so `pending=1` is always observed — never a false "applied" signal.
 */
@Injectable()
class ApiDbMigrationStatusGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    let totalMigrations: number;
    try {
      totalMigrations = await countMigrationFiles();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          component: "migration.status.gauge",
          message: "could not count migration files; gauge will report pending until resolved",
          error: message,
        }) + "\n",
      );
      // Unknown total → never mark as applied to avoid a false healthy signal.
      totalMigrations = Number.MAX_SAFE_INTEGER;
    }
    this.handle = registerDbMigrationStatusGauge({
      pool: this.pool,
      totalMigrations,
    });
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
  providers: [ApiDbPoolGaugeRegistrar, ApiDbMigrationStatusGaugeRegistrar],
})
export class AppModule {}
