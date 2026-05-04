import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module";
import { ContextModule } from "./context/context.module";
import { MembershipsModule } from "./memberships/memberships.module";
import { StoresModule } from "./stores/stores.module";
import { TenantsModule } from "./tenants/tenants.module";

/**
 * Root module.
 *
 * Domain modules wired so far:
 *   - `AuthModule`        — sign-in, sign-out, refresh, password-reset (slice 3c)
 *   - `ContextModule`     — active tenant/store switching (US3)
 *   - `TenantsModule`     — tenant CRUD (US2)
 *   - `StoresModule`      — store CRUD within active tenant (US2)
 *   - `MembershipsModule` — membership revoke (US4, first slice)
 *
 * Cross-cutting interceptors, the global filter, and the global Zod
 * pipe are registered in `main.ts`.
 */
@Module({
  imports: [AuthModule, ContextModule, TenantsModule, StoresModule, MembershipsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
