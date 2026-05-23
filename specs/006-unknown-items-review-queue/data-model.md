# Phase 1 Data Model: Unknown Items Review Queue

**Feature ID**: 006
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Created**: 2026-05-23

> **006 introduces no new schema** (no new tables, columns, indexes, or constraints) **but does pin user-visible projection obligations** the future API feature must produce from existing entities (per spec FR-001a, FR-020..022 + FR-021a). This document is in two parts: §1 lists the entities consumed verbatim from 005 / 003 / 001; §2 specifies the wire-projection obligations (queue list item, inspection detail, action request / response shapes). The future API feature's plan will produce its own data-model.md translating these obligations into concrete DTOs against 005's then-current service surface.

---

## 1. Consumed entities (no changes)

| Entity | Owning spec | Source file | What 006 uses it for |
|---|---|---|---|
| `unknown_items` | 003 §6 (schema), 005 §6 (workflow) | `packages/db/src/schema/catalog/unknown-items.ts` | The queue **is** a projection over this table. 006 reads `pending`, `resolved`, `dismissed` rows scoped per actor authority. No writes by 006 itself; writes happen via 005's reconciliation surface. |
| `tenant_products` | 003 §5 | `packages/db/src/schema/catalog/tenant-products.ts` | Target of `link to existing product` (FR-040..043). Created by `create new product` (FR-050..052, via 005 FR-060..063). |
| `product_aliases` | 003 §6 | `packages/db/src/schema/catalog/product-aliases.ts` | Written / reactivated as a side-effect of link / create reconciliation (consumed via 005 FR-050 / FR-061). Read for candidate-match hints (FR-080). |
| `audit_events` | 001 (audit pipeline) | `packages/db/src/schema/audit-events.ts` (or 001-equivalent) | Every review action emits here via 005's existing audit pipe (FR-110..113). 006 introduces no new event subjects, only consumes the ones 005 plan §3.3 anticipates. |
| `outbox_events` | 001 | `packages/db/src/schema/outbox-events.ts` (or 001-equivalent) | Audit fanout transport. Same posture as 005 — append-only via AuditEmitter interceptor. |
| `memberships`, `stores`, `tenants` | 001 | (existing schema) | Authority resolution for FR-001..005, FR-062a, SI-001..009. |
| `unknown_items.sale_context` (JSONB column) | 003 §8 | `packages/db/src/schema/catalog/unknown-items.ts:45` (per 005 plan §4.1) | **Read but NOT surfaced in v1** per FR-021a. The future the future API feature query layer reads the row but the response projection MUST NOT include any field from this column. |

**Net**: zero schema authorship by 006.

---

## 2. User-visible projection obligations (for the future API feature)

The future the future API feature API feature is **obligated** to produce the following projections from the entities above. These are obligations, not designs — the future API feature's plan will pin the wire shape (per Constitution §IV "API responses MUST NOT return raw database entities"). 006 only fixes what fields must / must not appear.

### 2.1 Queue list item (pending) — minimum safe surface per FR-020

