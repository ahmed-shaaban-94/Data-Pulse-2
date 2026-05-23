# Data Model — 005 POS Catalog Sync & Unknown Item Reconciliation

**Phase**: 1 (design — data shapes)
**Status**: Draft (read-only consumer of 003)
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

> **005 introduces ZERO new entities, columns, indexes, constraints, or RLS
> policies.** This document maps 005's functional requirements to 003's
> existing entities and columns. The authoritative entity definitions live
> in `specs/003-catalog-foundation/data-model.md` — this document does not
> duplicate them, it points at them.

---

## 1. Entities consumed by 005

All three entities below are defined in `specs/003-catalog-foundation/data-model.md`. 005 reads and writes them; 005 does **not** redefine them.

| Entity | 003 location | 005 access pattern |
|---|---|---|
| `unknown_items` | 003 data-model.md §8 | INSERT on capture (FR-001, FR-030–FR-032); UPDATE on lifecycle transition (FR-002, FR-003, FR-004, FR-050, FR-061); SELECT for review queue (US2). |
| `product_aliases` | 003 data-model.md §6 | SELECT for capture-time resolution (FR-030, FR-030a, FR-031); INSERT on link (FR-050) and create-new (FR-061); UPDATE for retired-alias reactivation (Edge Cases — "Reactivating a previously retired alias"). |
| `tenant_products` | 003 data-model.md §5 | SELECT for link-target validation (FR-050a, FR-051); INSERT on create-new reconciliation (FR-061); read-only otherwise. |

005 also reads — but does not write — three 001-owned entities for principal resolution: `tenants`, `stores`, `memberships`. No write path.

---

## 2. FR-to-column mapping

This is the load-bearing artifact of this document — it gives the eventual `/speckit-tasks` implementer a direct lookup table from each FR to the 003 columns it touches.

### 2.1 Lifecycle (FR-001 through FR-005)

| FR | Read columns | Write columns | Constraint relied upon (003) |
|---|---|---|---|
| FR-001 (lifecycle states `pending`/`resolved`/`dismissed`) | `unknown_items.resolution_status` | `unknown_items.resolution_status` | `CHK unknown_items_resolution_status_valid` |
| FR-002 (pending has null resolution fields; resolved/dismissed has full) | `resolution_status, resolved_at, resolved_by, resolution_action` | same | `CHK unknown_items_resolved_fields_consistent` |
| FR-003 (`resolution_action ∈ {linked, created, dismissed}`) | `resolution_action` | `resolution_action` | `CHK unknown_items_resolution_action_valid` |
| FR-004 (monotonic transitions only) | `resolution_status` (precondition: `= 'pending'`) | `resolution_status` | enforced at service layer via WHERE clause on UPDATE; no DB constraint needed because 003 already prohibits going backwards via the `_resolved_fields_consistent` CHK |
| FR-005 (post-dismiss resubmit → fresh row) | n/a | new `unknown_items` row (INSERT, not UPDATE) | n/a — this is service-layer behavior; the dismissed row is read but not modified |

### 2.2 Tenant + store scoping (FR-010 through FR-015)

| FR | Read columns | Write columns | Constraint relied upon (003) |
|---|---|---|---|
| FR-010 (non-null tenant_id + store_id) | `unknown_items.tenant_id, store_id` | same | `tenant_id NOT NULL`, `store_id NOT NULL` |
| FR-011 (reject submissions with no store binding) | n/a | n/a | service-layer validation against the principal's resolved store from 001/002 |
| FR-012 (visibility via 003 RLS) | n/a | n/a | RLS policies `unknown_items_tenant_isolation`, `unknown_items_store_read`, `unknown_items_insert`, `unknown_items_resolve` (003 §8 + 0008 + 0009 + 0010) |
| FR-013 (cross-tenant non-disclosing) | n/a | n/a | RLS returns 0 rows; service returns 404-class non-disclosing |
| FR-014 (store-scoped operator sees only own-store items) | n/a | n/a | `unknown_items_store_read` policy |
| FR-015 (cross-store reconciliation only with tenant-wide authority) | `memberships.role` (001-owned) | n/a | service-layer check against existing 001 membership model |

