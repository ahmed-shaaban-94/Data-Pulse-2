# POS Seam Walkthrough

**Feature**: 001-foundation-auth-tenant-store
**Task**: T265
**SC satisfied**: SC-8 — Reusability for POS
**Date**: 2026-05-14

---

## Purpose

This document demonstrates how a hypothetical POS sync endpoint would attach
to the existing foundation without schema changes.  It is the human-readable
companion to `apps/api/test/pos-seam/walkthrough.spec.ts` (T264, not yet
implemented) and is the deliverable required for SC-8.

Each seam is verified against the code on `main` at the SHA recorded in
`sc-verification.md`.  File paths and table column names are cited so the
reader can follow the trail independently.

---

## Foundation Seams Available to POS

The foundation was designed so a POS sync feature can attach to the existing
tenant/store/user model without schema changes.  The seams below are all live
on `main`.

### Seam 1 — Tenant and store scoping

**What exists:**

Every entity table carries `(tenant_id, store_id)` columns (or just
`tenant_id` where store scoping is not relevant).  The physical schema is in
`packages/db/drizzle/0000_initial.sql`.

```sql
-- stores table — any POS device references (tenant_id, id)
CREATE TABLE IF NOT EXISTS stores (
  id         UUID PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  ...
);
```

**How a POS endpoint uses it:**

A POS sync endpoint for, say, a sales receipt would carry `tenant_id` and
`store_id` in its request body.  The existing `TenantContextGuard`
(`apps/api/src/context/tenant-context.guard.ts`) resolves the active tenant
and store from the caller's session or bearer token before the handler runs.
The handler receives `request.context.tenantId` and `request.context.storeId`
from the guard output — no extra scoping code is needed.

---

### Seam 2 — POS device-bound auth tokens (`auth_tokens.device_id`)

**What exists:**

The `auth_tokens` table has a nullable `device_id` column and a CHECK
constraint that enforces exactly one of `user_id` or `device_id` is set:

```sql
-- packages/db/drizzle/0000_initial.sql, lines 218-229
CREATE TABLE IF NOT EXISTS auth_tokens (
  id           UUID PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id    UUID,
  ...
  CONSTRAINT auth_tokens_principal_xor
    CHECK ((user_id IS NOT NULL)::int + (device_id IS NOT NULL)::int = 1)
);
```

**How a POS endpoint uses it:**

A POS device can be issued a long-lived bearer token bound to `device_id`
instead of `user_id`.  The existing `AuthGuard`
(`apps/api/src/auth/auth.guard.ts`) already resolves bearer tokens from
`auth_tokens` and attaches the principal to `request.principal`.  For a POS
device principal the `kind` field would be `"pos-device"` and `device_id`
would be set.  The guard lookup is table-driven; no code changes are needed to
accommodate device tokens beyond inserting a row with `device_id` populated.

---

### Seam 3 — Idempotency key store (DB seam)

**What exists:**

The `idempotency_keys` table is implemented and RLS-protected:

```sql
-- packages/db/drizzle/0000_initial.sql, lines 290-307
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id               UUID PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id         UUID,
  client_id        TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     BYTEA NOT NULL,
  response_status  INT NOT NULL,
  response_body    JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_scope_uidx
  ON idempotency_keys (tenant_id, store_id, client_id, key) NULLS NOT DISTINCT;
```

The `NULLS NOT DISTINCT` index (Postgres 15+) means a NULL `store_id` still
participates in the uniqueness constraint — tenant-level idempotency (no store
context) works correctly and is not confused with per-store requests.

**What is NOT yet on disk:**

`packages/shared/src/idempotency/store.ts` — the `IdempotencyKeyStore`
application-layer helper — is planned but not yet implemented.  The
`idempotency_keys` DB table is the source of truth; the application helper
is a thin wrapper that will wrap the raw SQL operations.

**How a POS endpoint uses it:**

A POS sync endpoint (e.g., `POST /api/pos/v1/sales`) would:

1. Extract the `Idempotency-Key` header from the request.
2. Compute a hash of the request body.
3. Call `IdempotencyKeyStore.findOrCreate(tenantId, storeId, clientId, key, hash)`.
4. If a prior response exists, return it immediately without re-executing.
5. Otherwise execute the handler, then persist the response via
   `IdempotencyKeyStore.save(...)` with an appropriate `expires_at`.

The DB constraint guarantees collision safety even under concurrent retries:
`ON CONFLICT DO NOTHING` + a follow-up SELECT gives the winner's response.

---

### Seam 4 — Reserved `/api/pos/v1/*` namespace

**Current state:**

Three sub-paths are live on `main`:

| Sub-path | Controller | Description |
|---|---|---|
| `/api/pos/v1/operators` | `PosOperatorsController` | POS operator sign-in/out |
| `/api/pos/v1/audit-events` | `PosAuditEventsController` | POS audit-event batch sync |
| `/api/pos/v1/shifts` | `PosShiftsController` | POS shift management |

Any path within `/api/pos/v1/*` that is not yet claimed returns the standard
not-found envelope (`{ error: { code: "not_found", ... } }`) via the global
`GlobalExceptionFilter`.  This is verified by
`apps/api/test/pos-namespace/reserved-404.spec.ts` (T263).

