/**
 * UnknownItemsModule — 005 Wave 1 / T500 (skeleton) + T511/T512 (CAPTURE-HAPPY).
 *
 * Wires the unknown-items capture surface. Wave 1 fills this in
 * incrementally; downstream slices add the list endpoint (T524 /
 * 005-WAVE1-LIST), the dismiss endpoint (T541 / 005-WAVE1-DISMISS), and
 * the idempotency-mismatch exception filter (T533 /
 * 005-WAVE1-IDEMP-MISMATCH).
 *
 * Imports:
 *   - `AuthModule`        — provides `PG_POOL` (shared connection pool)
 *                           and `REDIS_CLIENT` (transitively required by
 *                           `IdempotencyModule`).
 *   - `IdempotencyModule` — registers the global APP_INTERCEPTOR
 *                           (`IdempotencyInterceptor`) that the
 *                           `@Idempotent("required")` decorator on the
 *                           capture route engages. T505 (PR #306) proved
 *                           the primitive's coverage for FR-021 /
 *                           FR-021a / FR-021b / FR-021c.
 *   - `AuditModule`       — registers the global APP_INTERCEPTOR
 *                           (`AuditEmitterInterceptor`) that the
 *                           `@Auditable("unknown_item.captured")`
 *                           decorator triggers.
 *
 * NOTE on root wiring:
 *   This module is NOT registered in `apps/api/src/app.module.ts` by
 *   the CAPTURE-HAPPY slice. The slice brief lists `app.module.ts` as
 *   forbidden surface; production root-module registration is left to
 *   a subsequent wiring slice (likely 005-WAVE1-IDEMP-WIRE or a
 *   dedicated polish step) that has explicit authorisation to touch
 *   the root module. Until that slice ships, the integration test
 *   exercises the controller via `Test.createTestingModule` that
 *   imports `UnknownItemsModule` directly — same pattern as T505's
 *   verification spec (which never required root-module registration).
 *
 *   The T500 skeleton comment said this slice would touch
 *   `app.module.ts`; that comment is stale relative to the brief.
 *
 * Service export:
 *   `UnknownItemsService` is exported because downstream Wave 1 slices
 *   (DISMISS, LIST, NON-DISCLOSING) will inject it from sibling
 *   controllers/services.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";

import { IdempotencyMismatchInterceptor } from "./interceptors/idempotency-mismatch.interceptor";
import { UnknownItemsController } from "./unknown-items.controller";
import { UnknownItemsService } from "./unknown-items.service";

@Module({
  // ContextModule provides TenantContextGuard (method-level on LIST + dismiss)
  // and MembershipRepository (transitively required by RolesGuard on dismiss).
  // Wired by 005-WAVE2-AUTH-GUARD-WIRING. POS capture route is intentionally
  // unguarded by these — that route uses a different auth model (POS device
  // token), deferred to a separate wiring slice.
  imports: [AuthModule, IdempotencyModule, AuditModule, ContextModule],
  controllers: [UnknownItemsController],
  // `IdempotencyMismatchInterceptor` is registered as a provider so
  // NestJS resolves its `AUDIT_JOB_ENQUEUER` injection from the audit
  // module (imported above). It is NOT registered as APP_INTERCEPTOR —
  // module-global scope would run it on every route, violating the
  // slice's stop rule ("interceptor must not modify behavior on routes
  // other than the capture route"). Method-scope is applied via
  // `@UseInterceptors(IdempotencyMismatchInterceptor)` on `posCaptureItem`
  // in `unknown-items.controller.ts`.
  // Architectural pivot from the prior `IdempotencyMismatchFilter`
  // (PR 2 of 005-WAVE1-METRICS-MISMATCH-FOLLOWUP) — see
  // specs/005-pos-catalog-sync-reconciliation/wave-status.md
  // §"Investigation update — 2026-05-28 (PR #386 CI evidence)".
  // RolesGuard is registered as a plain class provider; @nestjs/core auto-
  // provides Reflector and MembershipRepository comes from ContextModule.
  providers: [UnknownItemsService, IdempotencyMismatchInterceptor, RolesGuard],
  exports: [UnknownItemsService],
})
export class UnknownItemsModule {}
