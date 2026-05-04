/**
 * StoresModule — slice US2 (T134).
 *
 * Wires the store-CRUD surface:
 *
 *   StoresController
 *     ├─ AuthGuard            (from AuthModule, class-level)
 *     ├─ TenantContextGuard   (from ContextModule, class-level)
 *     ├─ RolesGuard           (per-method on POST/PATCH/DELETE)
 *     │     ├─ Reflector         (auto-provided by @nestjs/core)
 *     │     └─ MembershipRepository (from ContextModule)
 *     └─ StoresService
 *          ├─ PG_POOL          (from AuthModule)
 *          ├─ StoresRepository (provided here)
 *          └─ MembershipRepository (from ContextModule)
 *
 * `ContextModule` is imported for both `TenantContextGuard` (which it
 * exports for downstream modules to mount) and `MembershipRepository`
 * (used by `StoresService` for the `kind='specific'` store-access
 * check on read).
 *
 * `RolesGuard` is registered as a plain class provider; Nest auto-
 * provides `Reflector`, and `MembershipRepository` is reachable via
 * the `ContextModule` import. No `useFactory` needed.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RolesGuard } from "../auth/roles.guard";
import { ContextModule } from "../context/context.module";
import { StoresController } from "./stores.controller";
import { StoresRepository } from "./stores.repository";
import { StoresService } from "./stores.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [StoresController],
  providers: [StoresRepository, StoresService, RolesGuard],
  exports: [StoresService, StoresRepository],
})
export class StoresModule {}
