# Quickstart: Unknown Items Review Queue

**Feature ID**: 006
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Audience**: tenant admins, store operators, platform stakeholders, future UI designers running `/impeccable shape`
**Created**: 2026-05-23

> This walkthrough describes how the review queue *behaves* from a reviewer's point of view. It does **not** describe screens, buttons, layouts, copy, or visual treatment — those land in the future UI feature via Impeccable (spec §11). The point of this document is to make the spec's behavior concrete enough that a non-technical reviewer can validate it, and a UI designer can shape it.

---

## Scenario 1 — Tenant admin clears a small queue (happy path)

**Actor**: Alice, Tenant Admin for tenant T (tenant-wide authority).
**Pre-condition**: tenant T has 6 `pending` unknown items: 3 at store S1, 2 at S2, 1 at S3. T's catalog has 2 existing products: "Coca-Cola 330ml" and "Pepsi 330ml".

### Steps

1. **Alice opens the review queue.**
   - **Behavior** (spec US1): She sees all 6 pending items across S1, S2, S3, each row showing identifier metadata (barcode / SKU / etc.), source system, capture store, capture timestamp, and `pending` state.
   - **What she does NOT see**: any item from another tenant, any descriptive metadata text (FR-021a), any cross-store hints she shouldn't have.

2. **Alice filters to store = S1.**
   - **Behavior** (spec US3, FR-030): She sees 3 items. S2 and S3 are absent from this view.
   - **What is consistent**: counters, badges, the empty state of unused filter dropdowns — all reflect "filtered to S1" within her tenant scope.

3. **Alice opens item U1 — a barcode she recognises as Coca-Cola 330ml.**
   - **Behavior** (spec US4, FR-080): The inspection view shows U1's identifier metadata, capture store (S1), source system, capture timestamp. Because she's tenant-wide and the in-scope catalog has a product "Coca-Cola 330ml" that's a plausible match, the view surfaces a **candidate-match hint** listing that product as a possibility.
   - **What she does NOT see**: pre-selection (no checkbox pre-ticked), auto-link, descriptive text from the POS, or any product from another tenant.

4. **Alice links U1 to the existing "Coca-Cola 330ml" product.**
   - **Behavior** (spec US5, FR-040..043): U1 transitions to `resolved` with `resolution_action = linked`. A new alias is created (or a retired alias is reactivated) binding U1's barcode to "Coca-Cola 330ml". An audit event fires (`unknown_item.resolved.linked`).
   - **What she sees**: a clear success outcome; U1 is no longer in the `pending` view.

5. **Alice opens item U2 — a barcode for a new SKU "Sparkling Water 500ml" that isn't in the catalog.**
   - **Behavior** (spec US4, FR-080): No in-scope candidates → no candidate-match hint rendered. (FR-080 last sentence: do **not** render "no candidates found" — just omit the hint.)

6. **Alice creates a new product "Sparkling Water 500ml" from U2.**
   - **Behavior** (spec US6, FR-050..052): She supplies the minimal product fields 005 FR-060 requires. A new tenant product is created in T. An alias binds U2's barcode to the new product. U2 transitions to `resolved` with `resolution_action = created`. Two audit events fire (`tenant_product.created` from 003, `unknown_item.resolved.created` from 005). The whole operation is transactional (FR-063) — either all three commit or none.

7. **Alice opens item U3 — a test scan that should never have been captured.**
   - **Behavior** (spec US7, FR-060): She dismisses U3. U3 transitions to `dismissed`. No alias, no product. Audit event fires (`unknown_item.dismissed`).

8. **Alice continues through U4, U5, U6** — mix of link, create, dismiss.

9. **Alice's queue is now empty.**
   - **Behavior** (spec FR-034): She sees the "your scope is currently empty" empty state — distinguished from "no items match the current filter."

### Validation

After this scenario:
- `pending` count in T = 0.
- `resolved` count = 4 (2 linked, 2 created), `dismissed` count = 2.
- Audit log contains 6 success events + the implicit transactional events from the create-new path.
- No cross-tenant data was touched. (Verified by the isolation harness in the future the future API feature test extension.)

---

## Scenario 2 — Store operator scoped to S1 sees only S1's items

**Actor**: Bob, Store Operator for tenant T, scoped to store S1 only.
**Pre-condition**: same starting state as Scenario 1 (6 pending items across S1, S2, S3).

### Steps

1. **Bob opens the review queue.**
   - **Behavior** (spec US2, FR-002, SI-002): He sees only the 3 items at S1. S2's and S3's items are absent from listings, filters, counters, and any aggregate indicators.
   - **What he does NOT see** (per FR-022): no hint that other stores exist or that they have pending items. The store filter dropdown lists only S1.

