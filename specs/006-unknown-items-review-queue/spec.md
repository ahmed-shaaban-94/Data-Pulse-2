# Feature Specification: Unknown Items Review Queue

**Feature ID**: 006
**Short name**: unknown-items-review-queue
**Status**: Draft
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban
**Depends on**: [specs/005-pos-catalog-sync-reconciliation](../005-pos-catalog-sync-reconciliation/spec.md) (which itself depends on [specs/003-catalog-foundation](../003-catalog-foundation/spec.md))
**Constitution version**: 3.0.0 — primary touchpoints §II (multi-tenant RLS), §III (backend authority), §IV (contract-first), §IX (Source-of-Truth Model), §XII (object safety), §XIV (PII discipline)

---

## Clarifications

### Session 2026-05-23

- Q: What is the maximum count of items per bulk-dismiss submission (FR-070)? → A: 200 items max per submission. The platform MUST enforce this ceiling; submissions above it are rejected with a `validation` category outcome (per FR-100). (FR-070 updated.)
- Q: Which actors may perform the "reopen" action (US8 / FR-061)? → A: Tenant-wide actors only — Tenant Admin and Tenant Owner. Store-scoped operators MAY dismiss within their scope but MUST NOT reopen. Reopen is a correction-of-prior-judgment action that warrants tenant-level authority for second-pair-of-eyes review. (US8, FR-061, FR-062a, §4 Actors updated.)
- Q: What detail is surfaced when an authorized reviewer filters the queue to `resolved` or `dismissed` items? → A: `dismissed` items show full in-scope detail (identifier metadata, capture store, source system, capture and dismissal timestamps, dismissing actor). `resolved` items show identifier metadata, capture store, source system, timestamps, and resolution action (`linked` / `created`); the linked/created product reference is shown only if the actor has authority to see that product per 005 SI-004 — otherwise the product identity is suppressed and the row shows the resolution action without target detail. (FR-001a added.)
- Q: Does v1 surface (a) optional POS descriptive metadata from 005's `unknown_items.sale_context jsonb` and (b) advisory candidate-match hints inside the inspection view? → A: (a) Descriptive metadata MUST NOT be surfaced in v1 — reviewers rely on identifier metadata alone, consistent with 005 FR-006's non-identity / advisory-only framing. (b) Candidate-match hints MUST be surfaced in v1, sourced strictly within the actor's authorized scope per FR-041 and 005 SI-004, rendered as advisory only — no pre-selection, no auto-link. (FR-021 and FR-080 updated.)

---

## 0. Scope of This Spec

This spec is **product-level only**. It defines the user-facing review experience for unknown POS-sourced catalog items: what users see, what actions they can take, how those actions behave from the user's perspective, and what isolation / audit guarantees the experience must preserve.

This spec is **explicitly not**:

- A UI design or visual specification (no components, routes, pages, tables, modals, CSS, layout, design tokens).
- An API or contract specification (no endpoints, OpenAPI, DTOs).
- A backend or data-model specification (no schema, migrations, services, controllers, repositories, guards).
- A POS client specification (POS-side capture is owned by 005 / 002).
- Anything that mutates 003, 004, or 005's already-shipped or in-flight contracts.

Backend behavior for unknown-item capture, idempotency, lifecycle, audit, conflict resolution, and reconciliation semantics is owned by **specs/005-pos-catalog-sync-reconciliation** and is consumed here unchanged. Where a user-facing requirement depends on 005 behavior that is not yet implemented (005 Wave 1 is still progressing slice-by-slice as of 2026-05-23), this spec marks it as a dependency, not as work to be done in 006.

Future UI implementation will be routed through the Impeccable workflow (see §11) before any dashboard code lands.

---

## 1. Background & Why

005 defines *how* unknown POS-sourced items are captured, deduplicated, and reconciled at the platform level. It does not define *how authorized humans actually clear the queue* — what they see, what they can act on, how the experience stays safe across tenant and store boundaries, and how the workflow protects against accidental data leakage or unsafe reconciliation.

Without a product-level definition of the review experience:

- Tenant admins and store operators have no agreed expectation for what the queue exposes, what actions are safe, or what failure outcomes look like.
- Future UI design risks importing assumptions that violate §II (multi-tenant RLS), §XII (object safety), or §XIV (PII discipline) — for example, surfacing candidate-match hints sourced from stores the operator cannot see.
- Cross-actor edge cases (tenant admin vs. store operator visibility, concurrent reconciliation, stale queue views) have no canonical product answer.

This feature pins those expectations at the product level so that:

1. The eventual UI feature can be designed against a clear, isolation-aware UX contract.
2. The backend surface that 005 produces can be reviewed against the user-facing experience it must support.
3. Future Impeccable-led design rounds have a stable product foundation to critique, polish, and refine against.

---

## 2. Goals

- Define the **review queue's contents and visibility rules** by tenant and store access.
- Define the **information shown for each unknown item** at a level safe across isolation boundaries.
- Define the **filtering, sorting, grouping, empty-state, loading-state, and stale-state expectations** at a product level.
- Define the **user-facing meaning** of `link to existing product`, `create new product`, `dismiss`, and `reopen` actions — consuming 005's lifecycle semantics.
- Define **permission-aware outcomes** for tenant admins vs. store operators, including non-disclosing failures.
- Define **duplicate / conflict warning behavior** at the product level without prescribing implementation.
- Define **audit expectations** for every review action (consuming 005 §6.9).
- Define **bulk action expectations** only where they are safe and clearly constrained.
- Define the **future Impeccable workflow** so any later UI work is correctly routed.

## 3. Non-Goals

- No UI implementation: no React components, no dashboard routes, no pages, no tables, no modals, no CSS, no layout files, no design tokens.
- No final visual design, layout, typography, color, or motion decisions.
- No API endpoint design, no OpenAPI changes, no contract YAML, no DTOs.
- No DB schema changes, migrations, RLS amendments, or Drizzle/ORM changes.
- No NestJS modules, services, controllers, workers, guards, interceptors, or repositories.
- No POS-side behavior or client SDK shape.
- No changes to catalog foundation (003), POS identity (002), platform readiness (004), or reconciliation backend (005). 006 consumes them; it does not modify them.
- No analytics dashboards, reports, dbt models, ClickHouse views, Dagster jobs, observability dashboards, billing, or CI changes.
- No `plan.md`, `tasks.md`, `data-model.md`, `research.md`, or `contracts/` in this spec PR.
- No Impeccable shape/critique/audit/polish/clarify runs yet — this spec only declares that those steps must happen *before* UI implementation.

---

## 4. Actors

| Actor | Role in this workflow |
|---|---|
| **Tenant Admin / Tenant Owner** | Reviews and acts on unknown items across all stores in the tenant. Can link to existing products, create new products from unknown items, dismiss, and reopen. Reopen is restricted to this tenant-wide authority. All actions are auditable. |
| **Store Operator / Store Manager** | Reviews and acts on unknown items only for stores they have access to. Has the same action set as tenant-wide actors *within their scope* — link, create, dismiss — **except reopen**, which is reserved for tenant-wide actors only (per FR-062a). Cannot see, infer, or act on items captured at stores outside their scope. |
| **Platform Operator** | No tenant-scoped access. May see aggregate operational health signals (queue depth, capture rate) only at the platform level. MUST NOT see tenant-specific items, identifiers, descriptive metadata, or actor identities. Read/audit support role only if explicitly granted via existing platform tooling — this spec introduces no new platform read surface. |
| **POS Device / POS Backend** | Not a consumer of this experience. POS-side capture is owned by 005. Listed here only to clarify that POS devices do not interact with the review queue. |
| **Anonymous / unauthenticated** | No access whatsoever. |

