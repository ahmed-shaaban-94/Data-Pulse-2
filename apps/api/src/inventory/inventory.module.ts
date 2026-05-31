/**
 * InventoryModule — 009-SETUP (T002 skeleton).
 *
 * Scaffolds the Inventory source-of-truth domain that 009 introduces (an
 * append-only `stock_movements` ledger + a derived, compute-on-read on-hand
 * balance). This slice creates an EMPTY module only — no controller, no
 * service, no routes. Subsequent slices fill it in incrementally:
 *   - 009-CONTRACT  ([GATED]) — the OpenAPI inventory contract.
 *   - 009-SCHEMA    ([GATED]) — the 0014_inventory migration + Drizzle schema.
 *   - 009-US1-ONHAND 🎯 MVP   — adds inventory.controller.ts +
 *                               inventory.service.ts and the first on-hand
 *                               read + movement-list routes.
 *
 * NOTE on root wiring:
 *   Unlike the 008-SETUP precedent (which deferred app-level registration to
 *   its first route slice), 009-SETUP registers this module in
 *   `apps/api/src/app.module.ts` now. The slice's `allowed_files` includes
 *   app.module.ts by design (review finding F-01): an empty module exposes no
 *   routes, so early registration is behaviourally inert, but it means the
 *   US1 slice never has to touch the root wiring (avoiding a later
 *   allowed-files stop). The module stays bare until 009-US1-ONHAND adds the
 *   first controller + service.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";

/**
 * InventoryModule — populated by 009-US1-ONHAND (T033).
 *
 * Imports (mirror ReconciliationModule):
 *   - AuthModule    — provides PG_POOL (shared pool) + DashboardAuthGuard.
 *   - ContextModule — provides TenantContextGuard (publishes request.context).
 *
 * No AuditModule yet — the US1 READ routes are not audited; the US2 write
 * routes (createStockMovement etc.) will add it. No RolesGuard — US1 uses
 * inline object-level store authz, not @Roles.
 */
@Module({
  imports: [AuthModule, ContextModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
