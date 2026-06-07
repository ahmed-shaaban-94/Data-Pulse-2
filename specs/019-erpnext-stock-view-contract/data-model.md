# Phase 1 Data Model: ERPNext live stock-view (Bin) read contract

**Feature ID**: 019
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)
**Constitution**: v3.0.1
**Status**: **Design only.** 019 adds **NO new persisted table and NO migration**
(FR-009: no standing Bin mirror). This document models the **wire shapes** the
`[GATED]` contract YAML will define and the **read-only** posture over existing
tables.
**Date**: 2026-06-07

> **Why there is no new table.** The signed 014 stock-impact decision (OQ-1)
> rejects a standing DP2 copy of ERPNext stock. The reported Bin snapshot is
> **run-scoped evidence**, recorded (if at all) in the existing 017
> `erpnext_reconciliation_result.detail` — never in a new `erpnext_bin` table.
> Consequently 019 touches **no `packages/db` surface**; its only gated artifact is
> the OpenAPI YAML.

---

## 1. What 019 reads (no writes to these)

| Entity | Feature | 019's use | Mutated? |
|---|---|---|---|
| `erpnext_warehouse_map` | 014 (`0018`) | The active `(tenant, store, purpose='stock')` row supplies the `erpnextWarehouseRef` advertised in each feed item. | No (read-only) |
| `erpnext_item_map` | 013 (`0017`) | Confirmed maps translate a reported `erpnextItemRef` → `tenant_product_ref` (DP2-side, R4). | No (read-only) |
| `stock_movements` | 009 (`0014`) | The DP2 on-hand side of the 017 compare (the 017 run reads this, not 019 directly). | No |
| `erpnext_reconciliation_run` / `_result` | 017 (`0020`) | A feed item correlates to a run; reported Bin values may be recorded in `result.detail` as audit. | 017 writes `_result`; 019 contributes the Bin value only via the future 017-rewire (out of scope here) |

**RLS posture**: every read is tenant-scoped via `app.current_tenant` (fail-closed,
empty-GUC CASE guard — repo-wide pattern). The connector principal's tenant scope
(018) sets the GUC. No new RLS surface (no new table). Cross-tenant access →
non-disclosing 404 (§II/§XII). The runtime DB role has no `BYPASSRLS`.

---

## 2. Wire entities (the `[GATED]` contract schemas — designed, not authored)

