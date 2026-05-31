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

@Module({})
export class InventoryModule {}
