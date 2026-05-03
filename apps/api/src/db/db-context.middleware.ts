/**
 * DB context middleware — slice 10 (T155).
 *
 * Spec-named entry point for the request-scoped tenant DB helper.
 * The actual logic lives in `db-context.ts` (no Nest dependency,
 * directly testable). This file is the public name that the spec
 * calls out and that future consumers (tenant/store services,
 * memberships service, audit reads) import.
 *
 * The "middleware" naming is a slight misnomer carried from the
 * task list — it isn't Express middleware. It's the boundary
 * primitive that bridges the request's ALS-resolved tenant context
 * into the `runWithTenantContext` transaction in `packages/db`.
 * The Nest middleware role (bridging `request.context` into ALS) is
 * fulfilled by `ContextInterceptor` in `apps/api/src/context/`.
 */
export {
  runRequestScopedTenantContext,
  tenantContextFromResolved,
} from "./db-context";
