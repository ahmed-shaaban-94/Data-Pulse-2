# @data-pulse-2/worker

Background-job runner for Data-Pulse-2. NestJS standalone process consuming
BullMQ queues backed by Redis.

## Planned contents (not yet implemented)

Per [plan §3 / §6 / Constitution V](../../specs/001-foundation-auth-tenant-store/plan.md)
and [tasks T090–T115, T232–T233, T302, T311–T312](../../specs/001-foundation-auth-tenant-store/tasks.md):

- Nest standalone bootstrap (`src/main.ts`, `src/worker.module.ts`).
- BullMQ default queue config (retry/backoff/DLQ).
- Processors:
  - **EmailProcessor** — verification + password-reset + invite emails.
    Provider-agnostic adapter (PQ-1 deferred).
  - **AuditFanoutProcessor** — bulk-inserts `audit_events` rows from queued payloads.
  - **SessionRevokeProcessor** — propagates admin-initiated session revocations
    (FR-AUTH-6 ≤5 min bound).
  - **SoftDeleteSweepProcessor** — scheduled cleanup of past-retention soft deletes.
  - **AuditRetentionProcessor** — scheduled audit-row retention enforcement.
- OpenTelemetry context propagation from API into job payloads.

## Status

Skeleton only. No `src/`, no dependencies. Implementation lands in subsequent
branches following the task order in `tasks.md`.

## What this package is not

Not a webhook delivery target for external POS devices — POS endpoints live
in (future) `apps/api` and the POS app is a separate repository entirely.
This worker app is purely server-side asynchronous processing for the SaaS
backend.
