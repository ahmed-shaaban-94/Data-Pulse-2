# Contracts — 007 Unknown Items Review Queue API

**Status**: Obligations only — final OpenAPI YAML is a `[GATED]` extension, NOT authored here.
**Plan**: [../plan.md](../plan.md) | **Spec**: [../spec.md](../spec.md)
**Created**: 2026-05-29

---

## Why this directory holds no `*.yaml`

007 **extends** the already-shipped 005 contract at `packages/contracts/openapi/catalog/unknown-items.yaml` (currently `version: 1.1.0-draft`, 5 operationIds). That path is `[GATED]` (Constitution §IV / §VIII, Standing Rules §3) and MUST NOT be edited by a tool without explicit per-slice approval. This README enumerates what the GATED extension slice MUST satisfy — it is not itself the contract.

**Do not author OpenAPI YAML here.** The canonical location is the existing `packages/contracts/openapi/catalog/unknown-items.yaml`, extended in place with a version bump.

---

## Already-shipped operations 007 REUSES unchanged

| operationId | Method / path | 007 use |
|---|---|---|
| `tenantAdminListUnknownItems` | GET `/api/v1/catalog/unknown-items` | extended with new query params (below) |
| `tenantAdminDismissUnknownItem` | POST `/api/v1/catalog/unknown-items/{id}/dismiss` | reused; bulk-dismiss decomposes into N of these |
| `tenantAdminLinkUnknownItem` | POST `/api/v1/catalog/unknown-items/{id}/link` | reused unchanged |
| `tenantAdminCreateProductFromUnknownItem` | POST `/api/v1/catalog/unknown-items/{id}/create-product` | reused unchanged |
| `posCaptureItem` | POST `/api/pos/v1/catalog/unknown-items` | **out of 007 scope** (POS-side, 005/002) |

## New operations the GATED extension MUST add

| operationId (final names TBD by slice) | Method / path | Spec FRs |
|---|---|---|
| `tenantAdminInspectUnknownItem` | GET `/api/v1/catalog/unknown-items/{id}` | FR-009; US3 |
| `tenantAdminReopenUnknownItem` | POST `/api/v1/catalog/unknown-items/{id}/reopen` | FR-041, FR-042, FR-043; US7 |
| `tenantAdminBulkDismissUnknownItems` | POST `/api/v1/catalog/unknown-items/bulk-dismiss` | FR-044; US8 |

## List-parameter extensions (on `tenantAdminListUnknownItems`)

Additive query params, all scope-respecting (FR-002–FR-006):

- `source_system` filter (FR-002)
- age-bucket filter (e.g. `<24h` / `1-7d` / `7d+`) (FR-002/FR-030)
- `sort` (age asc/desc, store) (FR-003)
- optional `group_by` (store / source_system / age_bucket) (FR-004)
- filter facets in the response listing only in-scope dimensions (FR-006)
- existing `status`, `store_id`, `cursor`, `limit` (min 1 / max 200 / default 50, 400 on out-of-range) reused unchanged (FR-005)

## Schema obligations

- **`ReviewQueueItem`** (new): the shipped `UnknownItem` schema **minus `sale_context`** (research §R1 / data-model §2.1). Used by the extended list, inspect, and FR-001a terminal-detail responses. The §R1 pre-existing-surface choice (does the *shipped* list response also switch to `ReviewQueueItem`?) is a human-sign-off item for the slice.
- **FR-001a conditional**: `resolved_product_id` present only if the caller may see the product; omitted otherwise (row still returned).
- **Bulk-dismiss request**: `{ ids: string[] }`, `.strict()`, `maxItems: 200`; >200 → whole-batch `validation` rejection.
- **Bulk-dismiss response**: per-item `{ id, outcome }` array (data-model §2.3).

## Auth, idempotency, errors (inherited conventions)

- **Auth**: `cookieAuth` (`dp2_session`) for all 007 operations.
- **Idempotency**: `Idempotency-Key` header (shipped `posCaptureItem` convention) on the **new** reopen + bulk-dismiss (identical-replay-response). The shipped link/create/dismiss keep their monotonic-guard no-duplicate-effect; retrofitting a key onto them is a human-sign-off item (research §R6 / plan §4.6). **T564 wire-mapping trap**: the abstract category `idempotency-token-mismatch` IS the shipped wire code **`idempotency_key_conflict`** (`409`); the header is **`Idempotency-Key`**, NOT `Idempotency-Token`. Do not reintroduce the T564 drift.
- **Error envelope**: canonical `{ error: { code, message, request_id } }`. Status map: `400` validation, `401` unauth, `403` `forbidden` (in-scope reopen authority only), `404` not-found/cross-tenant, `409` already-reconciled/conflict, `5xx` system-failure.
- **Error taxonomy**: extend the closed set to 8 categories by adding `forbidden` (research §R4). Keep the existing wire spellings (`already_reconciled`, `alias_conflict`, …); pin the new `forbidden` spelling in the slice.

## Versioning

- Bump `info.version` from `1.1.0-draft` (additive, new operations + new schema + new error code → MINOR per Constitution §IV additive rule).
- All new `operationId`s are stable and additive; no rename of the 5 shipped ones (renames are breaking).
- Conformance tests required (Constitution §IV): every new operation exercised against runtime responses in CI.
