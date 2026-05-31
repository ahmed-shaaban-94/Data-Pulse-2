# Phase 1 Contract Design: Inventory & Stock Movement Ledger (009)

**Plan**: [../plan.md](../plan.md) | **Spec**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

**Status — DESIGN ONLY.** This file describes the operations, audience/auth split, wire conventions, and error categories the inventory API will expose. It authors **no OpenAPI YAML**. The actual contract under `packages/contracts/openapi/inventory/**` is a **`[GATED]`** slice (Constitution §IV/§VIII, Standing Rules §3) — created with explicit approval, before any implementing slice's GREEN. No request/response field shapes are copied here.

---

## 1. Audience + auth split (LOAD-BEARING — plan §4.2 / research R9)

| Surface | Audience | Auth (`security`) | Notes |
|---|---|---|---|
| Movement create / on-hand read / movement list / transfer / stock count | **Dashboard / back-office operator** | `cookieAuth` (human session) | Object-level authorized per store; these are operator actions, NOT POS-device actions |
| Sale-linked outbound **backfill** | **Platform / admin-invoked** | platform/admin credential (worker path) | Not a public POS route; reads **captured** 008 sale rows (R8) |

009 does **not** expose a `/api/pos/v1/` device-token surface in v1. If a POS-device inventory surface is ever needed, it is an **additive contract version**, not a v1 concern.

## 2. Operations (design intent — operationIds are illustrative, pinned in the gated YAML)

| Operation (intent) | Method + path (illustrative) | Maps to | Auth |
|---|---|---|---|
| Create stock movement (inbound/outbound/adjustment) | `POST /api/inventory/v1/movements` | US2/US3, FR-010..012/030/031 | cookieAuth |
| Read on-hand for a product@store | `GET /api/inventory/v1/on-hand/{storeId}/{productId}` | US1, FR-003/005 | cookieAuth |
| List movements behind a balance | `GET /api/inventory/v1/movements?store=&product=` | US1, FR-004 | cookieAuth |
| Create transfer (linked movements) | `POST /api/inventory/v1/transfers` | US5, FR-020 | cookieAuth |
| Record stock count (→ correction) | `POST /api/inventory/v1/counts` | US6, FR-021 | cookieAuth |
| Sale-linked outbound backfill | platform/admin worker-invoked (not a public route) | US4, FR-031/032/033 | platform/admin |
| Restock from void/refund/return | `POST /api/inventory/v1/movements` (inbound + `terminal_event_ref`) | FR-025 | cookieAuth / backfill |

- **Idempotency** (FR-030/031): write operations accept the `Idempotency-Key` header (manual); the backfill dedups on `sourceSystem + externalId` / sale-ref. Replay with divergent body ⇒ conflict.
- **No automatic decrement / auto-restock** route in v1 — those are the deferred follow-up (FR-060/025), addable as a new movement source without changing these operations (SC-008).

## 3. Wire conventions (inherited — do NOT re-invent)

- **OpenAPI 3.1 source of truth** in `packages/contracts/openapi/inventory/**`; code conforms; contract tests enforce (§IV).
- **Stable `operationId`** per endpoint; renames are breaking.
- **No raw DB entities** in responses — every body is an explicit `toBody()` wire projection (§IV). The on-hand projection includes the **`negative_balance` flag** (FR-024); the movement projection includes provenance/linkage refs (FR-004) but never internal-only fields.
- **Uniform error envelope** `{ error: { code, message, request_id, details? } }`; `request_id` always present (§III API Conventions).
- **Status mapping** (canonical): `400` validation (incl. cross-unit quantity, zero/same-store transfer), `401` unauth, `403` insufficient-role-within-resolved-tenant, `404` not-found-or-cross-tenant (safe-404, FR-051), `409` idempotency/divergent-body conflict, `429` rate-limited (backfill bound), `5xx` internal.

## 4. Error categories specific to 009

| Category | Code (illustrative) | Trigger |
|---|---|---|
| Cross-unit quantity | `validation_error` (400) | movement `stocking_unit` ≠ product stocking unit (FR-022, no coercion) |
| Zero / same-store transfer | `validation_error` (400) | transfer source == destination, or quantity == 0 |
| Idempotency divergent body | `conflict` (409) | same key, different body (FR-030) |
| Cross-tenant reference | safe `404` | movement/on-hand/transfer/sale-ref/destination-store owned by another tenant (FR-051) |
| Missing reason | `validation_error` (400) | `adjustment` / `count_correction` without a reason (FR-012/021) |

**Note — negative stock is NOT an error.** Allow-and-flag (FR-024): an outbound driving on-hand negative returns success; the negative-balance signal is emitted. There is no `409`/`422` for going negative.

## 5. What this design defers to the gated YAML slice

- Exact `operationId`s, path versioning segment, request/response schemas, the `negative_balance` flag's exact field name + projection shape, pagination/sort/filter params for the movement list, and the `security` scheme objects. All authored in the `[GATED]` contract slice with approval, exercised by CI conformance tests — **not here.**
