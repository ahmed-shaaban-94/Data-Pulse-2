# Contracts — 005 POS Catalog Sync & Unknown Item Reconciliation

**Status**: Placeholder only — final OpenAPI YAML deferred to a gated slice.
**Plan**: [../plan.md](../plan.md) | **Spec**: [../spec.md](../spec.md)
**Created**: 2026-05-23

---

## Why this directory is empty (no `*.yaml` files)

The 005 planning brief (and the spec's §3 / §12 Non-Goals) explicitly defer final OpenAPI contract authoring out of `/speckit-plan` scope. Per Constitution §IV and §VIII, and per Standing Rules §3, `packages/contracts/openapi/**` is a `[GATED]` surface that requires explicit per-slice approval before any tool edits it.

This directory exists as a **structural placeholder** so `/speckit-tasks` can refer to "the contracts folder for 005" without ambiguity, and so the eventual contract slice has a sibling location for any 005-local contract notes that don't belong in `packages/contracts/openapi/`.

**Do not author OpenAPI YAML files here.** The canonical contract location for the eventual POS capture and reconciliation endpoints is `packages/contracts/openapi/catalog/` (path subject to confirmation by the contract slice itself).

---

## Contract obligations the eventual YAML must satisfy

For the eventual contract author, this section enumerates what the OpenAPI YAML at `packages/contracts/openapi/catalog/unknown-items.yaml` (or wherever the contract slice locates it) MUST satisfy. These are derived from the spec's FRs and the implementation plan; they are **not** themselves the contract.

### Anticipated operationIds

| operationId | Purpose | Spec FRs |
|---|---|---|
| `posCaptureItem` | POS submits an item reference; SaaS captures or resolves. | US1 entire; FR-001–FR-005, FR-010–FR-015, FR-020–FR-022, FR-021a–FR-021c, FR-030–FR-032, FR-070–FR-072 |
| `tenantAdminListUnknownItems` | Tenant admin / store manager lists pending unknown items. | US2 #4, FR-014, FR-015 |
| `tenantAdminLinkUnknownItem` | Tenant admin links an unknown item to an existing tenant product. | US2 #1, FR-050–FR-053 |
| `tenantAdminCreateProductFromUnknownItem` | Tenant admin creates a new tenant product from an unknown item. | US2 #2, FR-060–FR-063 |
| `tenantAdminDismissUnknownItem` | Tenant admin dismisses an unknown item as invalid. | US2 #3, FR-003 |

### Idempotency

- Every `posCaptureItem` request MUST accept a request-level idempotency token consistent with 002's POS contract.
- Token semantics: keyed by `(tenant_id, device_id, token)`; honored for ≥24h from first observation; payload-mismatch within TTL → 409-class `idempotency-token-mismatch`.

### Failure response taxonomy

Every operation MUST emit failure responses mapped to one of FR-091's 7 categories. See [`research.md §R2`](../research.md#r2--failure-mode-taxonomy-mapping-each-failure-to-fr-091-categories) for the full failure-to-category table.

### Non-disclosure invariants

Cross-tenant and out-of-scope requests MUST return a non-disclosing 404-class outcome that does NOT reveal whether the target exists (SI-001, SI-004, FR-013, FR-092).

### Audit obligations

Every state transition emits an audit event with `correlation_id` (FR-080–FR-083). The contract should document the audit event subjects (`unknown_item.captured`, `unknown_item.resolved.linked`, `unknown_item.resolved.created`, `unknown_item.dismissed`, `unknown_item.reconciliation_conflict_rejected`, `unknown_item.idempotency_mismatch_rejected`) as part of its API behavior, even though they are not response payloads.

### Performance obligation

`posCaptureItem` MUST satisfy SC-008: `p95 ≤ 500 ms`, `p99 ≤ 1 s` at the SaaS boundary, measured server-side excluding POS network egress. The contract MAY include an explicit SLA note.

### Optional descriptive metadata

Per FR-006 / FR-006a, the contract MAY accept opportunistic POS-supplied descriptive metadata, but it MUST be:
- Optional (omission is valid).
- Non-identity (does not participate in idempotency keys or resolution).
- Non-matching (does not drive any automated decision).
- Carried in a structure that maps into `unknown_items.sale_context jsonb` (no new typed field).

---

## When this README becomes obsolete

When the gated contract slice ([plan.md §8.3](../plan.md#83-gated-contract-slice-separate-lands-before-either-waves-implementation)) lands and the actual YAML is authored under `packages/contracts/openapi/catalog/`, this README's "Contract obligations" section MAY be retired (or kept as a cross-reference). The README itself stays — it documents the deferral decision for future archaeology.