This spec does **not** introduce a new permission, role, or membership model. It consumes 001's membership / scope model and 005's actor authority rules as-is.

---

## 5. User Scenarios & Testing *(mandatory)*

User stories are ordered by priority. P1 stories must all be present for the feature to deliver value; P2 stories are essential safety / completeness; P3 stories are convenience and quality of life.

### User Story 1 — Tenant admin reviews unknown items across permitted stores (Priority: P1)

A tenant admin opens the review queue and sees every `pending` unknown item captured in their tenant, across every store they have authority over. The queue shows enough safe context per item (identifier metadata, capture store, source system, age, lifecycle state, and — only where authority allows — advisory match / prior-dismissal hints) to decide what to do. The admin can act on any item within their authority.

**Why this priority**: This is the primary consumer of 005's capture pipeline. Without a queue for tenant-wide reviewers, the platform captures unknown items but cannot resolve them — 005's reconciliation paths become unreachable from a user perspective.

**Independent Test**: Pre-populate a tenant with `pending` unknown items at three stores. Sign in as a tenant admin. Verify: (a) all `pending` items across all three stores are visible; (b) each item carries identifier metadata, capture store, source system, age, and lifecycle state; (c) no items from other tenants appear by any means; (d) cross-tenant ids guessed from outside cannot resolve to a visible item.

**Acceptance Scenarios**:

1. **Given** a tenant admin authenticated to tenant T with tenant-wide authority, **and** tenant T has `pending` unknown items captured at stores S1, S2, S3, **When** the admin opens the review queue, **Then** every `pending` item across S1, S2, S3 is visible with its identifier metadata, capture store, source system, age, and lifecycle state.
2. **Given** the admin's queue is open, **When** an item is captured in tenant T while the admin is reviewing, **Then** the new item becomes available on the admin's next refresh (the platform does not require live-pushing it into the open view — see FR-090 stale-state handling).
3. **Given** the admin is signed in to tenant T, **When** they attempt to look up an item by an identifier from tenant T', **Then** the queue returns no result and the response is non-disclosing — the admin cannot tell whether the item exists in T'.

---

### User Story 2 — Store operator reviews unknown items only within authorized stores (Priority: P1)

A store operator opens the review queue and sees only `pending` unknown items captured at stores they have access to. Items captured at other stores of the same tenant are not visible, are not hinted at, and cannot be acted on — directly or indirectly. The operator can act on items within their store scope using the same action set as the tenant admin.

**Why this priority**: This is the safety boundary that makes the queue safe to expose to store-scoped roles. Without it, the queue either has to be hidden from store operators (sacrificing operational value) or risks leaking cross-store catalog signal. P1 because it is the per-actor isolation floor.

**Independent Test**: In tenant T, populate `pending` unknown items at stores S1 and S2. Sign in as a store operator scoped only to S1. Verify: (a) only S1's items appear; (b) S2's items do not appear in listings, filters, search, counters, or empty states; (c) attempting to act on an S2 item by id returns a non-disclosing not-found; (d) counters / badges (if any) do not include S2's items.

**Acceptance Scenarios**:

1. **Given** a store operator scoped only to store S1 in tenant T, **When** they open the review queue, **Then** only items captured at S1 are visible; items at S2, S3, etc. of the same tenant are absent from listings, counters, filters, search, and any global indicators.
2. **Given** a store operator scoped only to S1, **When** they attempt to act on an unknown-item reference that belongs to S2 (e.g., via direct link or guessed id), **Then** the action fails with a non-disclosing "not found" outcome — the operator cannot tell whether the item exists.
3. **Given** a store operator scoped to S1 and S2 (multi-store operator), **When** they open the queue, **Then** items at S1 and S2 are visible together; items at S3 are not.
4. **Given** a store operator loses access to S1 mid-session (e.g., membership revoked) and the queue page is still open, **When** they next interact with the queue or any item, **Then** the action is refused with a non-disclosing outcome and the stale view is refreshed (see FR-090).

---

### User Story 3 — User filters, sorts, and groups the queue safely (Priority: P1)

Authorized reviewers can filter, sort, and group `pending` items by store (within their scope), source system, lifecycle state, age, and — where authority allows — advisory indicators (e.g., "previously dismissed once", "candidate match exists within authorized scope"). Filter / sort / group choices never widen visibility beyond the user's authority. Empty results and zero-state filter combinations are clearly presented without exposing whether items exist outside the user's scope.

**Why this priority**: A queue without filtering is unusable at production volume. P1 because it is the difference between "queue exists" and "queue is actually clearable."

**Independent Test**: Populate 100 `pending` items across 4 stores, 2 source systems, with mixed ages. Sign in as a tenant admin and as a store operator (scoped to 2 of 4 stores). For each, verify: (a) filtering by store only offers stores within scope; (b) filtering by source system reflects only items in scope; (c) sorting by age and grouping by store both respect scope; (d) empty filter results render the in-scope empty state, never leaking the existence of out-of-scope items.

**Acceptance Scenarios**:

1. **Given** a tenant admin in tenant T with `pending` items across 4 stores, **When** they filter by `store = S1`, **Then** only S1's `pending` items are shown.
2. **Given** a store operator scoped only to S1, **When** they view the store filter, **Then** S1 is offered; S2, S3, S4 are absent — the operator cannot infer how many stores the tenant has from the filter.
3. **Given** the queue is open, **When** the user sorts by `age (oldest first)`, **Then** items are ordered by capture timestamp ascending within the user's scope.
4. **Given** the queue is open, **When** the user groups by `source system`, **Then** items are bucketed by source system within scope; source systems that have no in-scope items are absent from the grouping.
5. **Given** a filter combination that has no in-scope matches, **When** results render, **Then** the empty state explains that the current filter matched no items in the user's scope — it does not claim "no items exist" globally and does not hint at out-of-scope items.
6. **Given** an "age" filter (e.g., `older than 7 days`), **When** applied, **Then** the queue uses each item's capture timestamp from 005; the user-visible age is consistent with that timestamp and with the user's local time-zone display (rendering format is deferred to Impeccable; the data contract is per 005).

---

### User Story 4 — User inspects an unknown item with safe, sufficient context (Priority: P1)

When the user opens an individual `pending` unknown item, they see exactly the context they need to decide between *link*, *create*, and *dismiss*, and nothing they should not see. Safe context includes: identifier type and value, source system, capture store (named only if the user has access), capture timestamp, lifecycle state, and any advisory hints (prior dismissal, possible candidate matches *within authorized scope only*). Forbidden context — items from other tenants, items or candidate matches from inaccessible stores, raw PII, identifiers redacted by 005 §6.10 — is never shown.