### 2.3 Idempotency (FR-020 through FR-022)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-020 (at most one `pending` per logical identifier) | `unknown_items.{tenant_id, store_id, identifier_type, value, source_system, resolution_status}` | n/a (read-then-insert with the partial index as serialization point) | `idx_unknown_items_lookup_value` (003 §8) — partial index on `(tenant_id, identifier_type, value) WHERE resolution_status = 'pending'` |
| FR-021 / FR-021a / FR-021b / FR-021c | 001's `idempotency_keys` table (read), 005's `PosCaptureIdempotencyService` (wrap) | 001's `idempotency_keys` (write) | 001's existing primary key + TTL — no 003 surface touched |
| FR-022 (resolved identifier → resolved-product outcome, no new unknown row) | `product_aliases` for resolution; `tenant_products` for the target | n/a | `idx_product_aliases_lookup` |

### 2.4 Duplicate detection on capture (FR-030 through FR-032)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-030 (resolve against active alias set) | `product_aliases.{tenant_id, identifier_type, value, source_system, store_id, retired_at, product_id}` | n/a | partial unique indexes `UQ_idx_product_aliases_tenant_wide`, `UQ_idx_product_aliases_external_pos_id`, `UQ_idx_product_aliases_store_scoped` (003 §6) — all filter on `retired_at IS NULL` |
| FR-030a (store-scoped alias to other store does NOT resolve at this store) | same as FR-030 + `product_aliases.store_id` | n/a | service-layer WHERE clause: `store_id IS NULL OR store_id = $current_store` |
| FR-031 (resolved → no unknown row) | n/a | n/a | service-layer guard |
| FR-032 (pending row exists for same logical id → return that row) | `unknown_items` filtered to `resolution_status = 'pending'` | n/a | `idx_unknown_items_lookup_value` |

### 2.5 Alias uniqueness + conflict (FR-040 through FR-043)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-040 (003 alias uniqueness rules are canonical) | n/a — referential | `product_aliases` writes only via 003's eventual `ProductAliasesService` (T383) | three partial unique indexes (see FR-030) |
| FR-041 (uniqueness violation → fail closed) | n/a | n/a | the partial unique indexes themselves raise `unique_violation` on conflicting INSERT; the service catches and translates to 005's `alias-conflict` outcome (FR-091) |
| FR-042 (non-disclosing conflict response) | n/a | n/a | service-layer error shape |
| FR-043 (emit `duplicate_alias_conflict` metric) | n/a | n/a | inherits 003 §9 signal |

### 2.6 Link reconciliation (FR-050 through FR-053)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-050 (link U → P, create/reactivate alias, transition U to resolved) | `tenant_products.{id, tenant_id, status}` (verify P active); `unknown_items.*` (verify U pending) | `product_aliases` (INSERT or UPDATE retired→active); `unknown_items.{resolution_status, resolved_at, resolved_by, resolution_action, resolved_product_id}` (UPDATE) | partial uniques on aliases; CHK `unknown_items_resolved_fields_consistent`; CHK `unknown_items_linked_product_present` |
| FR-051 (P retired/deleted → target-unavailable) | `tenant_products.status` | n/a | service-layer check; no DB-level constraint needed |
| FR-052 (alias conflict → fail closed) | n/a | n/a | partial unique indexes (FR-041) |
| FR-053 (transactional) | n/a | both `product_aliases` and `unknown_items` in one `db.transaction` block | Postgres transaction semantics |

### 2.7 Create-new reconciliation (FR-060 through FR-063)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-060 (minimal product fields per 003 §5) | n/a | `tenant_products` (INSERT — fields per 003 §5) | 003's `tenant_products` schema constraints |
| FR-061 (create P + create alias + transition U) | n/a | `tenant_products` (INSERT); `product_aliases` (INSERT); `unknown_items` (UPDATE) | same as FR-050 |
| FR-062 (alias conflict → fail closed; P also not created) | n/a | n/a — both rolled back | transaction semantics |
| FR-063 (transactional) | n/a | three writes in one `db.transaction` block | Postgres transaction semantics |

### 2.8 Malformed payloads (FR-070 through FR-072)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-070 (missing required fields) | n/a | n/a | Zod `.strict()` at controller boundary |
| FR-071 (malformed values: length, type, source_system) | n/a | n/a | Zod schemas matching 003's CHKs (`unknown_items_value_length`, `unknown_items_identifier_type_valid`, `unknown_items_source_system_required`) |
| FR-072 (rejection is observable, raw values not logged) | n/a | n/a | service-layer log redaction; raw value never enters log line |

