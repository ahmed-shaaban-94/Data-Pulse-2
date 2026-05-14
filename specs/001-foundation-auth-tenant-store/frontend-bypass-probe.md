# Frontend-Bypass Manual Probe (SC-4)

**Feature**: 001-foundation-auth-tenant-store
**Spec reference**: `spec.md` §8 SC-4
**Automated counterpart**: `apps/api/test/authz/frontend-bypass.spec.ts` (T205)
**Status**: Manual probe procedure. Run against a local or staging deployment
to confirm the architectural guarantee end-to-end.

---

## What this probe proves

The dashboard frontend may pass role or privilege hints in request bodies,
headers, or query strings (e.g. `body.role`, `X-Role`, `?is_platform_admin=true`).
The backend must ignore all of them. Authorization state is derived exclusively
from three server-controlled sources:

- `request.principal` — set by `AuthGuard` from a verified session cookie or
  bearer token; never from a request header or query string.
- `request.context` — set by `TenantContextGuard` from a DB membership lookup
  against `request.principal`; never from a body field.
- `request.params` — path routing only (e.g. the `:id` segment for
  `PATCH /api/v1/tenants/:id`).

This probe sends attacker-controlled hints via curl, bypassing the dashboard
entirely, and confirms the backend status and body are identical whether those
hints are present or absent.

### Relationship to T205

`apps/api/test/authz/frontend-bypass.spec.ts` (T205) machine-checks the same
guarantee at the unit level using hand-rolled fakes for `RolesGuard`. It covers
`body.role`, `body.is_platform_admin`, `body.tenant_id`, `X-Role`,
`X-Is-Platform-Admin`, `X-Tenant-Id`, `?role`, and `?is_platform_admin`. This
probe document provides the operator-runnable, end-to-end counterpart that
crosses the real HTTP stack, the NestJS guard chain, and the `ZodValidationPipe`.

---

## Architecture note: guards run before body validation

In NestJS, guards execute before `@Body(new ZodValidationPipe(...))` pipes.
This means that for an endpoint guarded by `RolesGuard`, an insufficient-role
caller receives a 403 or 404 response without the body ever reaching Zod.
The injection vectors in Steps 2-4 below all hit the guard before body
validation; they produce the same status code as the baseline in Step 1.
This is the expected outcome — the injection has zero effect.

The one scenario where `.strict()` body rejection (400 `validation_error`)
fires for an authorized caller is shown in Step 2c: a caller who already has
`owner` or `tenant_admin` role submitting an unknown key like `tenant_id`.
That scenario is included for completeness, but it uses a separate
higher-privilege test account.

---

## Prerequisites

- A running Data-Pulse-2 API at `<API_URL>` (e.g. `https://api.example.com`
  or `http://localhost:3000`).
- A test account for a `store_staff` user who is a member of `<TENANT_ID>`
  but NOT a member of `<OTHER_TENANT_ID>`.
- (For Step 2c) A second test account for an `owner` or `tenant_admin` of
  `<TENANT_ID>` with an active-tenant token or session.

## Placeholders

| Placeholder | Replace with |
|---|---|
| `<API_URL>` | Base URL, no trailing slash (e.g. `http://localhost:3000`) |
| `<STAFF_COOKIE>` | Value of the `dp2_session` cookie for the `store_staff` user |
| `<ADMIN_COOKIE>` | Value of the `dp2_session` cookie for an `owner`/`tenant_admin` user |
| `<STAFF_EMAIL>` | Email address of the `store_staff` test account |
| `<STAFF_PASSWORD>` | Password of the `store_staff` test account |
| `<TENANT_ID>` | UUID of the tenant the staff user belongs to |
| `<OTHER_TENANT_ID>` | UUID of a different tenant the staff user does NOT belong to |
| `<STORE_ID>` | UUID of an existing store in `<TENANT_ID>` (for PATCH probe) |

All placeholders are fictional. Do NOT substitute real production credentials,
real tenant IDs, or real tokens.

---

## Step 0 — Obtain a low-privilege session

Sign in as the `store_staff` baseline user. Copy the `dp2_session` cookie from
the `Set-Cookie` response header and store it as `<STAFF_COOKIE>`.

