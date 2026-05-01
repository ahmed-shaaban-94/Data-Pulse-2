# API Contracts — Foundation

OpenAPI 3.1 schemas for the foundation feature. These describe the shape of
endpoints exposed by the SaaS backend; they are **not** server stubs.
Implementation belongs to `/speckit-tasks`.

## Versioning

- **Dashboard / SaaS-internal API**: `/api/v1/...` — defined here.
- **POS-facing API**: `/api/pos/v1/...` — **namespace reserved**, no schemas
  here. POS endpoints are out of scope for this feature; they are designed
  in a future spec that consumes the foundation seams.

Breaking changes ship as a new version (`v2`); the previous version is
maintained for the documented deprecation window (Constitution IV).

## Files

| File | Endpoints | Notes |
|---|---|---|
| `auth.openapi.yaml` | sign-in, sign-out, refresh, password reset, email verification | Cookie-based session for dashboard humans. |
| `context.openapi.yaml` | list memberships, switch tenant, switch store | The "active context" surface. |
| `tenants.openapi.yaml` | tenant read/admin, member listing, audit query (read) | Platform-admin scope for create/delete; tenant-admin for member ops. |
| `stores.openapi.yaml` | store CRUD within active tenant | Active-tenant required. |
| `memberships.openapi.yaml` | invite, accept-invite, role change, store-access change | Tenant-admin scope. |
| `audit.openapi.yaml` | query audit events for active tenant | Tenant-admin read-only. |

## Cross-cutting

- **Authentication**: dashboard endpoints use a session cookie (HttpOnly,
  Secure, SameSite=Lax). API tokens (opaque bearer) are accepted on
  `/api/v1/...` for non-cookie clients but are not the primary path.
- **Tenant context**: server-resolved from session/token; never from a body
  parameter alone. Endpoints that require an active tenant return `401` if
  none is set.
- **Errors**: a uniform `{ error: { code, message, request_id } }` envelope.
  Cross-tenant or unauthorized resource access returns `404` (per
  FR-ISO-4 — same as not-found, no leak).
- **Idempotency**: write endpoints accept `Idempotency-Key` header. The
  foundation defines the storage shape (see `data-model.md` §13); v1
  endpoints don't yet require it, but the platform supports it from day
  one.

## What is NOT here

- POS endpoints.
- Product catalog, inventory, orders, billing, reports endpoints.
- Frontend assumptions about how the dashboard *renders* these contracts.

## Constitution alignment

These contracts satisfy Constitution IV (Contract-First POS Integration —
the *contract-first* discipline applies to all APIs, not just POS) and
support Constitution III (Backend Authority) by making authorization an
explicit responsibility of every endpoint.
