# Implementation Plan — 027 POS Terminal-Pairing CONSUME

## Approach
Mirror the connector-registration vertical (migration + controller + service +
RLS-GUC `runWithTenantContext` + closed Error envelope), but the consume is
**anonymous** and **bootstraps tenant context from the code row** (no caller
tenant exists yet).

## Auth / anonymous design (FR-002)
DP-2 applies guards **per-controller** via `@UseGuards`; `grep` confirms there is
NO global `APP_GUARD`/`useGlobalGuards`. Therefore an anonymous route is achieved
by registering the controller with **NO guard at all** — no other guard is touched
or weakened. The global `GlobalExceptionFilter` still wraps responses; the global
audit interceptor only fires on `@Auditable` routes (this route is NOT auditable —
the success carries a SECRET, so it emits no audit payload).

## Tenant-context bootstrap (the key wrinkle)
At consume time the request has no tenant. The code lookup is therefore a
**hash → row** probe on the bare admin pool (the exact pattern
`DeviceRepository.findActiveByAttestation` uses), which resolves the code's
`tenant_id`. The burn + `devices` insert + terminal write then run inside
`runWithTenantContext(pool, { tenantId, isPlatformAdmin: false }, …)` so RLS scopes
every write to the code's tenant. `code_hash` is UNIQUE so the lookup is a single
index probe; cross-tenant codes are indistinguishable (non-disclosing 404).

## Error mapping (via GlobalExceptionFilter — throw HttpException with `{code}`)
| Condition | Throw | Status | `error.code` |
|---|---|---|---|
| body invalid | ZodValidationPipe / BadRequest `{code:'validation_failure'}` | 400 | `validation_failure` |
| code hash not found | NotFound `{code:'INVALID_CODE'}` | 404 | `INVALID_CODE` |
| status used/cancelled OR expired | Gone(410) `{code:'EXPIRED_CODE'}` | 410 | `EXPIRED_CODE` |
| terminal already paired, same branch | Conflict `{code:'ALREADY_PAIRED'}` | 409 | `ALREADY_PAIRED` |
| paired under different branch | Conflict `{code:'BRANCH_MISMATCH'}` | 409 | `BRANCH_MISMATCH` |
| attempt threshold exceeded | set `Retry-After` header + 429 `{code:'RATE_LIMITED'}` | 429 | `RATE_LIMITED` |

NestJS has no built-in `GoneException`; throw `new HttpException({code,message}, 410)`.

## Files
- `packages/db/drizzle/0024_pairing_codes.sql` (+ `.down.sql`) — NEW table.
- `packages/db/src/schema/pairing-codes.ts` — drizzle schema row type (mirrors the
  `devices`/`connector_registration` schema-file pattern), exported via the schema
  barrel IF one is needed by tests; the controller/service use raw SQL like the
  connector service, so the schema file is optional — added only if referenced.
- `apps/api/src/pos-terminal-pairing/pairing.module.ts`
- `apps/api/src/pos-terminal-pairing/pairing.controller.ts`
- `apps/api/src/pos-terminal-pairing/pairing.service.ts`
- `apps/api/src/pos-terminal-pairing/pairing.repository.ts`
- `apps/api/src/pos-terminal-pairing/dto/terminal-pair.dto.ts` (Zod request +
  `toBody` response projection)
- Register `PairingModule` in `apps/api/src/app.module.ts`.
- Tests: contract spec already exists (structural — must keep green); add unit
  (error mapping, redaction) + db-integration (migration + RLS + happy/edge +
  device_token authenticates via PosDeviceAuthGuard) + migration spec.

## Secret discipline (FR-006)
- `pairing_code` validated then immediately hashed; never logged.
- `device_token` returned in the body once; never logged, never in any audit, no
  `@Auditable` on the route. Unit test asserts the service/controller never pass
  the raw token or code to a logger.

## Rate limit
Per-code `attempt_count` with a back-off window; threshold + window are module
constants (no hardcoded magic in the SQL). `Retry-After` clamped to [1,300] to
match the contract header bound.