### 2.9 Audit and observability (FR-080 through FR-083)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-080 (every transition → audit event) | n/a | `audit_events` (001) via interceptor | 001's `AuditEmitter` |
| FR-081 (signal names conform to 003 §9) | n/a | n/a | 003 §9 catalog signal naming |
| FR-082 (failed reconciliations also audited) | n/a | `audit_events` | 001's `AuditEmitter` |
| FR-083 (events retrievable via 003's audit-query surface) | `audit_events` | n/a | 003's audit query inherits 001's |

### 2.10 User-visible outcomes (FR-090 through FR-092)

| FR | Read columns | Write columns | Constraint relied upon |
|---|---|---|---|
| FR-090 (deterministic outcomes) | n/a | n/a | service contract |
| FR-091 (failure category taxonomy) | n/a | n/a | service contract — see [research.md §R2](./research.md) for full taxonomy |
| FR-092 (no existence-leakage) | n/a | n/a | RLS + service-layer 404-class for all out-of-scope |

---

## 3. RLS posture (inherited from 003)

005 introduces **no new RLS policies**. The existing 003 policies on `unknown_items`, `product_aliases`, and `tenant_products` cover every 005 access path:

| Policy (table.policy_name) | Source migration | What it gates for 005 |
|---|---|---|
| `unknown_items.unknown_items_tenant_isolation` | 0007 | Every 005 SELECT on `unknown_items`. |
| `unknown_items.unknown_items_store_read` | 0007 (combined in 0008) | Store-scoped operator SELECTs (FR-014). |
| `unknown_items.unknown_items_insert` | 0007 (CASE-guarded in 0010) | Every 005 capture INSERT (FR-001, FR-030–FR-032). |
| `unknown_items.unknown_items_resolve` | 0007 (CASE-guarded in 0010) | Every 005 lifecycle UPDATE (FR-050, FR-061, FR-003 dismiss). |
| `product_aliases.*` | 0007 | Every 005 alias read + write. |
| `tenant_products.*` | 0007 (CASE-guarded in 0010) | Every 005 product read + the create-new INSERT. |

005 service code MUST use `runWithTenantContext(...)` from 001's helpers for every operation. No raw pool access. Workers (audit-fanout) already operate under the same posture per 001.

---

## 4. State transitions for `unknown_items`

The state machine 005 implements is exactly 003's, with no extensions. Diagrammatically:

```
        ┌────────────┐
        │ (initial)  │
        └─────┬──────┘
              │ POS submits unidentified identifier
              │ (FR-001, FR-010, FR-030, FR-070-072 validation pass)
              ▼
        ┌────────────┐
        │  pending   │
        └─────┬──────┘
              │
              ├─────[FR-050 link]──────────┐
              ├─────[FR-061 create-new]────┤
              ├─────[FR-003 dismiss]───────┤
              │                            │
              ▼                            ▼
        ┌────────────┐              ┌────────────┐
        │  resolved  │              │ dismissed  │   ← both terminal (FR-004)
        │ ┌────────┐ │              │            │
        │ │ linked │ │              │            │
        │ ├────────┤ │              │            │
        │ │created │ │              │            │
        │ └────────┘ │              │            │
        └────────────┘              └────────────┘
                                         │
                                         │ POS resubmits same identifier
                                         │ at same (tenant, store)
                                         ▼ (FR-005)
                                  ┌────────────┐
                                  │ NEW pending│  ← brand-new row, dismissed row preserved
                                  │   row      │
                                  └────────────┘
```

**No `dismissed → pending` or `resolved → pending` transition exists.** FR-004 enforces monotonicity per row.

---

## 5. What 005 does NOT introduce

For the eventual `/speckit-tasks` author and reviewers, this is the explicit list of things 005 will NOT add to the data model:

- ❌ No new tables.
- ❌ No new columns on any existing table.
- ❌ No new indexes.
- ❌ No new CHECK constraints.
- ❌ No new foreign keys.
- ❌ No new RLS policies.
- ❌ No new redaction-matrix entries.
- ❌ No new SQL migration files.
- ❌ No edits to existing migrations 0007–0010.
- ❌ No edits to existing Drizzle schema files under `packages/db/src/schema/catalog/`.

If any of these are required to make 005 work, the planning premise is wrong and `/speckit-tasks` must stop and escalate.
