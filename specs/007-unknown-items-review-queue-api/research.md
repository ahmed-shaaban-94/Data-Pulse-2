# Phase 0 Research — 007 Unknown Items Review Queue API

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Created**: 2026-05-29

All decisions below resolve the planning unknowns. There were **no `NEEDS CLARIFICATION` markers** in the spec; this research instead pins the design decisions the extension requires, grounded in the shipped 005 surface.

---

## R1 — `sale_context` projection (LOAD-BEARING)

**Question**: The shipped `UnknownItem` schema (`packages/contracts/openapi/catalog/unknown-items.yaml` lines 704–711; runtime `unknown-items.controller.ts:168,225`) returns `sale_context`. 007 FR-007 + 006 FR-021a forbid surfacing descriptive metadata on the v1 review surface. How does 007 list/inspect avoid violating its own spec?

**Decision**: Define a distinct **`ReviewQueueItem`** wire projection = shipped `UnknownItem` **minus `sale_context`**. All 007 dashboard-review responses (list-extension, inspect, FR-001a terminal detail) use `ReviewQueueItem`. No 007 response echoes `sale_context`.

**Rationale**: FR-007/FR-021a are MUST. The cheapest compliant design is a projection that omits the field — no schema change, no redaction machinery, just a narrower wire shape (Constitution §IV "no raw DB entities; explicit wire projection" already requires per-surface projections).

**Pre-existing-surface flag (for `/speckit-tasks` → human decision)**: Whether the *already-shipped* `tenantAdminListUnknownItems` over-discloses `sale_context` to the dashboard is a separate question. 006 (docs-only) post-dated the 005 contract and framed the field as "must-not-surface in v1," but the shipped contract framed it as "opaque advisory." Two options, both legitimate, neither chosen unilaterally by this plan:

- **(a) Tighten**: the new `ReviewQueueItem` supersedes the shipped list response (a behavior change to a live operation — requires sign-off + a contract version note).
- **(b) Isolate**: leave the shipped list response unchanged for backward-compat; only the *new* 007 operations (and any 007-extended list params) use `ReviewQueueItem`.

**Alternatives considered**: reuse `UnknownItem` unchanged (rejected — violates FR-007); add runtime redaction of `sale_context` at the logger only (rejected — that governs logs, not response bodies; the leak is in the body).

---

## R2 — Reopen mechanism + authority split

**Question**: 005's lifecycle is monotonic (`dismissed` terminal, FR-004). How does "reopen" work, and how does the tenant-wide-only authority (006 FR-062a) map to responses?

**Decision**: Reopen is **not** a lifecycle reversal. It creates a fresh `pending` `unknown_items` row for the same `(tenant, store, identifier_type, identifier_value, source_system)` tuple via the same mechanism 005 FR-005 already uses for any new evidence; the original `dismissed` row is preserved. Authority:

- Caller is tenant-wide (Admin/Owner) → proceed (subject to the "already pending" check, FR-043).
- Store-scoped operator, item **in scope** → `403 forbidden` (`error.code = forbidden`), message limited to "tenant-wide authority required."
- Store-scoped operator, item **out of scope** → `404 not-found` (non-disclosing).
- Item is `resolved` → `409 already-reconciled` with `details.prior_state = resolved`.
- A `pending` sibling already exists → "already pending" outcome pointing to it; no duplicate.

**Rationale**: Monotonic lifecycle (Constitution §IX / 005 FR-004) forbids un-dismissing. Fresh-`pending` is the only model that preserves it. The `403`-vs-`404` split is exactly Constitution §II/§XII: `404` when the principal has no read authority for the row (cannot learn it exists); `403` when the principal *can* see the row but lacks the role for this action within the resolved tenant.

**Alternatives considered**: a true state reversal `dismissed → pending` (rejected — breaks monotonic lifecycle invariant); uniform `404` for both operator cases (rejected — 006 FR-062a explicitly wants the in-scope case to be `forbidden` so the operator learns "escalate to a tenant admin").

---

## R3 — Bulk-dismiss decomposition + ceiling enforcement

**Question**: How does bulk-dismiss (≤200 ids) behave, and where is the ceiling enforced?

**Decision**: The 200-id ceiling is enforced **at the batch boundary** — a submission of >200 ids is rejected whole with a `validation` failure and dismisses nothing (all-or-nothing at the ceiling). Within a valid batch, the operation **decomposes into N per-item dismiss operations** under the shipped `tenantAdminDismissUnknownItem` semantics (006 FR-070a): same `pending → dismissed` write, same `resolution_action = dismissed`, same per-item audit event. Per-item outcomes are **mixed-success**: each id reports `dismissed` (success), `already-reconciled` (terminal sibling, with `details.prior_state`), or `not-found` (out-of-scope) independently; one item's failure never affects another.

**Rationale**: 006 FR-070a is explicit that bulk-dismiss is a UX-layer batching, not a new lifecycle. Decomposition keeps the audit subject and lifecycle write identical to single dismiss, so if 005's dismiss semantics shift, the batch follows for free. Ceiling-at-boundary (reject-whole) vs. per-item-truncate matches 006 FR-070's "no partial-success state at the ceiling boundary."

