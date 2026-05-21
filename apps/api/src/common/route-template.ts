/**
 * Shared helper that derives a low-cardinality route TEMPLATE from a
 * NestJS `ExecutionContext` (or anything structurally equivalent).
 *
 * Why route templates and not rendered URLs
 * -----------------------------------------
 * Metric labels MUST be bounded. Rendered paths like
 * `/api/v1/tenants/0190f1cf-…` carry tenant / store / user IDs in the
 * URL — those values are forbidden as metric labels (FR-B-006,
 * signals.md §6). The template `/api/v1/tenants/:id` is safe; the
 * rendered value `/api/v1/tenants/<uuid>` is not.
 *
 * Resolution order (PR-E):
 *   1. Nest Reflect metadata (`@Controller(...)` + `@Get/@Post/...`)
 *      on `ExecutionContext.getClass()` / `getHandler()`. This works in
 *      guards, interceptors, and inside controller execution.
 *   2. Express's matched-route record `request.route.path` when Nest
 *      metadata is unavailable. The global exception filter receives
 *      `ArgumentsHost` whose `getClass`/`getHandler` return `undefined`
 *      after the controller-bound handler has already thrown — but the
 *      Express router has already attached the matched template to
 *      `request.route.path` (this is the same fallback
 *      `idempotency.interceptor.ts` uses at line 77 / 192).
 *   3. `"unknown"` — bounded label value, used for genuine unmatched
 *      404s (Express never bound a route) and unit-test stubs.
 *
 * Two file-local copies of this function still exist (in
 * `tenant-context.guard.ts` and `idempotency.interceptor.ts`); this
 * shared module is the canonical implementation going forward.
 * Re-pointing the existing copies is a separate follow-up slice.
 *
 * Constitution §VII / FR-B-006.
 */
import type { ExecutionContext } from "@nestjs/common";

/**
 * Minimal structural shape we need from Express's request to read the
 * matched-route template. Defined locally (not imported from `express`)
 * to keep this helper a single dep-free module.
 */
export interface RequestWithRoute {
  route?: { path?: string } | undefined;
}

export function routeTemplate(
  execCtx: ExecutionContext,
  request?: RequestWithRoute,
): string {
  try {
    // `reflect-metadata` is loaded by NestJS at bootstrap; Reflect.getMetadata
    // is available in every guard/interceptor/filter call site.
    const klass = execCtx.getClass();
    const handler = execCtx.getHandler();
    if (klass && handler) {
      const controllerPath =
        (Reflect.getMetadata("path", klass) as string | undefined) ?? "";
      const handlerPath =
        (Reflect.getMetadata("path", handler) as string | undefined) ?? "";
      const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, "/");
      // Trim trailing slash so "/api/v1/tenants/" becomes "/api/v1/tenants".
      const fromMetadata = joined.replace(/\/$/, "");
      if (fromMetadata) return fromMetadata;
    }
  } catch {
    // fall through to request.route fallback
  }
  // Express-bound matched-route template — present in the exception
  // filter for any error thrown from a matched handler. Genuine 404s
  // that never matched a route legitimately return "unknown".
  const fromRequest = request?.route?.path;
  if (typeof fromRequest === "string" && fromRequest.length > 0) {
    return fromRequest;
  }
  return "unknown";
}
