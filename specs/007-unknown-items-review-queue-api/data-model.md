# Data Model — 007 Unknown Items Review Queue API

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Created**: 2026-05-29

> **007 introduces NO new schema, table, column, index, migration, or RLS policy.** It is a read/projection + action-dispatch surface over entities 003/005 already own. This document is a **pointer + wire-projection** doc, mirroring 005's data-model precedent (which itself authored no schema).

---

## 1. Entities consumed (unchanged)

| Entity | Owner | 007 use |
|---|---|---|
| `unknown_items` | 003 §8 / 005 §2 | Listed, inspected, dismissed, reopened (fresh row), bulk-dismissed. No column added. |
| `tenant_products` | 003 §5 | Link target; created by create-from; referenced (conditionally) in FR-001a resolved-item detail. |
| `product_aliases` | 003 §6 | Created/reactivated by link/create-from (shipped). |
| Audit Event | 001 / 005 §6.9 | Emitted by every audited operation via the existing surface. No new category. |
| Idempotency Key/Record | 001 / 005 | Consumed by reopen + bulk-dismiss. No new primitive. |

## 2. Wire projections (the only 007 "model" work)

### 2.1 `ReviewQueueItem` (new projection — the load-bearing one)

`ReviewQueueItem` = the shipped `UnknownItem` wire schema **minus `sale_context`** (research §R1). Used by every 007 dashboard-review response: list-extension, inspect, FR-001a terminal detail.

| Field | Source | Notes |
|---|---|---|
| `id` | `unknown_items.id` | opaque UUIDv7 |
| `tenant_id`, `store_id` | row | store non-null per 005 FR-010 |
| `identifier_type`, `identifier_value` | row | 005-permitted display form |
| `source_system` | row | null unless `external_pos_id` |
| `resolution_status` | row | `pending` / `resolved` / `dismissed` |
| `resolution_action` | row | `linked` / `created` / `dismissed`, null when pending |
| `resolved_at`, `resolved_by` | row | terminal-only |
| `resolved_product_id` | row | **FR-001a conditional**: present only if caller may see the product; omitted otherwise (row still returned) |
| `encountered_at` | row | capture timestamp; age basis for sort/filter |
| ~~`sale_context`~~ | — | **OMITTED** in v1 (FR-007 / 006 FR-021a) |

### 2.2 FR-001a conditional product reference

For a `resolved` item, `resolved_product_id` (and any product identifying detail) is included **only if** the caller has authority to see that product; otherwise it is omitted while the item row remains visible (the unknown-item record's existence in scope is already established per 005 SI-004). The suppression mechanism (omit field) is the chosen form.

### 2.3 Bulk-dismiss per-item outcome shape

A bulk-dismiss response carries one outcome per submitted id: `{ id, outcome }` where `outcome` is `dismissed` | one of the FR-100 failure categories (`already-reconciled` with optional `details.prior_state`, `not-found`). No cross-item coupling.

## 3. State transitions (consumed unchanged; reopen clarified)

```text
            posCaptureItem (005, POS)
                   │
                   ▼
                pending ──── dismiss ───▶ dismissed (terminal, 005 FR-004)
                   │                          │
        link / create-from                    │ reopen (007, tenant-wide only)
                   │                          ▼
                   ▼                   creates a NEW pending row
                resolved (terminal)    (005 FR-005); the dismissed
                                       row is preserved unchanged
```

- **Reopen is not an edge in this graph on the original row.** It is a fresh `pending` insert for the same logical identifier (research §R2). The monotonic invariant (Constitution §IX / 005 FR-004) is preserved.
- 007 adds **no** new lifecycle state (006 FR-010/FR-011).

## 4. RLS posture (inherited, unchanged)

All 007 reads/writes run under the active tenant GUC (`app.current_tenant`) per 003/005. Cross-tenant → zero rows (non-disclosing 404). Store scope enforced per 003 §8 / 005 FR-014. 007 adds no policy.

## 5. What 007 does NOT introduce

No table, column, index, migration, RLS policy, lifecycle state, audit category, observability signal, auth model, or idempotency primitive. The only new artifacts are wire projections (§2) and the operations that return them.
