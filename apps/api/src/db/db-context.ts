/**
 * Request-scoped DB tenant-context helper — slice 10 (T155, DB half).
 *
 * Bridges the request's `ResolvedContext` (published by
 * `TenantContextGuard`, PR #19, and made ambient by `ContextInterceptor`)
 * into `runWithTenantContext` from `@data-pulse-2/db`.
 *
 *     const rows = await runRequestScopedTenantContext(pool, async (client) => {
 *       // Inside this callback:
 *       //   - app.current_tenant   = request.context.tenantId
 *       //   - app.is_platform_admin = request.context.isPlatformAdmin
 *       //   - RLS is in force
 *       //   - one transaction, autocommit on success / rollback on throw
 *       return client.query(...);
 *     });
 *
 * Why a per-call helper, not a per-request transaction
 * ----------------------------------------------------
 * `runWithTenantContext` (`packages/db/src/middleware/tenant-context.ts`)
 * already owns the transaction lifecycle: BEGIN, set GUCs via
 * `set_config(..., is_local := true)`, run callback, COMMIT/ROLLBACK,
 * release client. The spec ([research.md:99], [data-model.md:30]) is
 * explicit that the GUCs are "set per transaction" — not per HTTP
 * request. Multiple narrowly-scoped transactions per request is the
 * intended shape; consumers opt in by calling this helper at every
 * DB boundary that needs RLS.
 *
 * Why this throws when ALS is empty
 * ---------------------------------
 * If `getResolvedContext()` returns `undefined`, it means either:
 *   1. `TenantContextGuard` didn't run (route not guarded), OR
 *   2. `ContextInterceptor` isn't registered, OR
 *   3. The caller is in background code outside any request scope.
 *
 * In all three cases, falling back to "no tenant context" would
 * silently disable RLS — a security hazard. We refuse to proceed
 * and surface the misconfiguration as a clear, loud error.
 * Background workers / one-off scripts that legitimately need to
 * run without an HTTP request should call `runWithTenantContext`
 * directly with an explicit `TenantContext`.
 */
import type { Pool, PoolClient } from "pg";
import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";
import { getResolvedContext } from "../context/context.als";
import type { ResolvedContext } from "../context/types";

/**
 * Map a `ResolvedContext` (the api-side request shape) onto a
 * `TenantContext` (the db-package shape that `runWithTenantContext`
 * accepts). Pure function; exported for the spec.
 *
 *   - `tenantId` is forwarded as-is. `null` is preserved for
 *     platform-admin callers operating without an active tenant —
 *     `runWithTenantContext` translates `null` to an empty-string
 *     GUC value, which the RLS policies short-circuit via the
 *     platform-admin OR-branch.
 *   - `isPlatformAdmin` is forwarded as-is.
 *   - `userId`, `storeId`, and `source` are deliberately discarded;
 *     they are not part of the GUC contract.
 */
export function tenantContextFromResolved(
  resolved: ResolvedContext,
): TenantContext {
  return {
    tenantId: resolved.tenantId,
    isPlatformAdmin: resolved.isPlatformAdmin,
  };
}

/**
 * Run `work(client)` inside a transaction whose GUCs are derived from
 * the current ALS-resolved context.
 *
 * Throws synchronously if no ALS context is present — the caller is
 * misconfigured (see file header). Does NOT swallow the error from
 * `work` or `runWithTenantContext`; both propagate.
 *
 * For tests and special-case background callers, an optional
 * `runner` parameter overrides the underlying `runWithTenantContext`
 * function; production callers omit it.
 */
export async function runRequestScopedTenantContext<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  runner: (
    pool: Pool,
    ctx: TenantContext,
    work: (client: PoolClient) => Promise<T>,
  ) => Promise<T> = runWithTenantContext,
): Promise<T> {
  const resolved = getResolvedContext();
  if (!resolved) {
    throw new Error(
      "runRequestScopedTenantContext: no ALS tenant context — " +
        "ContextInterceptor must run before this helper, and the " +
        "route must be guarded by TenantContextGuard.",
    );
  }
  return runner(pool, tenantContextFromResolved(resolved), work);
}
