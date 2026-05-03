/**
 * ContextModule — slice 11 (T153).
 *
 * Wires the active-context surface:
 *
 *   ContextController
 *     ├─ AuthGuard               (from AuthModule)
 *     └─ ContextService
 *          ├─ SessionRepository  (from AuthModule)
 *          └─ MembershipRepository (provided here)
 *
 * `MembershipRepository` is owned by this module — it lives in
 * `apps/api/src/context/` and exists primarily for `TenantContextGuard`
 * (PR #19) and now `ContextService`. Imports `AuthModule` for
 * `SessionRepository` (and `AuthGuard`, which the controller uses).
 *
 * `TenantContextGuard` is deliberately NOT applied to this controller
 * — see the controller header for the chicken-and-egg explanation.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import { ContextController } from "./context.controller";
import { ContextService } from "./context.service";
import { MembershipRepository } from "./membership.repository";

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
    ContextService,
  ],
  exports: [MembershipRepository, ContextService],
})
export class ContextModule {}
