/**
 * ReadDownModule — 010-SETUP (T002 skeleton).
 *
 * Scaffolds the new READ-ONLY catalogue publication surface that 010
 * introduces: it serves the Resolved Sellable Store Catalogue (003 §6.4) to
 * device-authenticated POS terminals as snapshot + delta, scoped to
 * `(tenant_id, store_id)` (wire term `branch_id`). It is the opposite
 * direction of 005 (capture-UP) and MUST NOT be conflated with it.
 *
 * This slice creates an EMPTY module only — no controller, no service, no
 * routes. Subsequent slices fill it in incrementally:
 *   - 010-CONTRACT  ([GATED]) — the OpenAPI read-down contract
 *                               (packages/contracts/openapi/catalog/read-down.yaml).
 *   - 010-SCHEMA    ([GATED]) — the 0015 catalogue change-log migration +
 *                               Drizzle schema + population triggers (R1/R9).
 *   - 010-US1-SNAPSHOT 🎯 MVP — adds read-down.controller.ts +
 *                               read-down.service.ts + the toBody() projection
 *                               and the first `posGetCatalogSnapshot` route.
 *   - 010-US2-DELTA          — adds the `posGetCatalogDeltas` route (shares the
 *                               controller/service → serialized after US1).
 *
 * 010-US1-SNAPSHOT will add the import surface this read-only module needs
 * (mirroring SalesModule / ReconciliationModule):
 *   - AuthModule    — provides PG_POOL (shared pool) + PosOperatorAuthGuard
 *                     (the device-principal guard `posCaptureItem` + the 008
 *                     sales POS routes use).
 *   - ContextModule — provides TenantContextGuard / scope resolution.
 *   - AuditModule   — registers the global AuditEmitterInterceptor that the
 *                     `@Auditable(...)` read-access audit (FR-080) triggers.
 *
 * The platform stays the catalogue authority (§IX); there is NO write surface
 * (GET only). Unlike 008, this module is registered in app.module.ts at SETUP
 * time (per the 010 execution-map allowed_files) — the empty module compiles
 * and wires cleanly with no routes.
 */
import { Module } from "@nestjs/common";

@Module({})
export class ReadDownModule {}
