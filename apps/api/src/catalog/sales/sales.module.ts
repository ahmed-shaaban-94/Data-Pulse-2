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
 * NOTE on root wiring:
 *   This module is intentionally NOT registered in
 *   `apps/api/src/app.module.ts` by the 008-SETUP slice. The slice's
 *   `allowed_files` is scoped to this file only (execution-map.yaml), and an
 *   empty module exposes no routes, so app-level registration has no
 *   behavioural effect yet. Root registration is deferred to the slice that
 *   first adds a real route surface (008-US1-CAPTURE), mirroring how the
 *   sibling `reconciliation` module was staged before its wiring slice.
 */
import { Module } from "@nestjs/common";

@Module({})
export class SalesModule {}
