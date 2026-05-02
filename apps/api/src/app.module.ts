import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module";

/**
 * Root module.
 *
 * Slice 3c lights up `AuthModule` (the first domain module to expose
 * routes). The remaining domain modules — TenantsModule, StoresModule,
 * MembershipsModule, ContextModule, AuditModule — land in later
 * Phase-3 slices. Cross-cutting interceptors, the global filter, and
 * the global Zod pipe are still registered in `main.ts`, so this module
 * just imports its children.
 */
@Module({
  imports: [AuthModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
