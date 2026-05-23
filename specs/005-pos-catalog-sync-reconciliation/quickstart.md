# Quickstart — 005 POS Catalog Sync & Unknown Item Reconciliation

**Phase**: 1 (design — runnable narrative)
**Status**: Draft
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Data model**: [data-model.md](./data-model.md)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

> A working narrative for the most common 005 happy path: a POS captures an
> unknown barcode, a tenant admin reviews and links it to an existing
> tenant product, and a subsequent POS submission of the same barcode
> resolves to the linked product. This document is not a runnable script —
> it cannot be (no API endpoint exists yet). It is the **golden-path
> scenario** the implementation slices must satisfy when they land.

---

## Pre-conditions

For this walkthrough to make sense, the following state must exist:

| State | Provided by |
|---|---|
| Tenant `T` exists in `tenants`. | 001 onboarding |
| Store `S` exists in `stores` and is bound to tenant `T`. | 001 onboarding |
| POS device `D` is authenticated against tenant `T` with resolved store `S`. | 002 |
| Tenant `T` has at least one existing tenant product `P1` (e.g., "Coca-Cola 330ml") with no alias for barcode `5449000000996`. | 003 catalog seed |
| Tenant admin `U` is a member of tenant `T` with `role = 'tenant_admin'` (i.e., tenant-wide authority). | 001 memberships |
| RLS posture on `unknown_items`, `product_aliases`, `tenant_products` is post-0010. | 003 migrations 0007–0010 |

---

## Step 1 — POS captures an unknown barcode

POS device `D` scans barcode `5449000000996` during a sale. The barcode does not match any active `product_aliases` row in tenant `T`. POS submits the capture to the SaaS:

