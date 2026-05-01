# @data-pulse-2/db

PostgreSQL schema, migrations, and tenant-scoped query helpers for the
Data-Pulse-2 backend. Postgres is the system of record (Constitution III).

## Planned contents (not yet implemented)

Per [data-model.md](../../specs/001-foundation-auth-tenant-store/data-model.md)
and [tasks T050–T073](../../specs/001-foundation-auth-tenant-store/tasks.md):

- **Drizzle schema files** under `src/schema/` — `users`, `tenants`, `stores`,
  `memberships`, `store_access`, `roles`, `permissions`, `role_permissions`,
  `sessions`, `auth_tokens`, `invitations`, `audit_events`, `idempotency_keys`.
- **Explicit SQL migrations** under `drizzle/` — `0000_initial.sql` (+ `.down.sql`)
  creating all tables, FKs, partial uniques, CHECK constraints, RLS policies,
  and `updated_at` triggers per `data-model.md`. Tool-agnostic.
- **`withTenant(tx, tenantId)` helper** — query proxy that injects
  `WHERE tenant_id = :tenantId` automatically for tenant-scoped queries.
- **DB session middleware** — issues `SET LOCAL app.current_tenant` and
  `SET LOCAL app.is_platform_admin` per transaction so RLS policies apply.
- **Migration runner CLI** — `pnpm migrate` walks the `drizzle/` folder.

## Status

Skeleton only. The `migrate` script is currently a no-op so the root
`pnpm -r --if-present run migrate` command exits cleanly. No `src/`,
no `drizzle/`, no dependencies yet. Implementation lands in a later branch.

## Constitution alignment

When implemented, this package enforces Constitution Principle II
(multi-tenant scoping at the DB layer) and Principle III (data integrity via
foreign keys, CHECK constraints, partial unique indexes, and RLS policies).
