import { Module } from "@nestjs/common";

/**
 * Empty root module.
 *
 * Domain modules (AuthModule, TenantsModule, StoresModule,
 * MembershipsModule, ContextModule, AuditModule) are deliberately NOT
 * wired here yet — they land in Phase 3+. The cross-cutting interceptors,
 * filter, and pipe are registered globally in `main.ts` (not as module
 * providers), so this module can stay empty.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