```bash
# Expected: HTTP/1.1 200 OK
curl -v -X POST "<API_URL>/api/v1/auth/signin" \
  -H "Content-Type: application/json" \
  -d '{"email":"<STAFF_EMAIL>","password":"<STAFF_PASSWORD>"}' \
  -c cookies.txt
# dp2_session=<STAFF_COOKIE> is set in cookies.txt
```

---

## Step 1 — Confirm baseline: no decoration, operation denied

`POST /api/v1/stores` requires `owner` or `tenant_admin` role (denyAs: 403).
A `store_staff` user with no injected fields must receive 403 `forbidden`.

```bash
# Expected: HTTP/1.1 403 Forbidden
# Response body:
# { "error": { "code": "forbidden", "message": "Insufficient role.",
#              "request_id": "<UUID>" } }
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

This is the reference response. All Steps 2-4 must produce the same 403 result
when injected fields are present, proving those fields have zero effect.

---

## Step 2 — Body-field role-hint injection

### 2a — body.role = "owner"

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store","role":"owner"}'
```

### 2b — body.is_platform_admin = true

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store","is_platform_admin":true}'
```

### 2c — body.tenant_id pointing to a different tenant (authorized caller)

This step uses a higher-privilege account (`<ADMIN_COOKIE>`) to demonstrate
that `.strict()` body validation rejects `tenant_id` at the request layer,
independently of the role check. An `owner`-role caller submitting
`tenant_id` in the body receives 400 `validation_error` because
`StoreCreateSchema.strict()` does not list `tenant_id` as a permitted key.

```bash
# Expected: HTTP/1.1 400 Bad Request
# Response body:
# { "error": { "code": "validation_error",
#              "message": "Request validation failed",
#              "request_id": "<UUID>",
#              "details": [ ... Zod issue: unrecognized_keys ... ] } }
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<ADMIN_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store","tenant_id":"<OTHER_TENANT_ID>"}'
```

---

## Step 3 — Header role-hint injection

All three requests below use the `store_staff` session and target
`POST /api/v1/stores`. The expected outcome is 403 `forbidden` in every case,
identical to Step 1.

### 3a — X-Role: owner

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  -H "X-Role: owner" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

### 3b — X-Is-Platform-Admin: true

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  -H "X-Is-Platform-Admin: true" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

### 3c — X-Tenant-Id pointing to a different tenant

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores" \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: <OTHER_TENANT_ID>" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

---

## Step 4 — Query-string role-hint injection

### 4a — ?role=owner

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores?role=owner" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

### 4b — ?is_platform_admin=true

```bash
# Expected: HTTP/1.1 403 Forbidden (same as Step 1)
curl -v -X POST "<API_URL>/api/v1/stores?is_platform_admin=true" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"code":"probe-store","name":"Probe Store"}'
```

---

## Step 5 — Cross-tenant ID in path (path-as-context route)

`PATCH /api/v1/tenants/:id` uses `@RolesFromParam("id", "owner", "tenant_admin")`
with default `denyAs: 404`. The role lookup reads `request.params.id` (the path
UUID), not `request.context.tenantId`. A `store_staff` user submitting
`<OTHER_TENANT_ID>` in the path — regardless of any body injection — receives
404 `not_found` because the DB returns no membership for that user in that
tenant. Note that `TenantContextGuard` is NOT mounted on `TenantsController`;
this route is path-as-context only.

```bash
# Expected: HTTP/1.1 404 Not Found
# Response body:
# { "error": { "code": "not_found", "message": "Not Found",
#              "request_id": "<UUID>" } }
curl -v -X PATCH "<API_URL>/api/v1/tenants/<OTHER_TENANT_ID>" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"name":"Injected Tenant Name"}'
```

---

## Step 6 — Platform-admin-only endpoint without platform-admin flag

`POST /api/v1/tenants` is decorated with `@PlatformAdminOnly()`. Any session
whose membership does not carry `is_platform_admin = true` in the server-side
context receives 403 `forbidden`.

```bash
# Expected: HTTP/1.1 403 Forbidden
# Response body:
# { "error": { "code": "forbidden", "message": "Platform admin role required.",
#              "request_id": "<UUID>" } }
curl -v -X POST "<API_URL>/api/v1/tenants" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<STAFF_COOKIE>" \
  -d '{"name":"Injected Tenant","slug":"injected-tenant","is_platform_admin":true}'
