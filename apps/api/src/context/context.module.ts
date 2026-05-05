/**
 * ContextModule — slice 11 (T153) + Stores wiring (T134).
 *
 * Wires the active-context surface:
 *
 *   ContextController
 *     ├─ AuthGuard               (from AuthModule)
 *     └─ ContextService
 *          ├─ SessionRepository  (from AuthModule)
 *          └─ MembershipRepository (provided here)
 *
 *   TenantContextGuard           (provided + exported here)
 *     ├─ SessionRepository       (from AuthModule)
 *     └─ MembershipRepository    (provided here)
 *
 * `MembershipRepository` is owned by this module — it lives in
 * `apps/api/src/context/` and is consumed by `TenantContextGuard`
 * (PR #19), `ContextService`, and downstream modules (`TenantsModule`,
 * `StoresModule`).
 *
 * `TenantContextGuard` is also owned and **exported** here so feature
 * modules (e.g., `StoresModule` for active-tenant routes) can mount it
 * via `@UseGuards(...)`. This module's own `ContextController` does NOT
 * mount it — see the controller header for the chicken-and-egg
 * rationale.
 *
 * Imports `AuthModule` for `SessionRepository` (used by both
 * `ContextService` and `TenantContextGuard`) and the `AuthGuard` /
 * `PG_POOL` tokens.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import { SessionRepository } from "../auth/session.repository";
import { ContextController } from "./context.controller";
import { ContextService } from "./context.service";
import { MembershipRepository } from "./membership.repository";
import { TenantContextGuard } from "./tenant-context.guard";

@Module({
  imports: [AuthModule],
  controllers: [ContextController],
  providers: [
    {
      provide: MembershipRepository,
      useFactory: (pool: Pool): MembershipRepository =>
        new MembershipRepository(pool),
      inject: [PG_POOL],
    },
    {
      provide: ContextService,
      useFactory: (
        sessions: SessionRepository,
        memberships: MembershipRepository,
        pool: Pool,
      ): ContextService => new ContextService(sessions, memberships, pool),
      inject: [SessionRepository, MembershipRepository, PG_POOL],
    },
    {
      provide: TenantContextGuard,
      useFactory: (
        sessions: SessionRepository,
        memberships: MembershipRepository,
        pool: Pool,
      ): TenantContextGuard =>
        new TenantContextGuard(sessions, memberships, pool),
      inject: [SessionRepository, MembershipRepository, PG_POOL],
    },
  ],
  exports: [MembershipRepository, ContextService, TenantContextGuard],
})
export class ContextModule {}
