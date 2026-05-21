/**
 * Unit test for `routeTemplate(ctx: ExecutionContext)` — the shared
 * helper that derives a low-cardinality route template from NestJS
 * decorator metadata.
 *
 * Why this helper is shared
 * -------------------------
 * Metric labels MUST be route TEMPLATES (e.g. `/api/v1/tenants/:id`),
 * never rendered URLs (`/api/v1/tenants/0190f1cf-…`). Rendered paths
 * carry tenant/store/user IDs which are forbidden as metric labels
 * (FR-B-006, signals.md §6). `LoggingInterceptor` and
 * `GlobalExceptionFilter` need the same template, so the helper is
 * extracted to a shared module rather than duplicated.
 *
 * Two file-local copies survive (in `tenant-context.guard.ts` and
 * `idempotency.interceptor.ts`); consolidating those is a separate
 * follow-up slice and is intentionally out of scope here.
 *
 * Constitution §VII / FR-B-006.
 */
import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";

import { routeTemplate } from "../../src/common/route-template";

/**
 * Build a minimal ExecutionContext-shaped fake whose `getClass` and
 * `getHandler` return decorated artifacts. Only the two metadata-bearing
 * methods are exercised by `routeTemplate`; everything else is left
 * undefined to keep the fake honest.
 */
function makeCtx(
  klass: { new (): unknown } | undefined,
  handler: ((...args: unknown[]) => unknown) | undefined,
): ExecutionContext {
  return {
    getClass: () => klass,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe("routeTemplate", () => {
  it("returns the joined controller + handler template", () => {
    class FakeController {}
    Reflect.defineMetadata("path", "api/v1/tenants", FakeController);
    const handler = function findOne(): void {};
    Reflect.defineMetadata("path", ":id", handler);

    expect(routeTemplate(makeCtx(FakeController, handler))).toBe(
      "/api/v1/tenants/:id",
    );
  });

  it("collapses double slashes when either segment is empty", () => {
    class FakeController {}
    Reflect.defineMetadata("path", "/api/v1/health", FakeController);
    const handler = function ping(): void {};
    Reflect.defineMetadata("path", "", handler);

    expect(routeTemplate(makeCtx(FakeController, handler))).toBe(
      "/api/v1/health",
    );
  });

  it("strips trailing slash so `/x/` becomes `/x`", () => {
    class FakeController {}
    Reflect.defineMetadata("path", "x", FakeController);
    const handler = function withTrailing(): void {};
    Reflect.defineMetadata("path", "/", handler);

    expect(routeTemplate(makeCtx(FakeController, handler))).toBe("/x");
  });

  it("falls back to 'unknown' when metadata is absent on both class and handler", () => {
    class Plain {}
    const plainHandler = function plain(): void {};
    expect(routeTemplate(makeCtx(Plain, plainHandler))).toBe("unknown");
  });

  it("falls back to 'unknown' when getClass / getHandler throw or return nothing", () => {
    const badCtx = {
      getClass: () => {
        throw new Error("no class");
      },
      getHandler: () => undefined,
    } as unknown as ExecutionContext;
    expect(routeTemplate(badCtx)).toBe("unknown");
  });

  it("never returns a value containing a rendered UUID or rendered path segment", () => {
    // A correct implementation reads decorator metadata only; it never
    // consults `req.url` / `req.originalUrl`. So even if a rendered URL
    // is "in the environment", it cannot leak into the return value.
    class FakeController {}
    Reflect.defineMetadata("path", "api/v1/tenants", FakeController);
    const handler = function findOne(): void {};
    Reflect.defineMetadata("path", ":id", handler);

    const template = routeTemplate(makeCtx(FakeController, handler));
    expect(template).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(template).toContain(":id");
  });

  // ---------------------------------------------------------------------
  // PR-E — request.route fallback for the exception-filter boundary
  // ---------------------------------------------------------------------
  // At the GlobalExceptionFilter boundary, Nest's `ArgumentsHost` typically
  // returns `undefined` from `getClass`/`getHandler` (the handler that
  // threw has already unwound). The Express router, however, has
  // populated `request.route.path` with the matched template before the
  // throw — so feeding the request as a second argument lets the helper
  // recover the route for matched-route error samples while leaving
  // genuine unmatched 404s reporting "unknown".

  describe("request.route fallback (PR-E)", () => {
    it("uses request.route.path when Nest metadata is absent", () => {
      class Plain {}
      const plainHandler = function plain(): void {};
      const ctx = makeCtx(Plain, plainHandler); // no Reflect metadata

      expect(
        routeTemplate(ctx, { route: { path: "/api/v1/auth/signin" } }),
      ).toBe("/api/v1/auth/signin");
    });

    it("prefers Nest metadata over request.route.path when both are present", () => {
      class FakeController {}
      Reflect.defineMetadata("path", "api/v1/tenants", FakeController);
      const handler = function findOne(): void {};
      Reflect.defineMetadata("path", ":id", handler);

      // Metadata says /:id; request.route is a stale rendered path.
      // The helper must prefer the bounded template.
      expect(
        routeTemplate(makeCtx(FakeController, handler), {
          route: { path: "/api/v1/tenants/0190f1cf-aaaa-bbbb-cccc-000000000000" },
        }),
      ).toBe("/api/v1/tenants/:id");
    });

    it("falls back to 'unknown' when neither metadata nor request.route is present (genuine unmatched 404)", () => {
      class Plain {}
      const plainHandler = function plain(): void {};
      expect(routeTemplate(makeCtx(Plain, plainHandler), undefined)).toBe(
        "unknown",
      );
      expect(routeTemplate(makeCtx(Plain, plainHandler), {})).toBe("unknown");
      expect(
        routeTemplate(makeCtx(Plain, plainHandler), { route: undefined }),
      ).toBe("unknown");
      expect(
        routeTemplate(makeCtx(Plain, plainHandler), { route: { path: "" } }),
      ).toBe("unknown");
    });

    it("uses request.route.path even when getClass throws", () => {
      const badCtx = {
        getClass: () => {
          throw new Error("no class");
        },
        getHandler: () => undefined,
      } as unknown as ExecutionContext;

      expect(
        routeTemplate(badCtx, { route: { path: "/api/v1/auth/signin" } }),
      ).toBe("/api/v1/auth/signin");
    });

    it("returns a low-cardinality route template (no rendered IDs) from request.route", () => {
      // Express's `request.route.path` is the route template that Express
      // matched against — it carries `:id`-style params, not rendered
      // UUIDs. Sanity-check: the fallback must not regress label safety.
      class Plain {}
      const plainHandler = function plain(): void {};
      const result = routeTemplate(makeCtx(Plain, plainHandler), {
        route: { path: "/api/v1/tenants/:id/members/:member_id" },
      });
      expect(result).toBe("/api/v1/tenants/:id/members/:member_id");
      expect(result).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
    });
  });
});