**Alternatives considered**: a new bulk lifecycle transition (rejected — 006 FR-070a forbids a new audit subject); truncate-to-200 instead of reject (rejected — silent truncation hides dropped work, violates the "no silent caps" discipline).

---

## R4 — Error taxonomy extension (`forbidden`)

**Question**: The shipped error codes are 005 FR-091's 7 categories. 006/007 add an 8th (`forbidden`). How does 007 extend the taxonomy?

**Decision**: Extend the closed set to 8: `validation`, `target-unavailable`, `alias-conflict`, `idempotency-token-mismatch`, `already-reconciled`, `not-found`, `forbidden`, `system-failure`. `forbidden` maps to HTTP `403` and is used **only** for the in-scope reopen authority case (FR-042). The `already-reconciled` envelope MAY carry `details.prior_state`; the closed vocabulary otherwise stays fixed. The wire `error.code` strings reuse the shipped snake/kebab convention (the contract slice pins exact spellings; the existing YAML uses `already_reconciled`, `alias_conflict`, etc.).

**Rationale**: 006 FR-100 already defined this 8-category set; 007 realizes it at the contract. `403` for in-scope insufficient-role is constitutionally sanctioned (§II/§XII). Keeping the set closed protects every contract consumer from enum drift.

**Alternatives considered**: reusing `validation` for the authority case (rejected — input is well-formed; it's an authority failure, semantically `403` not `400`, per 006's 2026-05-24 revision note); a fresh `authority` code (rejected — 006 already named it `forbidden`).

---

## R5 — Isolation-harness extension

**Question**: How are the new operations covered for tenant/store isolation?

**Decision**: Extend the existing cross-tenant/cross-store sweep (003 T340 pattern, already extended by 005) with cases for inspect, reopen, and bulk-dismiss: (a) cross-tenant id → non-disclosing 404; (b) out-of-scope store id → non-disclosing 404; (c) in-scope reopen by store operator → `403 forbidden`; (d) bulk-dismiss mixed selection (in-scope pending / terminal / out-of-scope) → correct per-item outcomes with no cross-item leakage; (e) RLS bypass probe (wrong `app.current_tenant` → zero rows) for the new read; (f) malicious-override (body `tenant_id`/`store_id` on reopen/bulk-dismiss ignored). Testcontainers-backed (Constitution §VI).

**Rationale**: Constitution §VI requires every protected endpoint to be swept cross-tenant + cross-store with the canonical non-leaking response. The new operations are protected and must join the sweep before GREEN.

**Alternatives considered**: unit-test-only coverage (rejected — isolation is an integration concern per §VI; RLS behavior cannot be unit-tested).

---

## R6 — Idempotency: token-bearing vs monotonic-guard (LOAD-BEARING, twin of R1)

**Question**: 007 FR-063 wants *every* state-changing op to accept an idempotency token (SC-005: identical-replay-response). But the shipped YAML carries `Idempotency-Key` on `posCaptureItem` only — the dashboard mutating ops (dismiss/link/create) have none and rely on the monotonic `WHERE resolution_status='pending'` guard. Reusing them "unchanged" contradicts FR-063.

**Decision**: Two retry strengths.
- **No-duplicate-effect** — all state-changing ops, via the monotonic guard (a retry returns `already-reconciled`, never a second effect). Satisfied by the shipped link/create/dismiss as-is.
- **Identical-replay-response** — key-bearing ops only. The **new** reopen + bulk-dismiss carry `Idempotency-Key`; replay with same key+body returns the prior response; same key + changed body → `idempotency_key_conflict` (`409`).

**Wire mapping (T564 trap)**: the abstract FR-100 category `idempotency-token-mismatch` is the **same thing as** the shipped wire code **`idempotency_key_conflict`**, and the header is **`Idempotency-Key`** — NOT `Idempotency-Token`. 005 recorded the `Idempotency-Token` spec/quickstart drift as known issue **T564**; the 007 contract slice MUST NOT reintroduce it.

**Pre-existing-surface flag (for `/speckit-tasks` → human decision)**: whether to retrofit `Idempotency-Key` onto the shipped link/create/dismiss ops (a behavior change to live ops, needs sign-off). Not done unilaterally here — exactly the §R1 option-(a)/(b) shape.

**Rationale**: monotonic-guard already gives the safety floor (no double-apply) the constitution requires (§XI). Adding token-replay only where it's net-new (reopen/bulk-dismiss) keeps 007 additive and avoids silently changing a shipped op's response contract.

**Alternatives considered**: force a token onto all ops now (rejected — changes shipped behavior without sign-off, the thing §4.3/§4.6 exist to prevent); leave reopen/bulk-dismiss without tokens (rejected — they're net-new mutating ops; FR-063 + Constitution §XI want retry-safety with replay for new mutating endpoints).
