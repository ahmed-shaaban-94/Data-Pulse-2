# @data-pulse-2/contracts

OpenAPI 3.1 contracts that the API and (future) clients conform to.
Per Constitution IV, **the YAMLs are the source of truth**; code conforms.

## Planned contents (not yet implemented)

- `openapi/` directory — copies of the spec's contract YAMLs, kept in sync with
  [`specs/001-foundation-auth-tenant-store/contracts/`](../../specs/001-foundation-auth-tenant-store/contracts/):
  - `auth.openapi.yaml`
  - `context.openapi.yaml`
  - `tenants.openapi.yaml`
  - `stores.openapi.yaml`
  - `memberships.openapi.yaml`
  - `audit.openapi.yaml`
- A small loader that reads the YAMLs at runtime so `apps/api` can serve
  `/openapi.json` and so contract-conformance tests can validate runtime
  responses against the schema.
- Generated TypeScript types (downstream task — generation method per
  plan PQ-7 default A: hand-written YAMLs are the source of truth, types
  derived from them).

## Status

Skeleton only. No `openapi/` folder yet. No loader yet. No dependencies.
Implementation lands in a later branch covering task T023's deferred parts.

## POS namespace

`/api/pos/v1/` is reserved (no schemas yet). POS endpoints are out of scope of
the foundation feature — see
[plan §11](../../specs/001-foundation-auth-tenant-store/plan.md).