**Why this priority**: Decision quality depends on context. A reviewer who cannot see enough makes wrong calls; a reviewer who can see too much creates a data-leak incident. P1 because both failure modes break the workflow.

**Independent Test**: Open one `pending` item as: (a) a tenant admin — verify the admin sees identifier metadata, the capture store name, source system, age, lifecycle state, and any in-scope advisory hints; (b) a store operator at the capture store — verify the same in-scope context appears; (c) a store operator at a *different* store of the same tenant — verify the item is non-disclosing not-found, no inspection surface exists.

**Acceptance Scenarios**:

1. **Given** an authorized reviewer opens unknown item U, **When** the detail view renders, **Then** it shows: identifier type, identifier value (or its 005-permitted display form), source system, capture store (within scope), capture timestamp, lifecycle state, and any advisory hints permitted by FR-040–FR-043.
2. **Given** unknown item U was captured at store S2 and the reviewer is a store operator scoped only to S1, **When** the reviewer attempts to open U, **Then** the platform returns a non-disclosing not-found.
3. **Given** unknown item U has a "previously dismissed once" advisory marker (per 005 FR-005 / edge case), **When** an authorized reviewer opens U, **Then** the marker is shown as advisory metadata that does not affect lifecycle and is non-disclosing across scope boundaries.
4. **Given** unknown item U carries optional descriptive metadata travelling inside 005's existing `unknown_items.sale_context jsonb` (per 005 FR-006 / FR-006a), **When** the reviewer opens U, **Then** that metadata is shown only to the extent 003 §8 and Constitution §14 permit, and the platform does not present it as identity or auto-match signal (consistent with 005 FR-006).
5. **Given** any inspection view, **When** rendered, **Then** it surfaces no candidate-match suggestions sourced from stores or tenants the reviewer is not authorized to see.

---

### User Story 5 — User links an unknown item to an existing product (Priority: P1)

The reviewer selects an existing tenant product as the target for the unknown item. From the user's perspective: the item moves from `pending` to `resolved` with resolution action `linked`, the identifier captured in the item is now bound to the chosen product as an alias, future POS scans of the same identifier resolve to that product, and the action is auditable. If the action cannot succeed (target unavailable, alias conflict, race-lost, etc.), the user sees a clear non-disclosing outcome describing the *category* of failure without leaking forbidden detail.

**Why this priority**: This is the primary reconciliation outcome in production usage — the majority of unknown items are existing products that the catalog has not yet seen under the submitted identifier. P1 because the loop is unclosed without it.

**Independent Test**: Pre-seed tenant T with active products P1 and P2 and a `pending` unknown item U at store S1. As an authorized reviewer: (a) link U to P1; verify U is `resolved` with `linked`; (b) attempt to link a fresh U' carrying the same identifier to P2 while an active alias for that identifier already binds it to P1 — verify the operation fails closed with a conflict-category outcome and U' remains `pending` (consumes 005 §6.5).

**Acceptance Scenarios**:

1. **Given** unknown item U is `pending` in tenant T and product P is active in T, **When** the reviewer links U to P and the action passes 005's link semantics, **Then** the user sees a clear success outcome, U transitions to `resolved` with `resolution_action = linked` (per 005 FR-050), and the audit event is emitted per 005 FR-080.
2. **Given** P is retired, deleted, inactive, or otherwise non-active in T, **When** the reviewer attempts to link U to P, **Then** the user sees a non-disclosing "target unavailable" outcome (per 005 FR-051); U remains `pending`.
3. **Given** linking U to P would violate alias uniqueness per 005 §6.5, **When** the reviewer submits the link, **Then** the user sees a non-disclosing conflict-category outcome (per 005 FR-042); U remains `pending`; no alias is mutated; no product is mutated.
4. **Given** two reviewers race to reconcile U, **When** both submit, **Then** exactly one sees the success outcome; the other sees an "already reconciled" outcome (per 005 US3 / SC-007); U has exactly one resolution record.
5. **Given** the reviewer selects a candidate product they should not be able to see (forged id, out-of-scope product), **When** the action is submitted, **Then** the platform returns a non-disclosing not-found (per 005 SI-004); U remains `pending`.

---

### User Story 6 — User creates a new product from an unknown item (Priority: P1)

When no existing product matches, the reviewer creates a new tenant product from the unknown item, supplying the minimal fields required by the existing tenant-product contract (per 005 FR-060). From the user's perspective: the product is created, the captured identifier becomes an alias on it, the item transitions to `resolved` with `created`, and the action is auditable. If the alias would conflict or the create would otherwise fail per 005 §6.7, the entire operation fails closed.

**Why this priority**: Many unknown items are genuinely new SKUs. Without this path, those items can only be dismissed, forcing manual product entry elsewhere. P1 because it is the second core reconciliation outcome.

**Independent Test**: Sign in as an authorized reviewer. Open a `pending` U. Create a new product from U with the minimal required fields. Verify: (a) product exists, scoped to the correct tenant; (b) an alias exists binding U's identifier to the new product; (c) U is `resolved` with `created`; (d) audit event exists; (e) attempting the same create on the same identifier where an alias already conflicts fails closed per 005 FR-062.

**Acceptance Scenarios**:

