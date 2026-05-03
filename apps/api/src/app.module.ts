import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module";
import { ContextModule } from "./context/context.module";
import { TenantsModule } from "./tenants/tenants.module";

/**
 * Root module.
 *
 * Domain modules wired so far:
 *   - `AuthModule`     — sign-in, sign-out, refresh, password-reset (slice 3c)
 *   - `ContextModule`  — active tenant/store switching (US3)
 *   - `TenantsModule`  — tenant CRUD (US2, this slice)
 *
 * The remaining domain modules — StoresModule, MembershipsModule,
 * AuditModule — land in later Phase-3+ slices. Cross-cutting
 * interceptors, the global filter, and the global Zod pipe are
 * registered in `main.ts`.
 */
@Module({
  imports: [AuthModule, ContextModule, TenantsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