These mirror `posting-feed.yaml`'s conventions: strict (`additionalProperties:
false`), explicit projections (§IV), no raw DB shape, no `tenant_id` echoed,
exact-decimal quantities, opaque refs, canonical `Error` envelope.

### 2.1 `BinViewRequest` (feed item — DP2 → connector)

One wanted ERPNext-Bin read for a `(tenant-implicit, store)` with an active 014
`stock` mapping.

| Field | Type | Notes |
|---|---|---|
| `requestRef` | `string` (uuid) | Stable, opaque, scope-bound reference. Echoed on the report to bind the snapshot. |
| `storeId` | `string` (uuid) | DP2 store id (the connector maps it to the warehouse via the supplied ref; lineage only). |
| `erpnextWarehouseRef` | `string` (1–180) | The 014 `erpnext_warehouse_ref` for the store's active `stock` mapping. Opaque, no FK, version-independent (012 O-6 / 014). |
| `runRef` | `string` (uuid) | The 017 reconciliation run this bin-view request belongs to (correlation, US3). |
| `itemWindow` | `BinViewItemWindow` | The bounded ≤500-item slice this request covers. **A warehouse with more items than the report ceiling (500) is split into one request per window**, so each request maps to exactly one ≤500-entry report — pagination on the *request*, never the report body. See §2.1a. |
| `itemCursor` | `string` (opaque) | Advanced cursor after this request item (≤ page cursor). Opaque — do not decode. |

No `tenant_id` (implicit in principal scope). No quantity here — this is the
*request*, not the data.

### 2.1a `BinViewItemWindow` (the per-request item slice)

Resolves the cardinality problem: a real ERPNext warehouse can hold thousands of
distinct Bin rows, but one snapshot report carries ≤500 entries. DP2 windows the
warehouse into ≤500-item slices and issues one `BinViewRequest` per window, so the
report's 500 cap is a **guaranteed-safe invariant**, never a truncation risk.

| Field | Type | Notes |
|---|---|---|
| `windowSeq` | `integer` (≥0) | Zero-based window sequence within the warehouse's Bin set for this run. |
| `maxItems` | `integer` (1–500) | Hard upper bound — never exceeds the report `entries` ceiling, so a report can always carry the full window. |
| `fromItemRef` | `string \| null` (1–140) | Optional opaque inclusive lower bound of the item range; null on the first window. |
| `toItemRef` | `string \| null` (1–140) | Optional opaque exclusive upper bound; null on the last window. |

The windowing scheme (item-ref range, hash bucket, etc.) is a DP2 implementation
concern behind these opaque bounds; the connector treats the window as opaque
scoping and reports the Bin items that fall in it.

### 2.2 `BinViewPage` (feed response — DP2 → connector)

Cursor-paginated page of `BinViewRequest`, mirroring 012's `PostingFeedPage`.

| Field | Type | Notes |
|---|---|---|
| `items` | `BinViewRequest[]` | `maxItems: 500` (009/012 ceiling). |
| `cursor` | `string` | Advanced opaque server cursor — pass as `since` next. Opaque. |
| `next_page_token` | `string \| null` | Opaque continuation; null on last page. |

### 2.3 `BinViewSnapshotReport` (report request body — connector → DP2)

The connector's point-in-time ERPNext-Bin snapshot for a pulled `requestRef`.
Strict; scope is NOT body-supplied (FR-005).

| Field | Type | Notes |
|---|---|---|
| `entries` | `BinEntry[]` | `minItems: 0` (empty = warehouse empty / window empty — a valid, non-failing report). `maxItems: 500` — **sound because the request's `itemWindow` bounds the wanted items to ≤500 (§2.1a)**; the connector reports the Bin items in the request's window only, so a complete report never exceeds the cap. |
| `readAt` | `string` (date-time) | Connector-reported time the Bin was read at ERPNext. Preserved as received; NEVER a security clock (§X / FR-016). |

> The `requestRef` is a path parameter, not a body field, so it cannot be forged
> in the body (mirrors 012's `{workItemRef}` on the outcome ack).

### 2.4 `BinEntry` (one item's Bin quantity)

| Field | Type | Notes |
|---|---|---|
| `erpnextItemRef` | `ErpnextItemRef` | doctype const `Item` + opaque `name` (1–140), mirroring 012's `ErpnextItemRef`. DP2 translates to `tenant_product_ref` via confirmed 013 map (R4). |
| `quantity` | `string` (exact-decimal) | Bin on-hand, exact-decimal string (pattern `^-?[0-9]{1,15}(\.[0-9]{1,6})?$`, mirroring 012's quantity), denominated in `stockUom`, NEVER a float (§III / FR-008). The connector converts ERPNext `Bin.actual_qty` (float) deterministically — round half-even to 6 dp. Negative tolerated; 017 compares, never rounds. |
| `stockUom` | `string` (1–140) | The ERPNext `Item.stock_uom` this quantity is denominated in. **REQUIRED** so 017 surfaces a unit-of-measure mismatch (DP2 records movements in its own `stocking_unit`) as a DISTINCT classification, not a false `quantity_divergence`. Opaque beyond equality; no UOM conversion on this surface (a conversion layer, if needed, is a named follow-up). |

**No valuation / cost / price field anywhere** (014 OQ-1 / FR-008 / SC-004).

### 2.5 `RecordedBinView` (report response projection — DP2 → connector)

DP2's `toBody()` confirmation of a recorded report (mirrors 012's `RecordedOutcome`).

| Field | Type | Notes |
|---|---|---|
| `requestRef` | `string` (uuid) | Echoes the bound request. |
| `runRef` | `string` (uuid) | The correlated 017 run (US3). |
| `erpnextWarehouseRef` | `string` (1–180) | The warehouse the snapshot was bound to (echoed from the request) — so the connector can verify from the response alone which warehouse DP2 recorded against (spec US3 acceptance scenario 2). |
| `acceptedEntryCount` | `integer` | How many entries DP2 recorded. |
| `readAt` | `string` (date-time) | The connector's read time, echoed back unchanged (preserved; never a security clock, §X / FR-016). |
| `recordedAt` | `string` (date-time) | DP2 **server-clock** stamp (the security clock, §X) — distinct from the connector's `readAt`. |

Both clocks appear as distinct fields (spec US3 acceptance scenario 2). Plus an
`Idempotent-Replayed: true` response header on a 200 replay (mirrors 012).

### 2.6 `Error` (canonical envelope — verbatim shared shape)

`{ error: { code, message, request_id? } }`, identical to `auth` / `outbox` /
`pos-sales` / `posting-feed`. Closed `error.code` set on this surface:
`validation_failure`, `snapshot_required`, `idempotency_key_conflict`, `not_found`,
`system_failure`, plus the generic 401 refusal. Non-disclosing (no cause
enumeration, no existence leak).

---

## 3. Operations (the two operationIds)

| operationId | Method + path | Auth | Idempotency | Mirrors |
|---|---|---|---|---|
| `binViewPullRequests` | `GET /api/connector/v1/erpnext/bin-view-requests` | `connectorBearer` | idempotent on `since` cursor | `connectorPullPostings` |
| `binViewReportSnapshot` | `POST /api/connector/v1/erpnext/bin-view-requests/{requestRef}/snapshot` | `connectorBearer` | `Idempotency-Key` **required** | `connectorAckOutcome` |

`binViewPullRequests` params: `since` (opaque, optional), `limit` (1–500, default
100). Responses: 200 `BinViewPage`, 400, 401, 404, 409 `snapshot_required`, 500.

`binViewReportSnapshot` params: `requestRef` (path, uuid), `Idempotency-Key`
(header, required). Body: `BinViewSnapshotReport`. Responses: 200 (idempotent
replay, `RecordedBinView`), 201 (first record), 400, 401, 404, 409
`idempotency_key_conflict`, 500.

---

## 4. Relationships & boundaries

- **014 `erpnext_warehouse_map`** — supplies `erpnextWarehouseRef`; only active
  `stock` mappings are advertised as feed items. A store with no active mapping is
  never offered (017 classes it `unmapped_store` independently). Read-only.
- **013 `erpnext_item_map`** — the `erpnextItemRef → tenant_product_ref`
  translation authority (confirmed maps only). An unmapped `erpnextItemRef` → the
  017 run classes it `erpnext_only`. Read-only.
- **017 reconciliation** — the consumer. A `BinViewRequest.runRef` ties the
  snapshot to a run; the future 017-rewire backs `ErpnextBinView.fetchBinView`
  with the reported snapshot (out of 019 scope, R8). The reported per-item value
  may be persisted in `result.detail` as point-in-time audit — never a standing
  mirror (FR-009).
- **ERPNext Bin** — external; reached only by the connector behind the contract
  (012 O-6). DP2 never reads it (FR-012).

---

## 5. Constitution Check (data-model level)

| Principle | Verdict |
|---|---|
| §II Multi-tenant RLS | ✅ All reads tenant-scoped via `app.current_tenant` (fail-closed); no new RLS surface; safe-404 cross-tenant. |
| §III Backend authority | ✅ Exact-decimal quantities, no float, no silent rounding; DP2 on-hand authority + ERPNext valuation untouched. |
| §IV Contract-first | ✅ Strict wire projections, stable operationIds, explicit `connectorBearer` security, canonical Error; conformance test. |
| §VIII Reproducible releases | ✅ **No migration, no schema, no dependency** — only the `[GATED]` contract YAML. |
| §IX Source-of-truth | ✅ Reconcile-not-merge; **no standing Bin mirror** (OQ-1); authorities unchanged. The principle 019 most directly serves. |
| §X Temporal | ✅ Connector `readAt` preserved, never a security clock; DP2 server-clock `recordedAt`. |
| §XI Idempotency | ✅ `Idempotency-Key` required on report; feed idempotent on cursor; reuses existing interceptor. |
| §XII Object safety | ✅ Scope never body-supplied; strict DTOs; `requestRef` path-param; object-level auth. |
| §XIV PII/lifecycle | ✅ Quantities + opaque refs only — no PII, no payment, no money on the surface. |

**Result: PASS.** The no-new-table decision (FR-009) keeps 019 off `packages/db`
and actively strengthens §IX (no read-down look-alike).

---

## Next step

This design → `tasks.md` (sequence the slices), then the **`[GATED]` 019-CONTRACT**
slice authors `packages/contracts/openapi/erpnext-connector/stock-view.yaml` + its
structural conformance spec (the only buildable, gated artifact). The DP2-facing
feed/report **runtime** and the **017-rewire** that consumes it are downstream/future
slices, captured but not built here.
