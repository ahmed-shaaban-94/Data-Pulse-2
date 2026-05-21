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
 * How the template is recovered
 * -----------------------------
 * NestJS attaches the path segment declared by `@Controller(...)` /
 * `@Get(...)` / `@Post(...)` as Reflect metadata under the key `"path"`
 * on the controller class and on the handler function. Joining the two
 * and normalising slashes reconstructs the template that Nest uses
 * internally for route matching — without touching the rendered URL.
 *
 * Returns `"unknown"` when metadata is absent (unit tests with stub
 * controllers, 404s that never reach a controller, etc.). `"unknown"`
 * is a bounded label value — safe for metric cardinality.
 *
 * Two file-local copies of this function still exist (in
 * `tenant-context.guard.ts` and `idempotency.interceptor.ts`); this
 * shared module is the canonical implementation going forward.
 * Re-pointing the existing copies is a separate follow-up slice.
 *
 * Constitution §VII / FR-B-006.
 */
import type { ExecutionContext } from "@nestjs/common";

export function routeTemplate(execCtx: ExecutionContext): string {
  try {
    // `reflect-metadata` is loaded by NestJS at bootstrap; Reflect.getMetadata
    // is available in every guard/interceptor/filter call site.
    const klass = execCtx.getClass();
    const handler = execCtx.getHandler();
    if (!klass || !handler) return "unknown";
    const controllerPath =
      (Reflect.getMetadata("path", klass) as string | undefined) ?? "";
    const handlerPath =
      (Reflect.getMetadata("path", handler) as string | undefined) ?? "";
    const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, "/");
    // Trim trailing slash so "/api/v1/tenants/" becomes "/api/v1/tenants".
    return joined.replace(/\/$/, "") || "unknown";
  } catch {
    return "unknown";
  }
}