**Conceptual request** (the actual HTTP / contract shape is deferred to the gated contract slice — see [plan.md §8.3](./plan.md#83-gated-contract-slice-separate-lands-before-either-waves-implementation)):

```
POST /tenants/<T>/stores/<S>/catalog/unknown-items/capture
Authorization: Bearer <POS device token for tenant T, store S>
Idempotency-Token: <opaque token, 24h TTL>

{
  "identifier_type": "barcode",
  "value": "5449000000996",
  "source_system": null,
  "sale_context": { "register": "1", "ts": "2026-05-23T16:00:00Z" }
}
```

**Expected SaaS behavior** (per FR-001, FR-010, FR-030, FR-031, FR-070):

1. Zod validation at the boundary (FR-070, FR-071): all required fields present, `identifier_type ∈ {barcode, sku, plu, supplier_code, external_pos_id}`, `value` length 1–200, `source_system` rules enforced.
2. Resolve principal (POS device → tenant `T`, store `S`).
3. Inside `runWithTenantContext(T, S, …)`:
   a. Look up active alias for `(T, identifier_type='barcode', value='5449000000996')` via `idx_product_aliases_lookup`. **No match.**
   b. Look up existing pending `unknown_items` row for the same logical identifier via `idx_unknown_items_lookup_value`. **No match.**
   c. INSERT into `unknown_items` with `resolution_status='pending'`, `tenant_id=T`, `store_id=S`, `identifier_type='barcode'`, `value='5449000000996'`, `source_system=NULL`, `sale_context={...}`, `correlation_id=<request correlation id>`.
4. Emit audit event with subject `unknown_item.captured`, attributing to POS device `D` with the request correlation id.
5. Increment metric `unknown_item_captured_total{tenant_bucket=…}`.
6. Return 201-class outcome envelope referencing the new `unknown_items.id` as a stable reference.

**State delta**: one new row in `unknown_items`. No row in `product_aliases`. No row in `tenant_products`. One row in `audit_events`.

---

## Step 2 — POS retries the same submission (network drop)

The POS-side response was lost. POS retries the **exact same submission** within the 24h TTL with the **same** `Idempotency-Token`.

**Expected SaaS behavior** (per FR-021, FR-021a, FR-021b, FR-022):

1. 001's idempotency interceptor finds the cached response for `(T, D, token)`.
2. Returns the **same** 201-class outcome envelope as Step 1, byte-for-byte.
3. **No** new `unknown_items` row is created.
4. **No** new audit event is emitted (the original event was emitted on first observation).

**State delta**: none.

If the POS retries with the **same token but a different payload** (e.g., different identifier value), per FR-021c the SaaS returns a 409-class `idempotency-token-mismatch` outcome, emits `unknown_item.idempotency_mismatch_rejected`, increments `idempotency_token_mismatch_total`, and creates **no** new row.

---

## Step 3 — Tenant admin reviews the queue

Tenant admin `U` opens the review queue. The dashboard UI is out of scope here, but the data flow is:

**Conceptual request**:

```
GET /tenants/<T>/catalog/unknown-items?status=pending
Authorization: Bearer <U's session>
```

**Expected SaaS behavior** (per US2, FR-014):

1. `U`'s session resolves to tenant `T` with tenant-wide authority (per 001 memberships, FR-015).
2. Inside `runWithTenantContext(T, '<empty for tenant-wide>', …)`:
   - SELECT from `unknown_items WHERE tenant_id = T AND resolution_status = 'pending'`.
   - RLS via `unknown_items_tenant_isolation` returns rows for `T` only; the `app.current_store = ''` tenant-owner carve-out (per `wave-status.md` and 003's RLS matrix §4.3) gates the cross-store view.
3. Response includes the unknown item from Step 1.

A store-scoped operator at store `S2 ≠ S` would NOT see this row (RLS via `unknown_items_store_read` excludes it).

---

## Step 4 — Tenant admin links the unknown item to an existing product

`U` recognises the barcode belongs to product `P1` ("Coca-Cola 330ml") and clicks "Link" in the queue.

**Conceptual request**:

```
POST /tenants/<T>/catalog/unknown-items/<U_id>/link
Authorization: Bearer <U's session>

{ "target_product_id": "<P1_id>" }
```

**Expected SaaS behavior** (per US2 #1, FR-050, FR-051, FR-052, FR-053):

1. `U`'s session principal resolves; tenant-wide authority confirmed.
2. Inside `runWithTenantContext(T, '', …)` in a **single transaction**:
   a. SELECT `tenant_products WHERE id = P1_id AND tenant_id = T`. **Found, status = 'active'** → proceed (FR-050a, FR-051 not triggered).
   b. SELECT `unknown_items WHERE id = U_id AND tenant_id = T AND resolution_status = 'pending'`. **Found** → proceed.
   c. INSERT into `product_aliases (tenant_id, product_id, identifier_type, value, source_system, store_id, retired_at, created_by) VALUES (T, P1_id, 'barcode', '5449000000996', NULL, NULL, NULL, <U's user id>)`.
      - This is a tenant-wide alias (store_id=NULL) because barcodes are intrinsic to a product, not store-specific. The choice between tenant-wide and store-scoped is a service-layer decision; the spec defers to the eventual contract for which is the default.
      - The partial unique index `UQ_idx_product_aliases_tenant_wide` enforces no duplicate. If a duplicate exists (race or pre-existing) the INSERT raises `unique_violation` → caught → FR-052 fail-closed → entire transaction aborts → U remains `pending`.
   d. UPDATE `unknown_items SET resolution_status='resolved', resolved_at=NOW(), resolved_by=<U's user id>, resolution_action='linked', resolved_product_id=P1_id WHERE id=U_id`.
3. Audit event subject `unknown_item.resolved.linked` emitted.
4. Metric `unknown_item_resolved_total{action='linked'}` incremented.
5. Return 200-class success outcome.

**State delta**: one new row in `product_aliases`. One UPDATE to `unknown_items` (transitioning to `resolved`). One audit event.

If the alias INSERT in step 2c would conflict (e.g., a sibling alias already bound to a different product P2), the transaction rolls back: `product_aliases` unchanged, `unknown_items` still `pending`, and a 409-class `alias-conflict` outcome returns. The `unknown_item.reconciliation_conflict_rejected{reason='alias_conflict'}` audit event is emitted (FR-082).

---

## Step 5 — Next POS submission resolves to the linked product

POS device `D` (or any other device of tenant `T` if the alias is tenant-wide) scans barcode `5449000000996` again, e.g., during a later sale.

**Expected SaaS behavior** (per FR-022, FR-030, FR-031):

1. POS submits the same capture as Step 1, with a **different** Idempotency-Token (it's a new sale).
2. Inside `runWithTenantContext`:
   a. Look up active alias for `(T, 'barcode', '5449000000996')`. **Match found** → resolves to `P1`.
3. **No** `unknown_items` row is created (FR-031).
4. Return 200-class outcome envelope with the resolved product reference (the precise shape is deferred to the gated contract slice).
5. Emit metric `tenant_product.lookup_resolved` (existing 003 §9 signal).

**State delta**: none in `unknown_items`, `product_aliases`, or `tenant_products`. The POS got a resolved product immediately.

---

## Optional Step 6 — Tenant admin creates a new product instead of linking

If at Step 3 the admin decides the barcode does not correspond to any existing tenant product (it's a genuinely new product), the admin clicks "Create new product" instead.

**Conceptual request**:

```
POST /tenants/<T>/catalog/unknown-items/<U_id>/create-product
Authorization: Bearer <U's session>

{
  "name": "Coca-Cola 330ml",
  "tenant_product_category_id": "<beverages category id>",
  ...minimal product fields per 003 §5...
}
```

**Expected SaaS behavior** (per FR-060–FR-063):

In a single transaction:
1. INSERT `tenant_products`.
2. INSERT `product_aliases` for the captured barcode binding to the new product.
3. UPDATE `unknown_items` to `resolved` with `resolution_action='created'`.

If any step fails (e.g., alias conflict per FR-062, or `tenant_products` constraint violation), all three roll back — neither the product nor the alias is created, and the unknown item stays `pending` (FR-062).

Audit subject: `unknown_item.resolved.created`. Metric: `unknown_item_resolved_total{action='created'}`.

---

## Optional Step 7 — Tenant admin dismisses

If the admin decides the captured identifier is invalid (cashier typo, scanner glitch, etc.), they click "Dismiss".

**Expected SaaS behavior** (per FR-003 dismiss, FR-004):

1. UPDATE `unknown_items SET resolution_status='dismissed', resolved_at=NOW(), resolved_by=<U>, resolution_action='dismissed'`.
2. No `product_aliases` or `tenant_products` write.
3. Audit subject: `unknown_item.dismissed`. Metric: `unknown_item_resolved_total{action='dismissed'}`.

The dismissed row is **terminal** (FR-004). If POS submits the same identifier again at the same `(T, S)` later, **a fresh `pending` row** is created (FR-005); the dismissed row stays for audit history.

---

## What this quickstart does NOT cover

For brevity and scope:

- Cross-store reconciliation by a tenant admin (US2 scenarios beyond the simple case).
- Concurrent reconciliation races (US3 #3) and the deterministic "already-reconciled" outcome.
- Cross-tenant isolation probes (SI-001, FR-013) — covered in [research.md §R2](./research.md) and in the eventual `apps/api/test/catalog/unknown-items/isolation/non-disclosing-errors.spec.ts`.
- The full failure-mode taxonomy — see [research.md §R2](./research.md).

The implementation slices defined in [plan.md §8](./plan.md#8-implementation-phasing-advisory) must exercise all of those paths, but they are not on this golden-path narrative.

---

## When this quickstart becomes runnable

This document becomes a runnable scripted scenario (e.g., an end-to-end Jest spec) when:

1. The gated contract slice ([plan.md §8.3](./plan.md#83-gated-contract-slice-separate-lands-before-either-waves-implementation)) lands and defines the actual HTTP endpoints.
2. Wave 1 capture slices ([plan.md §8.1](./plan.md#81-wave-1-capture-path-unblocked-can-land-today)) implement Steps 1–3.
3. Wave 2 reconciliation slices ([plan.md §8.2](./plan.md#82-wave-2-reconciliation-path-blocked-on-phase3_red_wave)) implement Steps 4–7.

Until then, this document is the **acceptance contract** for those slices: the eventual implementation MUST make each step above pass an integration test.