1. **Given** unknown item U is `pending`, **When** the reviewer creates a new product from U with valid minimal fields, **Then** the user sees a clear success outcome; the product, alias, and lifecycle transition are committed atomically (per 005 FR-063); the audit events are emitted.
2. **Given** the alias that would be created conflicts per 005 §6.5, **When** the create is submitted, **Then** the entire operation fails closed (no product, no alias, no lifecycle transition — per 005 FR-062), the user sees a non-disclosing conflict-category outcome, and U remains `pending`.
3. **Given** the minimal product fields are missing or malformed, **When** the create is submitted, **Then** the platform rejects with a validation-category outcome (per 005 FR-070 / FR-091); no product is created; no alias is created; U remains `pending`.
4. **Given** two reviewers race to create-new from U, **When** both submit, **Then** exactly one sees the success outcome; the other sees an "already reconciled" outcome (per 005 US3 #3).
5. **Given** an authorized reviewer creates a new product successfully, **When** subsequent POS scans of the same identifier arrive (per 005 US1 #3 and FR-022), **Then** they resolve to the new product without producing a new unknown-item record.

---

### User Story 7 — User dismisses an item that should not become a product (Priority: P2)

When an unknown item is invalid (test scan, mistyped barcode, one-off non-catalog scan, etc.), the reviewer dismisses it. From the user's perspective: the item transitions to `dismissed`, no product or alias is created, the action is auditable. If the POS later resubmits the same identifier, 005 will create a fresh `pending` record (per 005 FR-005); the prior dismissal is preserved as audit history. The reviewer can optionally see an advisory hint that the identifier was dismissed before.

**Why this priority**: Dismiss is essential to queue hygiene but is logically simpler than link/create, has no alias side-effect, and cannot ambiguate the catalog. P2 because the workflow can operationally tolerate dismissals being slightly less polished than P1 paths during early phases.

**Independent Test**: Sign in as an authorized reviewer. Dismiss a `pending` U. Verify: (a) U is `dismissed` (per 005 FR-003); (b) no alias / product side-effects; (c) audit event exists. Then have the POS resubmit the same identifier; verify a fresh `pending` U' is created (per 005 FR-005); verify the queue surfaces an advisory "previously dismissed once" marker on U' (per 005 FR-005 and edge case).

**Acceptance Scenarios**:

1. **Given** unknown item U is `pending`, **When** the reviewer dismisses U, **Then** the user sees a success outcome; U transitions to `dismissed` (per 005 FR-003); no alias or product is created; an audit event is emitted (per 005 FR-080).
2. **Given** U was dismissed, **When** the POS resubmits the same logical identifier at the same store, **Then** 005 captures a fresh `pending` U' (per 005 FR-005); U remains `dismissed` and terminal (per 005 FR-004); U' MAY render with an advisory "previously dismissed once" hint when surfaced in the queue.
3. **Given** U is already `resolved` or `dismissed`, **When** the reviewer attempts to dismiss U again, **Then** the platform refuses with an "already terminal" outcome distinguishable from a successful dismissal; U is unchanged.
4. **Given** a store operator scoped only to S1 attempts to dismiss an item captured at S2, **When** the action is submitted, **Then** the platform returns a non-disclosing not-found (per 005 SI-002 / SI-004).

---

### User Story 8 — Tenant admin reopens an item that was dismissed in error (Priority: P2)

When a tenant admin or tenant owner realises a dismissal was incorrect, they want to bring the item back into the active queue. Reopen is restricted to **tenant-wide actors only** (per FR-062a) — store-scoped operators cannot reopen, even within their own scope, because reopen is a correction-of-prior-judgment action that warrants tenant-level authority. Because 005's lifecycle is monotonic (005 FR-004 — `dismissed` is terminal), "reopen" is **not** a lifecycle reversal. From the user's perspective, "reopen" creates a fresh `pending` unknown-item record for the same logical identifier in the same store, using the same mechanism 005 defines for any new evidence (005 FR-005). The original `dismissed` row is preserved unchanged as audit history. The newly created `pending` item MAY render an advisory "reopened from a previous dismissal" hint to give context, distinct from the POS-resubmission "previously dismissed once" hint when implementations choose to differentiate them.

**Why this priority**: Correcting accidental dismissals is a real operational need, but the workflow is operable without it (user can wait for the POS to rescan the item, which 005 already handles). P2 because it is recoverable convenience rather than an isolation or safety floor.

**Independent Test**: Sign in as a tenant admin. Dismiss a `pending` U. Then reopen U as the tenant admin. Verify: (a) U remains `dismissed` (terminal — 005 FR-004); (b) a fresh `pending` U' exists for the same `(tenant, store, identifier_type, value, source_system)` tuple; (c) U' carries an advisory marker referencing U; (d) the reopen action and the creation of U' are both auditable; (e) attempting to reopen U when an active `pending` record for the same logical identifier already exists at the same store returns an "already pending" outcome rather than creating a duplicate; (f) a store-scoped operator attempting the same reopen receives a non-disclosing authority-failure outcome (per FR-062a and 005 SI-004).

**Acceptance Scenarios**:

1. **Given** unknown item U is `dismissed` in tenant T at store S, **and** no current `pending` record exists for U's logical identifier at (T, S), **When** a tenant admin (or tenant owner) of T reopens U, **Then** a fresh `pending` U' is created at (T, S) consistent with 005 FR-005; U remains `dismissed` (per 005 FR-004); both the reopen action and the creation of U' are audited per 005 FR-080.
2. **Given** U is `dismissed` and a `pending` U' for the same logical identifier at (T, S) already exists (e.g., the POS rescanned it), **When** the tenant admin attempts to reopen U, **Then** the platform returns an "already pending" outcome and points the reviewer to U'; no second `pending` record is created.
3. **Given** U is `resolved`, **When** any reviewer attempts to "reopen" U, **Then** the platform returns a deterministic "cannot reopen resolved item" outcome (per 005 FR-004 — `resolved` is also terminal); the reviewer is guided to undo via alias retirement / product correction in a separate future workflow rather than via the review queue.
4. **Given** a store operator scoped to S1 (where U was dismissed) attempts to reopen U, **When** the action is submitted, **Then** the platform refuses with a non-disclosing authority outcome (per FR-062a) — store-scoped operators cannot reopen even within their own scope.
5. **Given** a store operator scoped only to S1 attempts to reopen an item dismissed at S2, **When** the action is submitted, **Then** the platform returns a non-disclosing not-found (per 005 SI-004) — the operator cannot tell whether the item exists.
6. **Given** any successful reopen, **When** the audit log is queried, **Then** both events — the reopen action on U and the capture of U' — are linkable to the acting principal (a tenant-wide actor) and a correlation id (per 005 FR-080).

---

### User Story 9 — User sees clear, non-disclosing failure outcomes (Priority: P2)

Every user-visible failure from the queue is presented as one of a small set of categories the user can reason about, without leaking forbidden detail. Failure categories include (consuming 005 FR-091): validation-failure, target-unavailable, alias-conflict, idempotency-token-mismatch (rarely user-facing here), already-reconciled (race-loser), already-terminal (dismiss / reopen on a terminal row), not-found (cross-tenant or out-of-scope), system-failure. Messages are calm, deterministic, and never reveal whether an out-of-scope record exists.

**Why this priority**: Without categorised, non-disclosing failure language, the experience either confuses users or leaks data. P2 because P1 success paths are the primary value and failure framing is the safety net around them.

**Independent Test**: Exercise each failure category (per 005 FR-091): validation, target-unavailable, alias-conflict, already-reconciled, already-terminal, not-found, system-failure. For each, verify: (a) the user sees a category that is meaningful but not over-specific; (b) no out-of-scope record existence is revealed; (c) the failure is recorded as an audit event where 005 requires it (per 005 FR-082).

**Acceptance Scenarios**:

1. **Given** any user action that 005 rejects, **When** the rejection surfaces in the queue, **Then** the user sees a category from 005 FR-091 (or the spec-level extension for `already-terminal` introduced by US8 #3); no category leaks the existence of out-of-scope records.
2. **Given** a conflict outcome, **When** the user views the failure, **Then** they see the *category* of conflict (e.g., "this identifier is already bound to a different product") without disclosure of the conflicting product to actors lacking authority (per 005 FR-042 / SI-004).
3. **Given** a system-failure outcome, **When** the user retries the action, **Then** the platform either succeeds idempotently or returns the same outcome — there is no hidden partial commit (per 005 SC-007).

---

### User Story 10 — All review decisions are auditable (Priority: P2)

Every action a reviewer takes against the queue — open / view (where 005 audits viewing, otherwise listing/inspection is out of scope for audit), link, create, dismiss, reopen, and every failed attempt of those — produces a business-level audit event attributable to the acting principal with a correlation id, per 005 §6.9. The user does not need to see the audit log inside the queue UI for this spec, but the platform commitment that the audit exists must hold.

**Why this priority**: Audit is mandated by Constitution §II / §XII / §XIV but is not the user's primary task flow. P2 because it underpins trust without being a direct user feature.

**Independent Test**: Drive each user-facing action through the queue (link, create, dismiss, reopen, plus one failing attempt per category). For each, query the existing audit surface (per 005 FR-083) and verify a corresponding audit event exists with the correct tenant, store, actor, action, target, correlation id, and timestamp.

**Acceptance Scenarios**:

1. **Given** any successful action in US5–US8, **When** the action completes, **Then** an audit event exists attributable to the acting principal with a correlation id (per 005 FR-080).
2. **Given** any failed action (any category from US9), **When** 005 mandates an audit (per 005 FR-082), **Then** an audit event exists for the failed attempt as well.
3. **Given** the audit surface defined in 005 FR-083, **When** queried by tenant within the actor's authority, **Then** all events emitted by the review queue are retrievable through that same surface — 006 introduces no parallel audit channel.

---

### Edge Cases

- **Unknown item submitted repeatedly after dismissal**: A new `pending` record is created each time per 005 FR-005. The queue MAY render an advisory marker; the marker MUST NOT alter lifecycle semantics and MUST NOT disclose dismissal counts to actors outside scope.
- **Unknown item already reconciled by another user**: The losing user sees an "already reconciled" category outcome (per 005 US3 #3). The view refreshes to show the resolved state if the user still has authority to see it.
- **User loses store access while viewing the queue**: The next interaction is refused with a non-disclosing outcome; the stale queue view is refreshed; any items now outside scope disappear from the view without leaving a placeholder that would imply existence.
- **Target product is inactive, deleted, or inaccessible**: Link fails with a non-disclosing "target unavailable" or "not-found" category per 005 FR-051 / SI-004; U remains `pending`.
- **Candidate product exists in another store the user cannot see**: That product is not offered as a candidate match. Any "possible match" indicator in the inspection view is sourced only within the user's authorized scope. If the only candidate is out-of-scope, the inspection view shows no candidate and does not hint that one exists elsewhere.
- **Two users attempt reconciliation concurrently**: Exactly one succeeds (per 005 US3 #3 and SC-007); the other sees "already reconciled". No duplicate side-effects.
- **POS sends malformed or incomplete descriptive metadata**: Descriptive metadata is advisory and never identity-bearing (per 005 FR-006). The queue renders what is safe to render; absent or malformed descriptive fields never break the inspection surface. Identity decisions are unaffected.
- **Queue contains a very large number of pending items**: The queue MUST remain navigable: filter / sort / group surfaces are the primary navigation; pagination or progressive loading is permitted at the product level but specific scrolling / virtualisation behavior is deferred to Impeccable. The platform MUST NOT return all items at once if doing so would harm responsiveness or 005 SC-002's throughput guarantees.
- **Unknown item belongs to a store the tenant admin can see but a store operator cannot**: The tenant admin sees it; the store operator does not. Counters, filters, and any aggregate indicators reflect each actor's own scope (per US3 #2 and FR-022 below).
- **Reopen after accidental dismissal**: Modeled as US8 — fresh `pending` record, prior `dismissed` row preserved (per 005 FR-004 / FR-005).
- **Cross-store duplicate indicator would leak sensitive information**: The indicator is suppressed or rendered as a non-disclosing conflict-category state (per FR-040 below and 005 SI-004) — never as "matches product P at store S' which you cannot see."
- **Review action fails after the user has already seen stale queue data**: The action returns the appropriate category outcome (`already-reconciled`, `already-terminal`, `not-found`); the queue refreshes; the user is not penalised for acting on stale data (per FR-090 below).
- **Bulk action on a heterogeneous selection**: Bulk dismiss is the only bulk action this spec considers in scope (see FR-070–FR-073). Bulk link and bulk create are explicitly out of scope for v1 because they cannot be safely homogeneous (each item may carry a different identifier and a different target).
- **Tenant admin acting from a store-scoped session**: Not a new mechanism — the actor's session scope determines visibility (per 005 FR-014 / FR-015). 006 does not introduce a way for a tenant admin to "temporarily impersonate" a store scope.

---

## 6. Requirements *(mandatory)*

All requirements below are **product-level, user-visible expectations**. None of them prescribe UI, API, schema, or implementation. Where a requirement consumes 005 behavior, the 005 reference is cited.

### 6.1 Queue visibility

- **FR-001**: The queue MUST show only `pending` unknown items in its primary view by default; `resolved` and `dismissed` items MUST be reachable only via explicit filtering or detail navigation, never mixed into the default `pending` view as if they were actionable.
- **FR-001a — Detail surfaced for terminal items**: When an authorized reviewer filters or navigates to `dismissed` items, the surface MUST show full in-scope detail (identifier metadata, capture store, source system, capture timestamp, dismissal timestamp, dismissing actor) — no product or alias detail applies because no product was touched. When an authorized reviewer filters or navigates to `resolved` items, the surface MUST show identifier metadata, capture store, source system, capture timestamp, resolution timestamp, resolving actor, and `resolution_action` (`linked` / `created`). The **target product reference** (the linked or created product) MUST be shown only if the actor has authority to see that product under the existing membership / RLS model consumed from 003 / 005; if the actor lacks that authority (e.g., the product has since been retired into a state the actor cannot see, or visibility is otherwise revoked), the product identity MUST be suppressed and the row MUST render the resolution action without the target's identifying detail (per 005 SI-004). The platform MUST NOT fall back to a non-disclosing not-found for the *unknown-item row itself* when the only out-of-authority element is the product reference — the item's existence within the actor's scope is already authoritatively visible.
- **FR-002**: The queue MUST scope visibility per 005 FR-012 / FR-014 / FR-015: tenant admins see all `pending` items in their tenant; store-scoped operators see only items at stores within their scope.
- **FR-003**: Cross-tenant visibility MUST be impossible by construction; any cross-tenant lookup MUST surface as a non-disclosing not-found per 005 SI-004.
- **FR-004**: Counters, badges, summary indicators, or aggregate displays in the review experience MUST reflect each actor's own scope. They MUST NOT include out-of-scope items, even as anonymised aggregate counts.
- **FR-005**: The queue MUST NOT expose to platform operators or any non-tenant actor any tenant-scoped item, identifier, descriptive metadata, or actor identity. Platform-level operational health signals (queue depth, capture rate) are governed by 003 §9 / 005 §6.9 and are out of scope for the user-facing queue.

### 6.2 Lifecycle states surfaced in the queue

- **FR-010**: The queue MUST surface the three lifecycle states defined in 005 §6.1 / 003 §6: `pending`, `resolved`, `dismissed`. 006 MUST NOT introduce additional user-visible states.
- **FR-011**: The "reopen" user action (US8) MUST NOT introduce a fourth lifecycle state. It is modeled as the creation of a new `pending` record per 005 FR-005, with the prior `dismissed` row preserved unchanged. Any visual treatment of "reopened" is advisory metadata on the new record, not a state.
- **FR-012**: Advisory metadata (e.g., "previously dismissed once", "reopened from a previous dismissal", "POS resubmitted N times" if 005 makes such a count safely available) is informational only. It MUST NOT alter lifecycle semantics, MUST NOT influence automatic matching (per 005 FR-006), and MUST NOT disclose out-of-scope detail.

### 6.3 Minimum safe information per item

- **FR-020**: Each item in the queue MUST minimally surface: identifier type, identifier value (in the form 005 / 003 permits — see 005 §6.10 and FR-072), source system, capture store (only if the actor has access), capture timestamp, and current lifecycle state.
- **FR-021**: Each item MAY additionally surface advisory hints permitted by FR-012 and candidate matches that are entirely within the actor's authorized scope (per FR-040 / FR-080).
- **FR-021a — Descriptive metadata NOT surfaced in v1**: The v1 review experience MUST NOT surface optional POS descriptive metadata travelling inside 005's `unknown_items.sale_context jsonb` field — neither in the queue listing nor in the inspection view. Reviewers MUST rely on identifier metadata (type, value, source system) and the safe context defined in FR-020 alone. This is consistent with 005 FR-006's framing of descriptive metadata as non-identity, non-matching, advisory-only, and avoids any risk that reviewers over-rely on text they should not treat as authoritative. Any future surfacing of descriptive metadata MUST be a separate opt-in feature, gated through its own Impeccable shape / critique / clarify rounds, and is out of scope for 006.
- **FR-022**: The queue MUST NOT surface: items from other tenants; items from stores outside the actor's scope; identifiers, products, or matches sourced from stores or tenants outside the actor's scope; any field that 005 / 003 redacts at the logger boundary; any descriptive metadata at all in v1 (per FR-021a — even where 005 / 003 would permit it, the v1 surface holds it back).

### 6.4 Filtering, sorting, grouping, empty / loading / stale states

- **FR-030**: The queue MUST offer filtering by at least: store (within the actor's scope), source system, lifecycle state, and age (e.g., relative buckets: "less than 24h", "1–7 days", "7+ days" — exact bucket boundaries are an Impeccable concern). MAY offer filtering by advisory indicators when they are safe per FR-012 and FR-040.
- **FR-031**: The queue MUST offer sorting by at least: age (oldest first / newest first) and store (within scope). Other sorts (e.g., source system) are permitted.
- **FR-032**: The queue MAY offer grouping by store, source system, or age bucket. Grouping MUST respect scope: empty buckets that exist only out-of-scope MUST NOT appear.
- **FR-033**: All filter / sort / group options MUST respect the actor's scope. Filter dropdowns MUST NOT list stores, source systems, or other dimensions that have no in-scope items in a way that hints at out-of-scope existence.
- **FR-034**: Empty states MUST distinguish between (a) "no items match the current filter in your scope" and (b) "your scope is currently empty". Neither variant MUST imply anything about out-of-scope state.
- **FR-035**: Loading states MUST not reveal out-of-scope information (e.g., total counts before scope filtering). Skeleton / progressive-render behavior is deferred to Impeccable; the data contract is: nothing is shown until scope is authoritatively applied.
- **FR-036**: When the queue view is older than the underlying data (a "stale" view), an interaction MAY succeed against fresher state, MAY fail with `already-reconciled` / `already-terminal` / `not-found`, or MAY refresh the view. The user MUST NOT be penalised for acting on a stale view (no destructive default).

### 6.5 Link to existing product (user perspective)

- **FR-040**: "Link to existing product" MUST mean, from the user's perspective: select an active tenant product within the actor's authority; if 005 permits the link per its §6.5–§6.6, the unknown item is `resolved` with `resolution_action = linked`; otherwise the operation fails closed with a non-disclosing category outcome.
- **FR-041**: Candidate-match suggestions in the link flow MUST be sourced only from the actor's authorized scope. Out-of-scope candidate matches MUST be hidden or rendered as a non-disclosing conflict-category state (per 005 SI-004).
- **FR-042**: The link flow MUST never present forbidden cross-store or cross-tenant context as a "hint" or "you may want to consider" UI element — this includes ranked suggestions, anonymised "X stores have a similar item" hints, or aggregate badges.
- **FR-043**: The user-visible link flow MUST distinguish, at the product level, between target-unavailable and alias-conflict failures (per 005 FR-091); identical-looking messages for both are not acceptable.

### 6.6 Create new product (user perspective)

- **FR-050**: "Create new product from an unknown item" MUST mean, from the user's perspective: supply the minimal fields required by 005 FR-060; on success, a tenant product is created in scope, the captured identifier is bound to it as an alias, and the unknown item is `resolved` with `resolution_action = created` (per 005 FR-061).
- **FR-051**: If 005 rejects the create (validation, alias conflict, race-loser), the user MUST see a non-disclosing category outcome and the unknown item MUST remain `pending` (per 005 FR-062 / FR-063 / FR-091).
- **FR-052**: The create-new flow MUST NOT pre-populate forbidden cross-store or cross-tenant data into the new-product form (e.g., copying a name from a sibling tenant's product). It MAY pre-populate from in-scope advisory metadata permitted by FR-021.

### 6.7 Dismiss, reopen, and bulk actions

- **FR-060**: "Dismiss" MUST mean, from the user's perspective: the item transitions to `dismissed` per 005 FR-003 with no alias / product side-effects; the user sees a clear success outcome; the action is auditable per 005 FR-080.
- **FR-061**: "Reopen" MUST mean, from the user's perspective: a fresh `pending` unknown-item record is created for the same logical identifier per 005 FR-005; the prior `dismissed` row remains terminal per 005 FR-004; the new record MAY surface an advisory marker referencing the prior dismissal (per FR-012).
- **FR-062**: A "reopen" attempt on a `resolved` item MUST be refused with a deterministic "cannot reopen resolved item" outcome (per US8 #3). The reviewer is not offered a route to alter `resolved` state from the queue.
- **FR-062a — Reopen authority restricted to tenant-wide actors**: Only Tenant Admin and Tenant Owner principals MAY initiate a reopen action. Store-scoped operators (Store Operator / Store Manager) MUST NOT be able to reopen unknown items, even within their own store scope. A reopen attempt by a store-scoped operator on an item within their scope MUST be refused with a deterministic non-disclosing authority outcome (the `validation` category from FR-100, or equivalent) — the platform MUST NOT reveal whether the item exists in a way that distinguishes "exists but you cannot reopen it" from "does not exist". A reopen attempt by a store-scoped operator on an item outside their scope follows the standard non-disclosing not-found path per 005 SI-004. The rejection MUST be auditable per FR-111.
- **FR-063**: A "reopen" attempt where a `pending` record already exists for the same logical identifier at the same store MUST be refused with an "already pending" outcome that points the reviewer to the existing record (per US8 #2). No duplicate `pending` record is created. (This check applies to authorised reopen attempts that passed FR-062a.)
- **FR-070**: Bulk **dismiss** MAY be offered when (a) every selected item is `pending`, (b) every selected item is within the actor's scope, and (c) the count per submission is at most **200 items**. The platform MUST enforce this 200-item ceiling — submissions above it MUST be rejected with the `validation` category outcome (per FR-100) and MUST produce no partial-success state (all-or-nothing at the API boundary). Bulk dismiss is the only bulk action this spec admits for v1.
- **FR-071**: Bulk **link** MUST NOT be offered: each item carries a different identifier and may resolve to a different product, making homogeneous bulk-link unsafe.
- **FR-072**: Bulk **create** MUST NOT be offered: each new product needs minimal fields per 005 FR-060 that cannot be safely defaulted across heterogeneous items.
- **FR-073**: Bulk **reopen** MUST NOT be offered for v1: reopen interacts with the per-identifier "already pending" check (FR-063) in ways that are unsafe to batch without per-item review.

### 6.8 Duplicate / conflict warning behavior

- **FR-080**: When an authorized reviewer opens an unknown item, the inspection surface MUST display an advisory "candidate match within your scope" hint **when one or more in-scope candidates exist** for the captured identifier. Candidates MUST be sourced strictly from products / aliases the actor is authorized to see (per FR-041, FR-082, and 005 SI-004); products or aliases from stores or tenants outside the actor's scope MUST NOT be considered candidates and MUST NOT influence ranking, ordering, or presentation. The hint MUST be advisory only — the surface MUST NOT pre-select a candidate, MUST NOT auto-link, and MUST require an explicit reviewer action (link to existing product) to commit. When no in-scope candidate exists, the inspection surface MUST NOT render a "no candidates found" message that hints at out-of-scope state — it MUST simply omit the hint.
- **FR-081**: When acting on an unknown item, alias conflicts (per 005 §6.5) MUST surface as a non-disclosing conflict-category outcome. The reviewer MUST NOT learn the identity of the conflicting product unless they already have authority to see it.
- **FR-082**: Cross-store duplicate indicators that would require disclosing out-of-scope detail MUST be suppressed entirely or rendered as a non-disclosing conflict-category state (per 005 SI-004).
- **FR-083**: Where 005 emits the `duplicate_alias_conflict` observability signal (per 005 FR-043 / 003 §9), the user-facing surface MUST NOT echo or expose that signal beyond the non-disclosing category outcome the user already sees.

### 6.9 Permission-aware outcomes

- **FR-090**: Outcomes MUST be identical (same wording, same category) whether a record exists or does not exist when the actor lacks authority to see it. A tenant admin and a store operator MUST be unable to distinguish "does not exist" from "exists but you cannot see it" based on the response (per 005 SI-004).
- **FR-091**: Outcomes MUST be deterministic per logical action and actor authority: same input + same authoritative state + same actor scope → same response (per 005 FR-090).
- **FR-092**: Where the same action would succeed for a tenant admin and fail (non-disclosing not-found) for a store operator, the divergence MUST happen on the basis of 005's authority rules — 006 does not introduce a parallel authority model.

### 6.10 User-visible failure categories

- **FR-100**: The user-facing experience MUST surface failures using the categories defined in 005 FR-091, extended with the `already-terminal` category introduced by this spec (covering dismiss/reopen attempts on terminal rows — see US7 #3 and US8 #3). The full set: `validation`, `target-unavailable`, `alias-conflict`, `idempotency-token-mismatch` (rarely user-facing here), `already-reconciled`, `already-terminal`, `not-found`, `system-failure`.
- **FR-101**: Failure category wording MUST be non-disclosing per FR-090. The user MUST understand *what category* of problem occurred and *what they can do next* (retry, pick a different target, contact an admin, etc.) without learning anything they should not know.
- **FR-102**: System-failure outcomes MUST be safe to retry: either the retry succeeds idempotently or returns the same outcome (per 005 SC-007).

### 6.11 Audit expectations for review actions

- **FR-110**: Every successful user action (link, create, dismiss, reopen, and the implicit fresh-`pending` capture that reopen triggers) MUST be auditable per 005 FR-080 / FR-083.
- **FR-111**: Every failed user action whose category 005 audits per 005 FR-082 (conflict, target-unavailable, race-loser, etc.) MUST also be auditable.
- **FR-112**: 006 MUST NOT introduce a parallel audit channel, log surface, or correlation-id scheme. It consumes 005's audit surface as-is.
- **FR-113**: The user-facing experience does not need to expose the audit log inside the queue for v1. Audit retrieval is via the existing audit-query surface per 005 FR-083.

### Key Entities

This spec introduces **no new entities**. It consumes:

- **Unknown Item** — per 005 §6 / 003 §6. The review queue is a user-facing projection over `unknown_items`. 006 introduces no new column, table, or index on `unknown_items`.
- **Tenant Product** — per 003 §5. Reconciliation targets.
- **Product Alias** — per 003 §6. Created or reactivated by link / create actions.
- **Actor Principal** — per 001 / 002 / 005. Tenant admin, store operator, platform operator (read-only at aggregate level only).
- **Audit Event** — per 005 §6.9 / 001's audit pipeline. 006 emits no new event categories beyond those 005 already defines.

---

## 7. Security & Isolation Requirements

- **SI-001**: A tenant MUST NOT observe another tenant's unknown items, identifiers, descriptive metadata, candidate matches, or reconciliation activity through the review queue by any means — direct read, indirect inference via counters, filter dropdowns, empty states, error messages, conflict responses, or audit retrieval (per 005 SI-001).
- **SI-002**: A store-scoped operator MUST NOT observe or act on unknown items, identifiers, candidate matches, or reconciliation activity at stores outside their scope through the review queue (per 005 SI-002).
- **SI-003**: Tenant-wide actors MAY act across all stores in their tenant only insofar as the existing membership / scope model grants tenant-wide authority. 006 does not relax that model.
- **SI-004**: All cross-tenant and out-of-scope failures presented through the queue MUST be non-disclosing: the actor cannot tell whether the target exists (per 005 SI-004).
- **SI-005**: All reconciliation actions surfaced through the queue MUST fail closed when 005 mandates it (per 005 SI-005). The queue MUST NOT offer a path that bypasses 005's conflict-detection — explicitly: no "force-link" or "override-conflict" action exists.
- **SI-006**: The queue MUST NOT silently create tenant products. Product creation is always a human-driven reconciliation action initiated from the queue (per 005 SI-006).
- **SI-007**: PII posture is unchanged. Identifier values are catalog reference data; any optional descriptive metadata travels inside 003's `unknown_items.sale_context jsonb` and is subject to existing redaction posture (per 003 §8, Constitution §14, 005 SI-007). 006 introduces no new redaction surface and does not weaken the existing posture.
- **SI-008**: Errors MUST fail closed. When the queue cannot determine authority, it MUST default to non-disclosing not-found rather than render partial / leaky information.
- **SI-009**: Any action surfaced through the queue that changes reconciliation state MUST be auditable per 005 §6.9 — no silent state change is permitted.

---

## 8. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of pending unknown items captured at stores within a reviewer's authorized scope are visible to that reviewer in the queue; 0% of items captured outside their scope are visible. (Measured by isolation tests extended with review-queue cases.)
- **SC-002**: 0% of cross-tenant or out-of-scope access attempts (read or write) surface as anything other than a non-disclosing not-found through the review experience. (Measured by the existing isolation test harness extended with review-queue cases — consistent with 005 SC-005.)
- **SC-003**: 0% of reconciliation actions completed via the queue create ambiguous aliases (per 005 SC-003). The queue offers no "override-conflict" path.
- **SC-004**: 100% of state transitions completed via the queue (link, create, dismiss, reopen→fresh-pending) are linkable to an audit event by correlation id within the audit-query SLA defined in 005 SC-004.
- **SC-005**: A tenant admin can clear a queue of 50 pending items in under 10 minutes of focused work, given a representative link / create / dismiss mix. (Inherited from 005 SC-006 as a directional UX target — not a gate on this spec; the eventual UI feature will be the venue for measurement.)
- **SC-006**: 0% of queue interactions leave the user with a stale-view ambiguity that produces an incorrect lifecycle outcome (per FR-090 / 005 SC-007). Concretely: every action either succeeds idempotently or returns one of the `already-reconciled` / `already-terminal` / `not-found` categories, never a silently-incorrect "success".
- **SC-007**: A store operator with no in-scope items sees a "your scope is currently empty" empty state (FR-034) and is unable to infer the existence of any out-of-scope items by any signal (counter, filter dropdown, response timing, etc.). (Measured by the isolation test harness.)
- **SC-008**: Bulk dismiss, where offered, completes with the same per-item correctness guarantees as single dismiss: every successfully dismissed item is `dismissed` and audited; every rejected item (already-terminal, out-of-scope, etc.) is reported per FR-100 without affecting siblings. (Measured by the bulk-dismiss integration test under mixed-success workloads.)

---

## 9. Assumptions

- 005's lifecycle, idempotency, reconciliation, audit, conflict, and isolation semantics are the authoritative ground truth for everything user-facing the queue surfaces. 006 consumes them; it does not modify them.
- "Reopen after accidental dismissal" is modeled as **fresh-`pending`-record creation** (per 005 FR-005), not lifecycle reversal. This is the only model that does not weaken 005's monotonic lifecycle (FR-004). The eventual UI may present it as a single "Reopen" button; the underlying semantic remains creation of a new record. **Reopen authority is restricted to tenant-wide actors (Tenant Admin / Tenant Owner) per FR-062a** — store-scoped operators cannot reopen even within their own scope.
- The queue's default view is `pending` items only. `resolved` and `dismissed` items are reachable via filtering or direct navigation; when surfaced, their detail follows FR-001a — `dismissed` items show full in-scope detail; `resolved` items suppress the target product reference if the actor lacks authority to see that product.
- Bulk operations: only bulk **dismiss** is in scope for v1, capped at **200 items per submission** (FR-070). Bulk link, bulk create, and bulk reopen are explicitly out of scope because they cannot be safely homogeneous.
- **v1 advisory scope**: optional POS descriptive metadata travelling inside 005's `unknown_items.sale_context jsonb` MUST NOT be surfaced (FR-021a). In-scope candidate-match hints in the inspection view MUST be surfaced (FR-080), strictly bounded to the actor's authority. Future surfacing of descriptive metadata is a separate opt-in feature.
- Platform operators do not have a tenant-scoped review surface. Any platform-wide operational view is aggregate per 005 §6.9 / 003 §9 and is governed by those specs, not this one.
- The minimum information per item (FR-020) is what 005 / 003 already permit. Any future enrichment of per-item context (e.g., a structured descriptive label) is a separate opt-in feature, not in 006.
- Time-zone display, exact bucket boundaries for age filters, pagination thresholds, visual treatment of advisory markers, and exact wording of category messages are deferred to the Impeccable workflow (§11). This spec pins behavior, not chrome.
- Advisory candidate-match hints inside the inspection surface (per FR-080) are scoped strictly within the actor's authority. Whether to render them at all in v1 is an Impeccable / UI decision; the safety boundary is fixed here, the chrome is not.
- 005 Wave 1 is mid-flight. Any requirement here that depends on 005 behavior not yet implemented at runtime is a dependency (§10), not work for 006 to perform.

---

## 10. Dependencies

| Dependency | What we rely on it for |
|---|---|
| **specs/005-pos-catalog-sync-reconciliation** | Authoritative source of truth for unknown-item lifecycle, idempotency, reconciliation paths (link / create), conflict semantics, audit events, observability signals, isolation guarantees, and user-visible failure categories. **Hard prerequisite.** Where 005 Wave 1 work has not yet shipped at runtime, requirements here that consume that work are dependencies, not implementation tasks for 006. |
| **specs/003-catalog-foundation** | Underlying data model (`tenant_products`, `product_aliases`, `unknown_items`), alias uniqueness rules, RLS, redaction posture. Consumed transitively via 005. |
| **specs/002-pos-operator-identity** | POS principal identity model — referenced indirectly because the queue presents items captured by POS principals. 006 does not interact with POS principals directly. |
| **specs/001-foundation-auth-tenant-store** | Audit pipeline, correlation-id infrastructure, membership / scope model, idempotency primitive. Consumed transitively via 005. |
| **Constitution v3.0.0** | §II multi-tenant RLS, §III backend authority, §IV contract-first, §IX source-of-truth, §XII object safety, §XIV PII discipline. |

This spec **introduces no new dependencies** beyond those it transitively consumes through 005.

---

## 11. Future UI / Impeccable Workflow

This spec defines the **product expectations** for the review queue. It deliberately does not define the UI. When the dashboard UI feature is opened (in a separate spec, separate branch, separate PR) to render the review queue, the design work MUST be routed through the Impeccable workflow before implementation:

1. **`/impeccable shape`** — early screen structure, navigation, and UX flow for the queue list, filter / sort / group surface, inspection view, action flows (link / create / dismiss / reopen), bulk-dismiss confirmation, empty states, loading states, and stale-state refresh.
2. **`/impeccable critique`** — review of the shaped screens against this spec's safety boundaries (especially §6.3 minimum-information, §6.8 conflict / duplicate warnings, §6.9 permission-aware outcomes, §7 isolation requirements).
3. **`/impeccable audit`** — accessibility (keyboard, screen-reader, contrast), responsive behavior, and implementation quality once a candidate UI exists.
4. **`/impeccable polish`** — final visual refinement, motion, density, and visual hierarchy.
5. **`/impeccable clarify`** — UX copy and error / category messages, especially the non-disclosing wording mandated by FR-090 / FR-101.

No React components, dashboard routes, pages, tables, modals, CSS, layout files, or design tokens land before the Impeccable rounds run against the relevant scope. The order is not strict (shape → critique → audit → polish → clarify is a typical path; teams may iterate), but every UI artifact MUST have been through at least `shape` and `critique` before being merged.

This section is a **routing rule**, not an implementation request. No Impeccable rounds are triggered by 006.

---

## 12. Open Questions

None blocking. The four material ambiguities surfaced during `/speckit-clarify` (2026-05-23) — bulk-dismiss ceiling, reopen authority, detail surfaced for terminal items, and v1 scope of advisory surfaces — are all resolved in the Clarifications section near the top of this spec and integrated into FR-001a, FR-021a, FR-022, FR-062a, FR-070, and FR-080. The spec consumes 005 / 003 semantics as-is, and the one earlier point of friction — what "reopen" means against a monotonic lifecycle — remains resolved deterministically by modeling reopen as a fresh-`pending`-record action per 005 FR-005 (see §9 Assumptions and US8). Any remaining UI-level questions (exact age buckets, pagination thresholds, listing-latency targets, message wording, visual treatment of advisory markers, accessibility behavior) are intentionally routed to Impeccable (§11) rather than this spec.
