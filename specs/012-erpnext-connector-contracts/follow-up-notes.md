# Follow-up Notes — 012

**Feature**: 012-erpnext-connector-contracts
**Status**: Draft — forward references only
**Date**: 2026-06-04

> Records what 012 **names but does not create/register**, and how 012 feeds the
> rest of the ERPNext arc (013–017).

---

## 1. Outbox event type — NAMED, not registered

The pull-feed of pending postings is driven by a posting outbox event. Per the
[outbox event-type registry](../../docs/outbox/event-types.md), **adding an event
type is a separate approval PR** and MUST NOT be introduced as a side-effect.

- **Proposed name** (forward reference): **`erpnext.posting.requested`**
  (dot-namespaced by domain, matching the registry convention).
- **Producer** (future): the 008/sales write path (or a backfill), emitted
  in-transaction with the sale fact — the posting decision's async/outbox model.
- **Consumer** (future): DP2's feed-builder that exposes the pending posting to
  the connector's pull (012 contract).
- **Registration**: happens in its **own approval PR** against
  `docs/outbox/event-types.md` **when 015 needs it** — NOT in 012.

012 only **names** it so the contract obligations (O-1) have a stable referent.

---

## 2. How 012 feeds 013–017

| Spec | What it builds on the 012 seam |
|---|---|
| **013** product-master-from-erpnext | Resolves sale-line items to ERPNext Items (the mapping behind O-1's work-item) |
| **014** branch-inventory-reconciliation-and-warehouse-mapping | Maps store/branch → ERPNext Warehouse; reconciliation over the 012 outcome data |
| **015** pos-sale-posting-to-erpnext | Implements the posting logic + the `[GATED]` 012-CONTRACT OpenAPI YAML + registers `erpnext.posting.requested` |
| **016** tax-and-fiscal-egypt-v1 | Populates O-2's ETA status/UUID passthrough via the connector's ETA adapter |
| **017** sync-ops-and-repair-api | Surfaces + repairs the DP2-owned DLQ + reconciliation state the 012 outcomes feed |

---

## 3. Gated / separate follow-ups (NOT in this PR)

- **`[GATED]` OpenAPI YAML** — `packages/contracts/openapi/erpnext-connector/…`,
  authored in a later 012-CONTRACT slice (the 008-CONTRACT / 010-CONTRACT analogue).
- **Connector repo creation** — gated by ADR 0008 acceptance.
- **`erpnext.posting.requested` registration** — separate approval PR when 015 lands.
- **New ERPNext/Frappe client dependency** — `[GATED]` `package.json` (version-pin decision).
