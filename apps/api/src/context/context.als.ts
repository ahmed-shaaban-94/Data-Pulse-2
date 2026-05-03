/**
 * AsyncLocalStorage primitive for the resolved request context — slice 9 (T151).
 *
 * Lets deep code paths (repositories, helpers, log enrichers) read the
 * active tenant / store / user without having a Nest `Request` threaded
 * through every parameter list. The store is populated by an
 * interceptor / middleware (lands with T155) that wraps
 * `next.handle()` in `runInContext(request.context, ...)` once
 * `TenantContextGuard` has resolved the context.
 *
 * This file is the primitive only:
 *   - `runInContext(ctx, fn)` enters a new ALS scope
 *   - `getResolvedContext()` reads the current scope (or `undefined`)
 *
 * The guard does NOT call `runInContext` itself in this slice — guards
 * return synchronously and Nest's lifecycle moves on outside the
 * guard's call stack. Auto-population of the ALS belongs to T155.
 *
 * Propagation properties (proven in `context.als.spec.ts`):
 *   - The store is preserved across `await` boundaries (Node's
 *     `AsyncLocalStorage` tracks async resources).
 *   - Concurrent invocations are isolated — two `runInContext` calls
 *     with different ctx objects never see each other's value.
 *   - Reads outside any `run` scope return `undefined`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedContext } from "./types";

const contextStore = new AsyncLocalStorage<ResolvedContext>();

/**
 * Run `fn` inside an ALS scope keyed to `ctx`. Any code path that
 * `await`s something inside `fn` continues to see `ctx` via
 * `getResolvedContext()` until the awaited promise resolves.
 *
 * Returns whatever `fn` returns (sync or async). Errors propagate.
 */
export function runInContext<T>(
  ctx: ResolvedContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return contextStore.run(ctx, fn);
}

/**
 * Read the current ALS scope. Returns `undefined` outside any
 * `runInContext` call — callers MUST handle the absent case (e.g.,
 * background jobs, app-bootstrap code, tests that don't enter a
 * scope).
 */
export function getResolvedContext(): ResolvedContext | undefined {
  return contextStore.getStore();
}