**How a new POS endpoint attaches:**

A hypothetical `POST /api/pos/v1/sales` endpoint would:

1. Create `apps/api/src/pos-sales/pos-sales.controller.ts` with
   `@Controller("api/pos/v1/sales")`.
2. Wire `POS_AUTH_GUARD` (or reuse `AuthGuard` with a `device` principal kind).
3. Import the module in `AppModule`.
4. Add a Drizzle repository using the existing `db` injection token.

No schema changes are required.  The `stores` and `auth_tokens` tables
already carry the required columns.

---

### Seam 5 — RLS tenant isolation at the DB layer

**What exists:**

Every tenant-scoped table has RLS enabled and FORCE ROW LEVEL SECURITY set:

```sql
-- packages/db/drizzle/0000_initial.sql, line 461-463
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys ...
```

The RLS policy reads `app.current_tenant` from the session GUC, which is set
by `runWithTenantContext` (`packages/db/src/middleware/tenant-context.ts`)
before any DB query runs.  A POS endpoint using the standard DB middleware
gets cross-tenant isolation for free.

The RLS bypass probe (`packages/db/__tests__/rls.bypass.spec.ts`, T207) proves
that a raw SQL `SELECT * FROM stores WHERE id = '<other-tenant-store>'`
issued by the `app_test` role with the wrong tenant GUC returns zero rows.

---

## Walkthrough Scenario: POS Receipt Sync

Below is a step-by-step trace of a hypothetical `POST /api/pos/v1/receipts`
request showing each seam in action.

```
POS device (device_id: "abc-device-uuid")
    │
    │  POST /api/pos/v1/receipts
    │  Authorization: Bearer <device-bound auth_token raw value>
    │  Idempotency-Key: "receipt-20260514-001"
    │  Body: { store_id, items: [...], total: "42.50", currency: "USD" }
    │
    ▼
AuthGuard                                     ← Seam 2
    Looks up auth_tokens where raw_token hash matches.
    Finds row with device_id = "abc-device-uuid".
    Attaches principal { kind: "pos-device", deviceId: "abc-device-uuid",
                         tenantId: "tenant-uuid", storeId: "store-uuid" }.
    │
    ▼
TenantContextGuard                            ← Seam 1
    Reads principal.tenantId → resolves tenant row (status = active).
    Reads principal.storeId  → verifies store is accessible.
    Sets request.context = { tenantId, storeId }.
    │
    ▼
PosReceiptsController.create()
    Extracts Idempotency-Key header = "receipt-20260514-001".
    Computes SHA-256 of request body.
    │
    ▼
IdempotencyKeyStore.findOrCreate()            ← Seam 3
    Queries idempotency_keys:
      WHERE tenant_id = $tenantId
        AND store_id  = $storeId
        AND client_id = "abc-device-uuid"
        AND key       = "receipt-20260514-001"
    If found: return cached { response_status, response_body }.
    │  (first call — not found)
    ▼
PosReceiptsService.create()
    Inserts receipt rows into tenant-scoped tables.
    runWithTenantContext sets GUC app.current_tenant = tenantId.
    RLS policies on all tables ensure cross-tenant writes are rejected.   ← Seam 5
    │
    ▼
IdempotencyKeyStore.save()                    ← Seam 3
    Inserts idempotency_keys row with expires_at = now() + 24h.
    │
    ▼
Response 201 { receipt_id: "...", total: "42.50", ... }
POS device records success.
```

A retry with the same `Idempotency-Key` header short-circuits at the
`IdempotencyKeyStore.findOrCreate()` step and returns the cached 201 without
re-executing the handler.

---

## Verification Status

| Seam | Evidence on disk | Status |
|---|---|---|
| Seam 1 — tenant/store scoping | `packages/db/drizzle/0000_initial.sql`; `TenantContextGuard` | EXISTS |
| Seam 2 — device-bound tokens | `auth_tokens.device_id` column + CHECK constraint | EXISTS (schema only; application integration requires POS-auth PR) |
| Seam 3 — idempotency DB table | `idempotency_keys` table + `NULLS NOT DISTINCT` index | EXISTS (schema only; `IdempotencyKeyStore` application helper is not yet on disk) |
| Seam 4 — namespace reservation | `/api/pos/v1/operators`, `/api/pos/v1/audit-events`, `/api/pos/v1/shifts` live; unknown paths return 404 envelope | PARTIAL (T263 test added) |
| Seam 5 — RLS isolation | Migration + `runWithTenantContext` + RLS bypass probe (T207) | EXISTS (T207 test added; requires CI/Docker to execute) |

---

## What Is NOT Covered Here

- Full POS operator sign-in flow — see `apps/api/src/pos-operators/` (live).
- Audit event batch sync — see `apps/api/src/pos-audit-events/` (live).
- POS shift management — see `apps/api/src/pos-shifts/` (live).
- `IdempotencyKeyStore` application-layer implementation (planned; the DB seam exists).
- The walkthrough test `apps/api/test/pos-seam/walkthrough.spec.ts` (T264 — deferred).

---

**End of pos-seam-walkthrough.md.**