| Field | Type | Source | Notes |
|---|---|---|---|
| `unknown_item_id` | UUID | `unknown_items.id` | Stable, opaque to client. Required for action dispatch. |
| `identifier_type` | enum (e.g., `barcode`, `sku`, `plu`, `supplier_code`, `external_pos_id`) | `unknown_items.identifier_type` | Per 003 §6 alias rules. |
| `identifier_value` | string | `unknown_items.identifier_value` | Catalog reference data, not PII (per 005 SI-007). |
| `source_system` | string nullable | `unknown_items.source_system` | Required for `external_pos_id`; optional otherwise (per 003 §6). |
| `store_id`, `store_name` | UUID, string | `unknown_items.store_id` + `stores` join | Only when actor has access to that store; otherwise the row is not visible at all (per FR-002, SI-002). |
| `captured_at` | timestamp | `unknown_items.created_at` (or 005's chosen name) | Reviewer's local timezone display is a the future UI feature (Impeccable) concern. |
| `lifecycle_state` | enum `pending` | (filtered) | Default queue is `pending` only (FR-001). |
| `advisory_hints` | object nullable | derived | Optional. MAY contain `previously_dismissed_count`, `reopened_from_prior_dismissal`. MUST NOT contain any cross-scope detail (per FR-012, FR-022, SI-004). |

**MUST NOT appear** in this projection:
- Any field from `unknown_items.sale_context` (FR-021a / FR-022).
- Any out-of-scope store / tenant detail (SI-001, SI-002).
- Any candidate-match data sourced from out-of-scope products (FR-041; FR-082 is a sibling rule for cross-store duplicate *indicators*).
- Any field redacted by 005 / 003 at the logger boundary (FR-022).

### 2.2 Queue list item (terminal — resolved / dismissed) — per FR-001a

When the actor filters to `resolved` or `dismissed`:

| Field | `dismissed` | `resolved` |
|---|---|---|
| Identifier metadata (type / value / source_system) | ✓ | ✓ |
| Capture store (when in scope) | ✓ | ✓ |
| Capture timestamp | ✓ | ✓ |
| Lifecycle state | ✓ | ✓ |
| Resolution / dismissal timestamp | ✓ (`dismissed_at`) | ✓ (`resolved_at`) |
| Resolving / dismissing actor | ✓ | ✓ |
| `resolution_action` | N/A | ✓ (`linked` or `created`) |
| Target product reference | N/A | ✓ **only if actor has authority to see that product**; otherwise the field is suppressed and the row renders the resolution action without target detail (per FR-001a + 005 SI-004) |

### 2.3 Inspection-view detail — per FR-020, FR-021, FR-080

Same fields as the queue list item, plus:

- `candidate_matches` *(optional in v1 per FR-080 / contracts/README §2.8)*: when present, an array of in-scope candidate `tenant_products` for this identifier (per FR-080). MUST be sourced strictly within the actor's authorized scope (FR-041, SI-004). MAY be empty; an empty array MUST NOT render a "no candidates found" message that hints at out-of-scope state (FR-080 last sentence). When the field is **omitted entirely** from the response, that means the v1 surface does not expose the hint — it does NOT mean "no candidates exist."
- `advisory_hints` (richer than list view; same scope constraints).

**Still MUST NOT appear**:
- Any `sale_context` field (FR-021a).
- Any out-of-scope candidate.
- Any field that would let the actor infer the existence of out-of-scope records (FR-090, SI-004).

### 2.4 Action request bodies (per spec §6.5–§6.7)

| Action | Body fields the future API contract must accept | Body fields that MUST NOT be accepted |
|---|---|---|
| `link to existing product` | `unknown_item_id`, `target_product_id` (server re-resolves authority) | `tenant_id`, `store_id`, anything that would mass-assign (Constitution §XII) |
| `create new product from unknown item` | `unknown_item_id`, minimal product fields per 005 FR-060 / 003 §5 | `tenant_id`, `store_id`, `resolution_action`, audit fields (Constitution §XII) |
| `dismiss` | `unknown_item_id` (optionally a free-form `reason` if the future API feature chooses to support one — out of scope here) | `tenant_id`, `store_id`, `lifecycle_state`, audit fields |
| `bulk dismiss` | array of `unknown_item_id` (≤ 200 per FR-070) | same forbidden fields as `dismiss` |
| `reopen` | `unknown_item_id` (tenant-wide actors only per FR-062a) | `tenant_id`, `store_id`, `lifecycle_state`, audit fields |

### 2.5 Action response bodies — per FR-091, FR-100

On success, the response body shape is the future API feature's decision. The minimum 006 requires:

- A deterministic reference to the new / updated row(s) (the resolved unknown-item, the linked / created product, etc.).
- No leakage of out-of-scope state (per SI-004).
- Idempotent on retry (per Constitution §XI; the future API feature applies the existing idempotency interceptor).

On failure, the canonical error envelope (`{ error: { code, message, request_id, details? } }` per Constitution §III) MUST use one of the eight category values enumerated in [research.md §R4](./research.md) (revised 2026-05-24):

`validation` | `target-unavailable` | `alias-conflict` | `idempotency-token-mismatch` | `already-reconciled` | `not-found` | `forbidden` | `system-failure`

`already-reconciled` absorbs the prior `already-terminal` case via an optional `details.prior_state` discriminator. `forbidden` covers FR-062a's in-scope-but-no-reopen-authority case (Constitution §II / §XII permit `403`).

---

## 3. RLS posture (consumed unchanged)

006 introduces **no RLS amendment**. All visibility decisions consume the policies established in:

- 003 migration `0007_catalog.sql` — base RLS for `unknown_items`, `tenant_products`, `product_aliases`.
- 003 migration `0008_catalog_store_read_isolation.sql` — cross-store read fix.
- 003 migration `0009_catalog_store_empty_guc_fix.sql` — store-GUC empty-string guard.
- 003 migration `0010_catalog_tenant_empty_guc_fix.sql` — tenant-GUC empty-string guard.
- 001's `runWithTenantContext` / `withTenant` helpers — the future API feature will use these for every query.

the future API feature's data-model.md will document its query patterns against these policies; 006 only commits that the queue surface MUST use them with no bypass.

---

## 4. State transitions (consumed unchanged from 005 + 003)

006 introduces no new state. The closed set is per 005 FR-001 / 003 §6:

```text
        ┌──────────┐
POS ──▶ │ pending  │ ──link──▶ ┌───────────────────────┐
        └──────────┘            │ resolved (linked)     │
              │                 └───────────────────────┘
              │     ──create──▶ ┌───────────────────────┐
              │                 │ resolved (created)    │
              │                 └───────────────────────┘
              │
              └─────dismiss──▶  ┌───────────────────────┐
                                │ dismissed (terminal)  │
                                └───────────────────────┘

User-facing "reopen" (FR-061, tenant-wide actors only per FR-062a) does NOT transition
the dismissed row. It creates a fresh `pending` record at the same (tenant, store,
identifier) tuple via 005 FR-005. Prior `dismissed` row preserved as audit history.
```

All transitions are monotonic per 005 FR-004. 006 commits to never displaying a transition the lifecycle does not allow.

---

## 5. Audit event subjects (consumed unchanged from 005)

Per FR-110..113, all review actions emit through 005's audit pipe. Subjects (anticipated per 005 plan §3.3):

- `unknown_item.captured` (emitted by 005 capture path; emitted again on reopen-triggered fresh-pending creation per US8)
- `unknown_item.resolved.linked` (006 link action)
- `unknown_item.resolved.created` (006 create-new action)
- `unknown_item.dismissed` (006 dismiss action)
- `unknown_item.reconciliation_conflict_rejected` (006 conflict-failure audit per FR-111)
- `unknown_item.idempotency_mismatch_rejected` (005 capture-path; rarely 006-facing)
- **Reopen-specific subject** — the future API feature may choose `unknown_item.reopened` as a distinct audit subject or may rely on the captured + correlated `unknown_item.captured` event for the fresh-pending row. 006 takes no position; both satisfy FR-110.

006 introduces no new subjects.

---

## Summary

006 contributes **zero schema artifacts** and instead pins **wire-projection obligations** the future API feature must honor. The obligations are testable from the spec's acceptance scenarios (§5) and isolation requirements (§7). The future API feature's data-model.md will translate these obligations into concrete DTOs against 005's then-current service surface.
