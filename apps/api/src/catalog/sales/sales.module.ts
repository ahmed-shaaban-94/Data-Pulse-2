/**
 * SalesModule — 008-SETUP (T002 skeleton).
 *
 * Scaffolds the new sale-fact surface that 008 introduces (the first sale
 * fact the SaaS owns: `sales` + `sale_lines` + void/refund terminal events).
 * This slice creates an EMPTY module only — no controller, no service, no
 * routes. Subsequent slices fill it in incrementally:
 *   - 008-CONTRACT  ([GATED]) — the OpenAPI sale contract.
 *   - 008-SCHEMA    ([GATED]) — the 0012_sales migration + Drizzle schema.
 *   - 008-US1-CAPTURE 🎯 MVP  — adds sales.controller.ts + sales.service.ts
 *                               and the first POS capture route.
 *
 * 008-US1-CAPTURE wires the first route surface (captureSale + readSale) and
 * registers this module in `apps/api/src/app.module.ts` (the root-wiring step
 * SETUP deferred to "the slice that adds a real route surface").
 *
 * Imports (mirror UnknownItemsModule):
 *   - AuthModule        — provides PG_POOL (shared pool) + PosOperatorAuthGuard.
 *   - IdempotencyModule — registers the global IdempotencyInterceptor that the
 *                         `@Idempotent("required")` decorator on captureSale
 *                         engages (FR-051).
 *   - AuditModule       — registers the global AuditEmitterInterceptor that the
 *                         `@Auditable("sale.captured")` decorator triggers.
 *   - ContextModule     — provides TenantContextGuard.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [AuthModule, IdempotencyModule, AuditModule, ContextModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
