# @data-pulse-2/shared

Shared cross-cutting utilities used by both `apps/api` and `apps/worker`.

## Planned contents (not yet implemented)

Per [the foundation plan](../../specs/001-foundation-auth-tenant-store/plan.md)
and [tasks](../../specs/001-foundation-auth-tenant-store/tasks.md):

- **Zod base schemas** — UUID, Email, Slug primitives reused at every API boundary.
- **Error envelope** — uniform `{ error: { code, message, request_id } }` shape and helpers.
- **Logger** — pino factory configured with `tenant_id` / `request_id` context and a redact list (no secrets/PII per Constitution VII).
- **OpenTelemetry setup** — SDK initialization with HTTP, Postgres, Redis, BullMQ instrumentations.
- **ID generation** — UUIDv7 generator behind a thin adapter (UUIDv4 fallback per research T-5).
- **Idempotency-key store** (later) — Redis-primary + Postgres-mirror helper for FR-POS-SEAM-3.

## Status

Skeleton only. No source files. No dependencies. Implementation lands in a
later branch covering tasks T030–T035 and T040–T045.

## Boundary

This package does **not** import from `apps/*`. Apps depend on packages, not the other way around.
