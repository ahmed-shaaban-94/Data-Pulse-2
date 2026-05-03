# @data-pulse-2/shared

Shared backend utilities used by `apps/api`, `apps/worker`, and internal
packages.

## Exports

- `./zod/base` - common Zod primitives.
- `./errors/envelope` - uniform error envelope helpers.
- `./logger/pino` - pino logger factory.
- `./observability/otel` - OpenTelemetry setup helpers.
- `./ids/uuid` - UUID generation adapter.
- `./queues/queue-config` - BullMQ queue and worker defaults.
- `.` - package barrel export.

## Commands

```bash
pnpm --filter @data-pulse-2/shared build
pnpm --filter @data-pulse-2/shared test
```

## Boundaries

- Backend-only package; it should not depend on DOM or frontend-only APIs.
- Does not import from `apps/*`.
- Keep secret redaction, error shape, telemetry, and queue defaults centralized
  here so apps do not drift.
