/**
 * TenantsModule — slice 12 (T131).
 *
 * Wires the tenant-CRUD surface:
 *
 *   TenantsController
 *     ├─ AuthGuard            (from AuthModule)
 *     └─ TenantsService
 *          ├─ PG_POOL          (from AuthModule)
 *          ├─ TenantsRepository (provided here)
 *          └─ MembershipRepository (from ContextModule)
 *
 * Imports `AuthModule` for `AuthGuard` and the `PG_POOL` token,
 * and `ContextModule` for `MembershipRepository.isPlatformAdmin` /
 * `findRoleCodeForUserInTenant`.
 *
 * `TenantContextGuard` is intentionally NOT applied — see
 * `tenants.controller.ts` header for the path-as-context rationale.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { TenantsController } from "./tenants.controller";
import { TenantsRepository } from "./tenants.repository";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [TenantsController],
  providers: [TenantsRepository, TenantsService],
  exports: [TenantsService, TenantsRepository],
})
export class TenantsModule {}