2. **Bob attempts (by direct URL guess) to open an item that was captured at S2.**
   - **Behavior** (spec US2 #2, SI-004): The platform returns a non-disclosing not-found. Bob cannot tell whether the item exists.

3. **Bob links one of his S1 items to an existing product.**
   - **Behavior** (spec US5): Same as Alice — link succeeds within scope.

4. **Bob attempts to dismiss an item at S2.**
   - **Behavior** (spec US7 #4, SI-004): Non-disclosing not-found. The dismiss attempt is auditable as a failed attempt (FR-111).

5. **Bob attempts to reopen an item that was dismissed at S1 (within his scope).**
   - **Behavior** (spec US8 #4, FR-062a): **Refused** with the `forbidden` category (FR-100) — store-scoped operators MUST NOT reopen, even within their own scope. The rejection is auditable (FR-111).
   - **What Bob is told**: a deterministic message indicating he lacks the authority for this specific action ("tenant-wide authority required"). Because Bob already has read authority for the row (it's at S1), Constitution §II / §XII permit a `forbidden` rather than the `not-found` non-disclosure used for out-of-scope cases.

6. **Bob attempts to reopen an item that was dismissed at S2 (outside his scope).**
   - **Behavior** (spec US8 #5, FR-062a + SI-004): **Refused** with the `not-found` category — Bob has no read authority for S2, so the response cannot distinguish "exists but you can't reopen" from "does not exist."

### Validation

- Bob's view never exposed any S2/S3 detail by any means.
- Bob's dismiss / reopen attempts surfaced two distinct categories that match Bob's authority state: `not-found` for out-of-scope, `forbidden` for in-scope-no-role.
- Audit log records Bob's failed attempts as well as his successes.

---

## Scenario 3 — Alice reopens an item she dismissed in error

**Actor**: Alice, Tenant Admin (tenant-wide actor).
**Pre-condition**: U7 is `dismissed` at store S2; no other `pending` record exists for U7's identifier at (T, S2).

### Steps

1. **Alice filters the queue to `dismissed` (store S2).**
   - **Behavior** (spec FR-001a): She sees U7 with full in-scope detail — identifier metadata, capture store (S2), source system, capture timestamp, dismissal timestamp, dismissing actor.

2. **Alice realises the dismissal was wrong and reopens U7.**
   - **Behavior** (spec US8 #1, FR-061): A **fresh `pending` record U7'** is created at (T, S2) with the same logical identifier. U7 itself remains `dismissed` (terminal — FR-004 from 005 inherited by FR-011). U7' MAY carry an advisory marker referencing U7.
   - **Audit**: Two audit events fire — one for Alice's reopen action on U7, one for the implicit capture of U7' — both linkable to the same `correlation_id` (US8 #6).

3. **Alice filters back to `pending`. U7' is now visible.**
   - **Behavior**: Alice can now link, create-new, or dismiss U7' as she would any other pending item.

4. **Alice attempts to reopen U7 a second time, while U7' is still `pending`.**
   - **Behavior** (spec US8 #2, FR-063): Refused with an "already pending" outcome. No duplicate is created. Alice is pointed to U7' as the active record.

---

## Scenario 4 — Concurrent reconciliation race

**Actors**: Alice and Carol, both tenant admins.
**Pre-condition**: U8 is `pending` in tenant T. Both Alice and Carol are viewing U8 at the same moment.

### Steps

1. **Alice clicks "link U8 to product P1".** Carol, milliseconds later, **clicks "link U8 to product P2".**

2. **Behavior** (spec US5 #4, FR-100): Exactly one wins (say Alice). The other (Carol) receives an `already-reconciled` outcome. U8 has exactly one resolution record. No duplicate alias is created.

3. **Carol's view refreshes.** She sees U8 is now `resolved (linked)` — and, because P1 is in her authority, sees it linked to P1.

### Edge variant — Alice's authority for P1 ≠ Carol's authority for P1

If P1 is an in-scope product for Alice but somehow out-of-scope for Carol (rare, but possible via membership changes), per FR-001a the resolved-state view for Carol would still show `resolution_action = linked` but suppress P1's identity. No leakage.

---

## Scenario 5 — Bulk dismiss with the 200-item ceiling

**Actor**: Alice.
**Pre-condition**: Alice has selected 250 `pending` items to dismiss (test scans from a POS misconfiguration).

### Steps

1. **Alice submits a bulk-dismiss for all 250 items.**
   - **Behavior** (spec FR-070, SC-008): The platform rejects the submission with `error.code = validation` because the count exceeds 200. No partial-success — none of the 250 are dismissed.

2. **Alice splits her selection: she submits 200, then submits 50.**
   - **Behavior**: First submission succeeds (200 dismissed, 200 audit events). Second submission succeeds (50 dismissed, 50 audit events). Total: 250 dismissed.

3. **Within the 200-item submission, one item had been reconciled by a sibling admin moments earlier.**
   - **Behavior** (spec SC-008): That one item is reported as `already-reconciled` — if the sibling admin's action made it terminal, the response carries `details.prior_state` indicating that. The other 199 are dismissed successfully. The mixed-success outcome is reported per FR-100.

---

## How to use this quickstart

- **For stakeholders**: read through Scenarios 1–3. They cover the happy path, the isolation safety floor, and the recovery path. Confirm the spec produces the experience you expect.
- **For future UI designers (Impeccable shape)**: each scenario is a *flow* the UI must support. Visual treatment, copy, motion, and density are your call — the spec only fixes the safety boundaries the design must respect.
- **For future the future API feature API authors**: each scenario maps to one or more operationIds in [contracts/README.md](./contracts/README.md). Each scenario's "what the platform does NOT do" lines are conformance tests the future API feature's contract slice must add.

This quickstart does not replace spec §5 — it complements it. When in doubt, the spec governs.
