# Contract (PROSE) — Console Sync-Ops Read-Model v1

> **GATED — DESCRIPTION ONLY.** This file describes the future OpenAPI 3.1 contract in
> prose. The real YAML is a `[GATED]` artifact that lives under
> `packages/contracts/openapi/**` and MUST NOT be created or edited in this no-implement
> planning pass. Authoring the YAML requires explicit approval in the implementing slice.

## Proposed location

`packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml`
(sibling of `erpnext-reconciliation/reconciliation.yaml` and
`erpnext-connector/posting-feed.yaml`).

## Namespace & security

- **Base path**: `/api/v1/catalog/erpnext-sync-ops` (under the existing catalog/erpnext
  operator namespace; mirrors 017's `/api/v1/catalog/erpnext-reconciliation`).
- **Security**: `cookieAuth` only (human dashboard session) — gated by
  `DashboardAuthGuard` + `RolesGuard`. **No** `connectorBearer`, **no** `clerkJwt`,
  **no** `dashboard_api` bearer. A machine credential MUST be rejected.
- **Error envelope**: canonical `{ error: { code, message, request_id, details? } }`.
  Status mapping: 400 validation, 401 unauthenticated, 403 insufficient-role-in-tenant,
  404 not-found-or-cross-tenant, 429 rate-limited, 5xx internal.

## Operations (all GET, all read-only)

### 1. `consoleGetSyncOpsSummary`
- **GET** `/api/v1/catalog/erpnext-sync-ops/summary`
- **Query**: optional `store_id` (validated against operator's in-scope stores).
- **200**: `SyncOpsSummary` — `domains[]` with one `DomainSummary` per domain
  (posting + reconciliation populated; connector_health + product_master =
  `not_available` in v1).
- Maps to FR-001, FR-002, FR-003, FR-004. (US1)

### 2. `consoleListPostingBacklog`
- **GET** `/api/v1/catalog/erpnext-sync-ops/posting-backlog`
- **Query**: `cursor?`, `page_size?` (bounded), `sort?` (e.g. `dead_lettered_at`),
  `group_by?` (`mismatch_class`), `store_id?`.
- **200**: `PageEnvelope<PostingBacklogItem>` — only `permanently_rejected` 015 rows,
  projected with class, origin ref, provenance, structured reason, dead-letter time.
- Maps to FR-005, FR-013, FR-014. (US2)

### 3. `consoleListReconciliationRuns`
- **GET** `/api/v1/catalog/erpnext-sync-ops/reconciliation-runs`
- **Query**: `cursor?`, `page_size?` (bounded), newest-first ordering, `store_id?`.
- **200**: `PageEnvelope<ReconciliationRunView>` — 017 runs projected with trigger
  source, status, timestamps, per-class mismatch summary.
- Maps to FR-006, FR-014. (US3)

## Schemas (wire shapes — see data-model.md)

`SyncOpsSummary`, `DomainSummary` (with `status: ok|attention|not_available`),
`PostingBacklogItem`, `ReconciliationRunView`, `PageEnvelope`. All are explicit wire
shapes — **no raw DB entity, no internal columns, no credential/hash material** (§IV).
Any monetary field is exact-decimal string + ISO-4217 `currency`, pass-through (§III).

## Conformance

Every `operationId` above MUST be exercised by an OpenAPI conformance test in CI
(request/response schema, error envelope, `cookieAuth` security scheme). `operationId`
names are stable (renames are breaking, §IV).

## Cross-references

- Source state: 015 `erpnext_posting_status`, 017 `erpnext_reconciliation_run` /
  `_result`.
- Sibling operator contract: `erpnext-reconciliation/reconciliation.yaml` (017) — same
  auth scheme, same namespace family; 025 is its **read-only** consolidation, exposing
  no write/repair (those stay in 017).
- Forward-compat: connector_health (020) and product_master (021) domains are present in
  `SyncOpsSummary` as `not_available` until those specs ship.
