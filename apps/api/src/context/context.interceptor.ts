/**
 * ContextInterceptor — slice 10 (T155, ALS bridge half).
 *
 * Wraps the downstream handler in an `AsyncLocalStorage` scope keyed
 * to `request.context` (set by `TenantContextGuard`, PR #19). Once
 * inside the scope, any code path — repositories, helpers, log
 * enrichers — can read the active tenant / store / user without
 * threading `request` through every parameter list:
 *
 *     getResolvedContext()  // returns the request's ResolvedContext
 *
 * No-op when `request.context` is absent
 * --------------------------------------
 * Interceptors run on every request once registered globally; not
 * every endpoint opts into `TenantContextGuard`. When the guard
 * didn't run (e.g., the AuthController's sign-in route which is
 * deliberately unauthenticated), `request.context` is undefined and
 * we just pass `next.handle()` through unchanged. Downstream code
 * sees `getResolvedContext() === undefined`, which is the documented
 * "outside any scope" contract from `context.als.ts`.
 *
 * Why `defer + from + firstValueFrom`
 * -----------------------------------
 * Nest interceptors return Observables. `runInContext` runs `fn`
 * synchronously (or as a Promise) in an ALS scope; we need that
 * scope to last until the entire downstream Observable settles.
 * The dance:
 *
 *   1. `defer(...)` enters the ALS lazily on subscription, not at
 *      interceptor-construction time.
 *   2. `firstValueFrom(next.handle())` collapses the downstream
 *      Observable to a Promise.
 *   3. `runInContext(ctx, () => <that promise>)` wraps the promise's
 *      lifecycle in the ALS scope. Node's async-hooks tracks the
 *      awaited promise chain — every `await` inside the handler
 *      stays in the scope.
 *   4. `from(...)` re-wraps the resolved-context promise back into
 *      an Observable so RxJS error/value semantics survive.
 *
 * Errors propagate
 * ----------------
 * Synchronous and asynchronous errors from `next.handle()` flow
 * back as Observable error notifications. The ALS scope tears
 * down whether the inner promise resolves or rejects (Node's ALS
 * guarantee).
 *
 * Background work caveat
 * ----------------------
 * If a handler kicks off background work that runs AFTER the response
 * has been sent (e.g., `setImmediate(() => doWork())`), the ALS scope
 * may have torn down by then. Background work MUST NOT rely on
 * `getResolvedContext()` — capture the values explicitly before
 * returning.
 *
 * Lifecycle pairing
 * -----------------
 * `TenantContextGuard` (PR #19) populates `request.context` during
 * its `canActivate` phase, which runs BEFORE interceptors. By the
 * time this interceptor's `intercept` is invoked, `request.context`
 * is either populated (guard ran successfully) or absent (no guard
 * on the route). Either way, we behave correctly.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { defer, from, type Observable } from "rxjs";
import { firstValueFrom } from "rxjs";
import { runInContext } from "./context.als";
import type { TenantContextRequest } from "./types";

@Injectable()
export class ContextInterceptor implements NestInterceptor {
  intercept(
    execCtx: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const request = execCtx.switchToHttp().getRequest<TenantContextRequest>();
    const ctx = request.context;
    if (!ctx) {
      // No guard on this route — pass through. Downstream code that
      // calls `getResolvedContext()` will see `undefined`, which is
      // the documented "outside any scope" return value.
      return next.handle();
    }

    return defer(() =>
      from(
        Promise.resolve(
          runInContext(ctx, () => firstValueFrom(next.handle())),
        ),
      ),
    );
  }
}
