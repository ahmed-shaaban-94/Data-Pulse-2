# Quickstart — 007 Unknown Items Review Queue API

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Created**: 2026-05-29

A reviewer-client walkthrough of the extended review-queue API, with the isolation assertion each step must satisfy. All operations are `cookieAuth` (dashboard session). The 4 shipped operations (list/dismiss/link/create-product) behave as 005 shipped them; the 3 new ones (inspect/reopen/bulk-dismiss) and the list-param extensions are 007's delta.

---

## Setup (test fixtures)

- Tenant **T** with stores **S1, S2, S3**; tenant **T'** (foreign).
- `pending` `unknown_items` at S1, S2, S3; one `dismissed` at S1; one `resolved` at S2.
- Principals: **Admin** (tenant-wide on T), **Op1** (store-scoped S1 only), **Op12** (S1+S2).

## Journey 1 — List, scoped + filtered (US1–US3)

1. As **Admin**, `GET /api/v1/catalog/unknown-items?status=pending&sort=age_asc` → all pending across S1–S3, each a `ReviewQueueItem` (**no `sale_context`** — FR-007). **Assert**: no `sale_context` key on any item.
2. As **Op1**, same call → only S1 items; facets list **only S1** (FR-006). **Assert**: response reveals no count/identity of S2/S3 (SC-007).
3. As **Op1**, `?source_system=...&group_by=store` → grouped within S1 scope; out-of-scope buckets absent (FR-004/FR-032).
4. As **Op1**, `?limit=500` → `400 validation` (max 200, reject-not-clamp — FR-005). **Assert**: out-of-range rejected, not clamped.

## Journey 2 — Inspect (US3, NEW)

1. As **Admin**, `GET /api/v1/catalog/unknown-items/{S1_pending_id}` → `ReviewQueueItem`, no `sale_context`, no out-of-scope candidate hint (FR-070 — hint excluded v1). **Assert**: FR-020 fields present, `sale_context` absent.
2. As **Op1**, `GET .../{S2_pending_id}` → `404 not-found` (non-disclosing — FR-009/SI-004). **Assert**: indistinguishable from "does not exist."
3. As **T'** principal, `GET .../{any_T_id}` → `404` (cross-tenant non-disclosure).

## Journey 3 — Link / Create / Dismiss (US4–US6, SHIPPED — reused)

1. As **Admin**, link → `resolved/linked` + audit (005 FR-050). Conflict → `409 alias_conflict`, item stays `pending`, conflicting product not disclosed.
2. As **Admin**, create-from with valid minimal fields → `201`, product+alias+transition atomic (005 FR-063). Missing fields → `400 validation`.
3. As **Op1**, dismiss S1 pending → `200 dismissed` + audit. Re-dismiss → `409 already_reconciled` with `details.prior_state`.

## Journey 4 — Reopen (US7, NEW — tenant-wide only)

1. As **Admin**, reopen the S1 `dismissed` item → fresh `pending` row for the same tuple (005 FR-005); original `dismissed` preserved; both events audited. **Assert**: no lifecycle reversal on the original row.
2. As **Admin**, reopen when a `pending` sibling already exists → "already pending", points to sibling, no duplicate (FR-043).
3. As **Admin**, reopen the `resolved` item → `409 already-reconciled`, `details.prior_state = resolved` (FR-043).
4. As **Op1** (in-scope S1 dismissed item) → `403 forbidden`, message "tenant-wide authority required" only (FR-042). **Assert**: `403`, not `404`; no extra detail.
5. As **Op1** (S2 dismissed item, out of scope) → `404 not-found` (FR-042). **Assert**: `404`, not `403` — operator can't learn it exists.

## Journey 5 — Bulk-dismiss (US8, NEW)

1. As **Admin**, `POST /bulk-dismiss { ids: [S1_pending, terminal, S2_id] }` (≤200) → per-item outcomes: `dismissed` / `already-reconciled`(+`details.prior_state`) / `not-found`; each success audited (FR-044/SC-008). **Assert**: one item's failure doesn't affect others.
2. As **Admin**, `POST /bulk-dismiss` with 201 ids → `400 validation`, **nothing dismissed** (FR-070 ceiling, whole-batch reject). **Assert**: no partial dismiss.

## Journey 6 — Idempotency + audit (US9–US10)

1. Reopen / bulk-dismiss twice with the same `Idempotency-Key` + body → exactly one state change, same result (SC-005). Same key + changed body → `409 idempotency_key_conflict` (the shipped wire code for the abstract FR-100 `idempotency-token-mismatch` category — T564 mapping, see [`wave-status.md`](./wave-status.md) / research §R6).
2. For every state change + audited failure, query 005's audit surface → event with tenant/store/actor/action/target/correlation-id (SC-004). **Assert**: no parallel audit channel; events flow through 005 FR-083.

## Isolation sweep (must pass before GREEN — Constitution §VI)

- RLS bypass probe: wrong `app.current_tenant` on the inspect read → zero rows.
- Malicious-override: body `tenant_id`/`store_id` on reopen/bulk-dismiss ignored.
- Cross-tenant + cross-store sweep over inspect/reopen/bulk-dismiss → canonical non-leaking response.
