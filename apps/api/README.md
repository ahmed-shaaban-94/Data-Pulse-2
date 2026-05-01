# @data-pulse-2/api

NestJS backend API for Data-Pulse-2.

## Planned contents (not yet implemented)

Per [plan §3](../../specs/001-foundation-auth-tenant-store/plan.md) and
[tasks T080–T235](../../specs/001-foundation-auth-tenant-store/tasks.md):

- Nest bootstrap (`src/main.ts`, `src/app.module.ts`, `nest-cli.json`).
- Cross-cutting interceptors: `RequestIdInterceptor`, `LoggingInterceptor`,
  `AuditEmitter`.
- Global `ZodValidationPipe` and uniform `ExceptionFilter` (error envelope).
- Modules: `AuthModule`, `ContextModule`, `TenantsModule`, `StoresModule`,
  `MembershipsModule`, `InvitationsModule`, `AuditModule`.
- Guards: `AuthGuard`, `TenantContextGuard` (with `AsyncLocalStorage`),
  `RolesGuard`.
- DB session middleware (sets `app.current_tenant` / `app.is_platform_admin`
  per request).
- Repositories that use `@data-pulse-2/db`'s `withTenant` helper exclusively
  for tenant-scoped reads/writes.

## Status

Skeleton only. No `src/`, no `nest-cli.json`, no dependencies. Implementation
lands in subsequent branches following the task order in `tasks.md`.

## Boundaries

- This app **depends on** `@data-pulse-2/{shared,db,auth,contracts}`.
- This app **does not** import from `apps/worker` and vice versa.
- The dashboard UI is **not in this app** — it is a separate, deferred feature.
