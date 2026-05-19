/**
 * OutboxAdminModule — wires the read-only dead-letter triage endpoint
 * stack (T591, slice 1C-C1).
 *
 *   Controller : `OutboxAdminController` (mounts at /api/v1/admin/outbox)
 *   Service    : `OutboxAdminService` (consumes PG_POOL)
 *   Guards     : `DashboardAuthGuard` + `RolesGuard` (controller-level)
 *
 * Imports
 * -------
 *   - `AuthModule` — exposes `PG_POOL` (the production pg.Pool) and the
 *     `RolesGuard` dependencies (`MembershipRepository`, `Reflector`).
 *
 * No second Postgres pool is created. The pool is the same `PG_POOL` that
 * AuthModule provisions; the dead-letter repository functions execute
 * under `runWithTenantContext({ tenantId: null, isPlatformAdmin: true })`
 * — the runtime DB role does NOT bypass RLS (Constitution §II).
 *
 * `RolesGuard` is listed in providers (same pattern as AuditModule) so
 * the controller-level `@UseGuards(DashboardAuthGuard, RolesGuard)` can
 * resolve it via DI. `MembershipRepository` is resolved transitively
 * through AuthModule's exports.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";

import { OutboxAdminController } from "./admin.controller";
import { OutboxAdminService } from "./admin.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [OutboxAdminController],
  providers: [OutboxAdminService, RolesGuard],
})
export class OutboxAdminModule {}