```

The `is_platform_admin: true` field in the body has no effect. The guard reads
`request.context.isPlatformAdmin` (set by `TenantContextGuard`) and falls back
to a DB lookup via `MembershipRepository.isPlatformAdmin` — never the body.

---

## Expected outcomes summary

All injection vectors must produce a status code and error code that are
**identical to the baseline** (Step 1) for the same endpoint. The injection
changes nothing observable.

| Step | Endpoint | Injection vector | Expected status | Expected error.code |
|---|---|---|---|---|
| 1 | `POST /api/v1/stores` | None (baseline) | 403 | `forbidden` |
| 2a | `POST /api/v1/stores` | `body.role="owner"` | 403 | `forbidden` |
| 2b | `POST /api/v1/stores` | `body.is_platform_admin=true` | 403 | `forbidden` |
| 2c | `POST /api/v1/stores` | `body.tenant_id=<OTHER>` (owner caller) | 400 | `validation_error` |
| 3a | `POST /api/v1/stores` | `X-Role: owner` | 403 | `forbidden` |
| 3b | `POST /api/v1/stores` | `X-Is-Platform-Admin: true` | 403 | `forbidden` |
| 3c | `POST /api/v1/stores` | `X-Tenant-Id: <OTHER>` | 403 | `forbidden` |
| 4a | `POST /api/v1/stores` | `?role=owner` | 403 | `forbidden` |
| 4b | `POST /api/v1/stores` | `?is_platform_admin=true` | 403 | `forbidden` |
| 5 | `PATCH /api/v1/tenants/<OTHER>` | Path carries other-tenant UUID | 404 | `not_found` |
| 6 | `POST /api/v1/tenants` | `body.is_platform_admin=true` | 403 | `forbidden` |

---

## What "PASS" looks like

- Every request returns the expected HTTP status code listed above.
- Every response body matches the canonical error envelope:
  ```json
  {
    "error": {
      "code": "<error-code>",
      "message": "<human-readable message>",
      "request_id": "<UUIDv4 or UUIDv7>"
    }
  }
  ```
- No request returns 2xx.
- Steps 1-4b produce the same status and error code as Step 1. The injection
  is provably a no-op.

---

## Audit trail verification (optional post-probe)

After completing Steps 0-6, query the audit log for the `store_staff` user's
tenant (the staff user must first switch active-tenant context if their session
is not already scoped to `<TENANT_ID>`):

```bash
# Expected: HTTP/1.1 200 OK — list of audit events; no successful-elevation entries.
curl -v -X GET "<API_URL>/api/v1/audit/events" \
  -H "Content-Type: application/json" \
  --cookie "dp2_session=<ADMIN_COOKIE>"
```

Confirm:
- Sign-in events appear (actor = staff user).
- No audit row shows a successful store creation or tenant creation by the
  staff user — the probe attempts were all rejected before reaching business
  logic.
- No `audit_events` row indicates a successful elevation.

Note: per design, failed authorization attempts are not individually audited
(too noisy); only successful, auditable operations emit audit events.

---

## References

| Item | Location |
|---|---|
| Automated unit probe (T205) | `apps/api/test/authz/frontend-bypass.spec.ts` |
| Default-deny probe (T206) | `apps/api/test/authz/default-deny.spec.ts` |
| RolesGuard implementation | `apps/api/src/auth/roles.guard.ts` |
| TenantContextGuard implementation | `apps/api/src/context/tenant-context.guard.ts` |
| Error envelope definition | `packages/shared/src/errors/envelope.ts` |
| Error codes (`forbidden`, `not_found`, etc.) | `packages/shared/src/errors/envelope.ts` (`ErrorCodes`) |
| StoreCreateSchema (`.strict()`) | `apps/api/src/stores/dto.ts` |
| GlobalExceptionFilter | `apps/api/src/common/exception.filter.ts` |
| Spec SC-4 | `specs/001-foundation-auth-tenant-store/spec.md` §8 SC-4 |
| SC verification record | `specs/001-foundation-auth-tenant-store/sc-verification.md` §SC-4 |
