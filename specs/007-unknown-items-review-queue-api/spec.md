# Feature Specification: Unknown Items Review Queue — API

**Feature ID**: 007
**Short name**: unknown-items-review-queue-api
**Status**: Draft
**Created**: 2026-05-29
**Owner**: Ahmed Shaaban
**Depends on**: [specs/006-unknown-items-review-queue](../006-unknown-items-review-queue/spec.md) (product brief — consumed unchanged) · [specs/005-pos-catalog-sync-reconciliation](../005-pos-catalog-sync-reconciliation/spec.md) (lifecycle / reconciliation / audit / isolation semantics — consumed unchanged) · [specs/003-catalog-foundation](../003-catalog-foundation/spec.md) (data model, transitively via 005) · [specs/001-foundation-auth-tenant-store](../001-foundation-auth-tenant-store/spec.md) (auth / scope / audit, transitively via 005)
**Constitution version**: v3.0.1 — primary touchpoints §II (multi-tenant RLS), §III (backend authority), §IV (contract-first), §IX (Source-of-Truth Model), §XII (object safety), §XIV (PII discipline)
**Input**: User description: "007-unknown-items-review-queue-api"

---

## Clarifications

### Session 2026-05-29

- Q: For the inspect operation (FR-070), does v1 include the advisory candidate-match hint that 006 FR-080 leaves as MAY? → A: No — exclude the candidate-match hint from v1. The inspect operation returns the FR-020 safe-context field set only. The hint is a v2 opt-in feature with its own cost analysis and Impeccable critique. FR-080's safety boundaries remain mandatory if and when the hint is ever surfaced, but no v1 operation queries or returns candidates.
- Q: The list operation's pagination is described as "bounded" (FR-005) — what is the page-size ceiling? → A: A hard maximum of 200 items per page, with a default page size of 50 when the client supplies none. A requested page size out of range is rejected with a `validation` failure (not clamped). This aligns with the already-shipped 005 `tenantAdminListUnknownItems` contract (`limit` min 1 / max 200 / default 50, 400 on out-of-range — `packages/contracts/openapi/catalog/unknown-items.yaml`), which 007 extends rather than redefines. (Superseded the initial recommendation of max-100/clamp once the shipped 005 contract was discovered during planning — see plan.md dependency-readiness.) This bounds the contract parameter and the perf/isolation test surface while protecting 005 SC-002 throughput.
- Q: Do the action operations introduce new per-operation rate limiting / throttling in v1? → A: No — 007 consumes the existing platform rate-limit posture (001 / 004) unchanged and introduces no new per-operation limits in v1. 007 is a thin contract over 005's already-governed reconciliation semantics; bulk-dismiss is already bounded at 200 ids per submission (FR-044), so no fresh throttle is warranted for v1. Any future per-operation limit is a separate decision, consistent with 007's no-parallel-channel discipline.

---

## 0. Scope of This Spec

This spec defines the **dashboard-facing API surface** that realizes the product expectations pinned in **006-unknown-items-review-queue**. 006 deliberately stopped at the product level ("no API endpoint design, no OpenAPI changes, no DTOs") and named a *future API feature* (006 plan §9.1) gated on 005 Wave 2. 005 Wave 2 is now COMPLETE on `main` (per the project Active-feature record), so this feature is now implementable. This spec is that feature's product/behavioral definition.

This spec defines, at **contract/behavioral altitude**:

- The **read operations** an authorized reviewer's client can call to list, filter, sort, group, paginate, and inspect unknown items within the reviewer's authority.
- The **action operations** a client can call to link, create-from, dismiss, reopen, and bulk-dismiss unknown items — each consuming 005's lifecycle and reconciliation semantics unchanged.
- The **request shapes** (parameters and bodies) each operation accepts and the **validation rules** applied at the API boundary.
- The **response shapes** — success payloads and the structured failure envelope — including the closed failure-category vocabulary the API returns.
- The **authority, isolation, non-disclosure, audit, and idempotency guarantees** every operation MUST enforce at the API boundary.

This spec is **explicitly not**:

- A UI / dashboard specification (no components, routes, pages, tables, modals, CSS, layout, design tokens). UI is a separate future feature routed through Impeccable (006 §11).
- A wire-format authoring task: it does **not** author the OpenAPI YAML, the path strings, the HTTP method/status assignments, the JSON field names, or the Zod schemas. Those are HOW — produced downstream in this feature's own `plan.md` / `tasks.md`, and the OpenAPI YAML lives under the `[GATED]` `packages/contracts/openapi/**` path.
- A backend code specification (no NestJS modules, controllers, services, guards, interceptors, repositories, or file paths).
- A re-specification of 005 or 006: lifecycle, idempotency, reconciliation, conflict, audit, observability, and isolation semantics are owned by 005 and consumed here **unchanged**; the user-facing review experience is owned by 006 and realized here **unchanged**. Where this spec says an operation "MUST," the obligation is to faithfully expose an already-specified 005/006 behavior through a contract, not to invent new behavior.
- A change to 003 / 004 / 005's already-shipped contracts, schema, migrations, or RLS.

The discriminating value of 007 over 006: 006 says *what a reviewer sees and may do*; 007 says *what operations a client invokes, what it sends, what it gets back, and what the boundary guarantees* — the contract surface that makes 006's experience reachable by software.

---

## 1. Background & Why

006 pinned the product-level review experience for unknown POS-sourced catalog items (10 user stories, 38 functional requirements, 9 security/isolation requirements, 8 success criteria) but explicitly produced no callable surface. Without an API:

- The future dashboard UI feature has nothing to consume — 006 §11 and plan §9.2 require the UI to build against API contracts that do not yet exist.
- 005's reconciliation paths (link / create / dismiss) remain reachable only by 005's own POS-capture and reconciliation routes, not by a reviewer-facing queue surface.
- The isolation, non-disclosure, and audit guarantees that 006 specifies as product behavior have no boundary at which they are concretely enforced and testable for the review surface.

This feature closes that gap by defining the reviewer-facing API contract so that:

1. The future UI feature can be designed and built against a stable, isolation-aware contract.
2. Every 006 product requirement that involves a reviewer reading or acting on the queue maps to a concrete, testable operation with defined inputs, outputs, and failure behavior.
3. 005's source-of-truth semantics are exposed without duplication, drift, or new authority/audit channels.

---

## 2. Goals

- Define the **list/query operation** for unknown items: scope-bounded enumeration with filtering, sorting, grouping, and pagination, defaulting to `pending`.
- Define the **inspect operation** for a single unknown item with the safe-context field set 006 §6.3 permits.
- Define the **action operations** — link to existing product, create new product from item, dismiss, reopen, bulk-dismiss — each as a contract over 005's existing reconciliation semantics.
- Define the **request validation contract** applied at the API boundary (required fields, bounds, the 200-item bulk ceiling).
- Define the **response contract**: success payload shapes (behavioral, not field-named) and the **structured failure envelope** carrying the closed FR-100 category set.
- Define **authority and isolation enforcement** at the API boundary, including non-disclosing not-found for cross-tenant / out-of-scope targets.
- Define **idempotency** behavior for state-changing operations, consuming 005 / 001's idempotency primitive.
- Define **audit emission** obligations for every operation, consuming 005's audit surface unchanged.
- Define the **isolation test obligations** the contract must satisfy (extending the existing harness — 006 research §R3).

## 3. Non-Goals

- No UI: no components, routes, pages, tables, modals, CSS, layout, design tokens. (Separate future feature, Impeccable-gated per 006 §11.)
- No OpenAPI YAML authoring, no concrete path strings, HTTP methods, status codes, header names, or JSON field names in this spec. Those are produced in `plan.md` / `tasks.md`; the YAML itself is a `[GATED]` artifact under `packages/contracts/openapi/**`.
- No backend code: no NestJS modules, controllers, services, guards, interceptors, repositories, or file paths.
- No new lifecycle state, reconciliation semantic, conflict rule, audit category, observability signal, or authority model. All are consumed from 005 / 003 / 001 unchanged.
- No new persistence: no schema change, migration, index, RLS amendment, or ORM change on `unknown_items`, `tenant_products`, `product_aliases`, or any other table. 007 is a read/projection + action-dispatch surface over data 003/005 already own.
- No descriptive-metadata surfacing: 006 FR-021a holds back `unknown_items.sale_context jsonb` in v1; 007 honors that — no operation returns it.
- No candidate-match hint in v1: 006 FR-080 leaves the hint as MAY, and 007 v1 takes the "not surfaced" branch (clarified 2026-05-29, FR-070). No v1 operation queries, ranks, or returns candidate products. The hint is a separate v2 opt-in feature; 006 FR-080's safety boundaries remain mandatory only if a future version surfaces it.
- No "force-link" / "override-conflict" / bulk-link / bulk-create / bulk-reopen operations (006 FR-071/FR-072/FR-073, SI-005).
- No POS-side behavior or client SDK shape. POS capture is owned by 005 / 002.
- No analytics, reporting, dbt, ClickHouse, Dagster, billing, or CI surface.

---

## 4. Actors

| Actor | Role at the API |
|---|---|
| **Tenant Admin / Tenant Owner** | Authenticated dashboard principal with tenant-wide authority. May call read and action operations across all stores in the tenant, including **reopen** (the only action restricted to tenant-wide authority, per 006 FR-062a). |
| **Store Operator / Store Manager** | Authenticated dashboard principal scoped to specific stores. May call read and action operations **only for items at stores within scope**, with the same action set as tenant-wide actors **except reopen** (006 FR-062a). Out-of-scope targets resolve to non-disclosing not-found. |
| **POS Device / POS Backend** | Not a consumer of this API. POS capture is owned by 005 / 002. Listed only to clarify POS principals do not call the review-queue surface. |
| **Platform Operator** | No tenant-scoped access through this API (006 FR-005 / SI-001). 007 introduces no platform read surface. |
| **Anonymous / unauthenticated** | No access. Every operation requires an authenticated dashboard principal. |

This spec introduces **no new permission, role, or membership model.** It consumes 001's membership/scope model and 005's actor authority rules as-is, exposing them at the API boundary.

---

## 5. User Scenarios & Testing *(mandatory)*

User stories are the API-client journeys that realize 006's review experience. They are ordered by priority. Each is independently testable against the contract.

### User Story 1 — Client lists pending items scoped to the caller's authority (Priority: P1)

A reviewer's client calls the list operation and receives only the `pending` unknown items the authenticated principal is authorized to see — all stores for a tenant-wide actor, only in-scope stores for a store-scoped operator — each carrying the safe context fields 006 §6.3 permits. No item from another tenant or an out-of-scope store appears in the result, in any count, filter facet, or pagination total.

**Why this priority**: This is the foundational read. Without a scoped list operation, no client (UI or otherwise) can present the queue, and every action operation has no item to act on. It is the API floor for 006 US1–US3.

**Independent Test**: Seed a tenant with `pending` items at three stores. Call the list operation as (a) a tenant-wide actor — verify all three stores' items return; (b) a store operator scoped to one store — verify only that store's items return and no count/facet/total reveals the others; (c) a principal of a different tenant — verify zero of this tenant's items are reachable. Verify the default result set is `pending`-only (006 FR-001).

**Acceptance Scenarios**:

1. **Given** a tenant-wide principal authenticated to tenant T with `pending` items at stores S1, S2, S3, **When** the client calls the list operation with no filter, **Then** the response contains every `pending` item across S1–S3, each carrying identifier type, identifier value (in 005-permitted form), source system, capture store, capture timestamp, and lifecycle state (006 FR-020); and no `resolved` or `dismissed` item is included by default (006 FR-001).
2. **Given** a store operator scoped only to S1, **When** the client calls the list operation, **Then** only S1's items are returned, and no field, count, facet, or pagination total in the response reflects items at S2 or S3 (006 FR-002 / FR-004 / SI-002).
3. **Given** a principal authenticated to tenant T', **When** the client calls the list operation, **Then** none of tenant T's items are returned by any parameter combination, and the response is indistinguishable in shape from an empty in-scope result (006 FR-003 / SI-001 / SI-004).

---

### User Story 2 — Client filters, sorts, groups, and paginates the queue safely (Priority: P1)

A reviewer's client passes filter, sort, group, and pagination parameters to the list operation. The operation honors them within the caller's authority: filtering by store, source system, lifecycle state, and age; sorting by age and store; optional grouping; and bounded pagination so a large queue is navigable. No parameter widens visibility beyond the caller's scope; filter facets returned to the client never reveal stores or source systems that have no in-scope items.

**Why this priority**: At production volume an unfiltered, unpaginated list is unusable and may threaten 005 SC-002 throughput (006 edge case "very large number of pending items"). Filtering/pagination is the difference between "queue exists" and "queue is clearable." P1 because it is required for any realistic client.

**Independent Test**: Seed ~100 `pending` items across 4 stores and 2 source systems with mixed ages. As a tenant-wide actor and as a 2-store operator, exercise each parameter: filter by store / source system / lifecycle / age; sort by age and store; group by store / source system. Verify results respect scope, facets list only in-scope dimensions, pagination returns bounded pages with a stable total reflecting only in-scope items, and an empty filter combination returns a scope-correct empty result that does not reveal out-of-scope existence (006 FR-030–FR-035, SC-007).

**Acceptance Scenarios**:

1. **Given** a tenant-wide principal with items across 4 stores, **When** the client filters by a single in-scope store, **Then** only that store's matching items return (006 FR-030).
2. **Given** a store operator scoped to S1 only, **When** the client requests available filter facets, **Then** the facet set lists S1 alone and never reveals the count or identity of other stores or out-of-scope source systems (006 FR-033 / SC-007).
3. **Given** any caller, **When** the client requests sort by age ascending, **Then** items are ordered by 005 capture timestamp ascending within the caller's scope (006 FR-031).
4. **Given** a queue larger than one page, **When** the client requests successive pages, **Then** the operation returns bounded pages (default 50, hard maximum 200 per page; an out-of-range requested size is rejected with a `validation` failure — FR-005), an opaque continuation cursor, and a total that counts only in-scope items; the platform MUST NOT return all items at once where doing so would harm responsiveness or 005 SC-002 (006 edge case).
5. **Given** a filter combination with no in-scope matches, **When** results render, **Then** the operation returns an empty result distinguishable as "no match in your scope" vs. "your scope is empty," and reveals nothing about out-of-scope items (006 FR-034).
6. **Given** a client requests `resolved` or `dismissed` items via an explicit lifecycle filter, **When** results return, **Then** each in-scope terminal item carries the FR-001a field set — `dismissed`: identifier metadata, capture store, source system, capture + dismissal timestamps, dismissing actor; `resolved`: identifier metadata, capture store, source system, capture + resolution timestamps, resolving actor, and `resolution_action` — with the linked/created product reference present only if the caller has authority to see that product, otherwise omitted while the item itself remains visible (006 FR-001a).

---

### User Story 3 — Client inspects a single unknown item with safe, sufficient context (Priority: P1)

A reviewer's client requests one unknown item by its opaque id and receives exactly the safe context needed to decide between link / create / dismiss, and nothing forbidden. The inspect operation returns the FR-020 field set plus any advisory hints permitted by FR-012/FR-040. It never returns items from other tenants, items from out-of-scope stores, descriptive metadata (FR-021a), redacted fields, or candidate matches sourced outside the caller's authority. An out-of-scope or cross-tenant id resolves to a non-disclosing not-found.

**Why this priority**: Decision quality depends on per-item context; over-disclosure is a leak incident. P1 because both failure modes break the workflow and every action operation begins from an inspected item.

**Independent Test**: Open one `pending` item by id as (a) a tenant-wide actor — verify FR-020 context returns; (b) a store operator at the capture store — verify the same in-scope context returns; (c) a store operator at a different store of the same tenant — verify a non-disclosing not-found; (d) a different tenant's principal — verify a non-disclosing not-found. Verify no descriptive metadata is present in any case (FR-021a).

**Acceptance Scenarios**:

1. **Given** an authorized caller and an in-scope item U, **When** the client requests U by id, **Then** the response carries identifier type, identifier value (005-permitted form), source system, capture store, capture timestamp, lifecycle state, and any advisory hints permitted by FR-012/FR-040 — and carries no descriptive metadata (006 FR-020 / FR-021a).
2. **Given** item U captured at store S2 and a caller scoped only to S1, **When** the client requests U by id, **Then** the operation returns a non-disclosing not-found indistinguishable from "U does not exist" (006 FR-022 / SI-004).
3. **Given** any inspect response, **When** it renders, **Then** it contains no candidate-match suggestion sourced from a store or tenant the caller is not authorized to see (006 FR-080 boundaries).

---

### User Story 4 — Client links an unknown item to an existing product (Priority: P1)

A reviewer's client submits a request to link a `pending` item to an existing active tenant product the caller is authorized to see. On success the operation transitions the item to `resolved` with `resolution_action = linked`, binds the captured identifier to the product as an alias, and emits the audit event — all per 005's link semantics, consumed unchanged. On failure (target unavailable, alias conflict, race-lost, out-of-scope target) the operation returns a structured failure with the correct FR-100 category and the item remains `pending`, with no partial mutation.

**Why this priority**: Link is the primary reconciliation outcome in production (006 US5). Without it the loop is unclosed. P1.

**Independent Test**: Seed tenant T with active products P1, P2 and `pending` item U. As an authorized caller: (a) link U to P1 — verify success, U `resolved`/`linked`, audit event present; (b) submit a link of a fresh U' carrying the same identifier to P2 while an active alias already binds it — verify a closed `alias-conflict` failure and U' stays `pending`, no mutation; (c) link to an out-of-scope/forged product id — verify non-disclosing `not-found`.

**Acceptance Scenarios**:

1. **Given** `pending` U in T and active product P the caller may see, **When** the client submits the link and 005's link semantics pass, **Then** the operation returns success, U is `resolved` with `resolution_action = linked` (005 FR-050), and an audit event is emitted (005 FR-080 / 006 FR-110).
2. **Given** P is non-active in T, **When** the client submits the link, **Then** the operation returns a `target-unavailable` failure (005 FR-051 / 006 FR-043); U remains `pending`.
3. **Given** the link would violate alias uniqueness (005 §6.5), **When** the client submits, **Then** the operation returns an `alias-conflict` failure non-disclosing of the conflicting product to a caller lacking authority (006 FR-042 / FR-081); U remains `pending`; no alias or product is mutated.
4. **Given** two clients race to reconcile U, **When** both submit, **Then** exactly one receives success and the other receives an `already-reconciled` failure (005 US3 / 006 FR-100); U has exactly one resolution record (005 SC-007).
5. **Given** the target product id is out of scope or forged, **When** the client submits, **Then** the operation returns a non-disclosing `not-found` (005 SI-004 / 006 FR-090); U remains `pending`.

---

### User Story 5 — Client creates a new product from an unknown item (Priority: P1)

A reviewer's client submits a request to create a new tenant product from a `pending` item, supplying the minimal fields required by the existing tenant-product contract (005 FR-060). On success the product is created in the caller's tenant scope, the captured identifier becomes an alias on it, the item transitions to `resolved` with `resolution_action = created`, and audit events are emitted — committed atomically per 005 FR-063. On failure (validation, alias conflict, race-lost) the entire operation fails closed and the item stays `pending`.

**Why this priority**: Many unknown items are genuinely new SKUs; without create-from they can only be dismissed (006 US6). P1 — second core reconciliation outcome.

**Independent Test**: As an authorized caller, create a product from `pending` U with valid minimal fields. Verify product exists scoped to the correct tenant, an alias binds U's identifier, U is `resolved`/`created`, audit events exist. Then submit the same create where an alias already conflicts — verify a closed `alias-conflict` failure with no product, no alias, no transition (005 FR-062).

**Acceptance Scenarios**:

1. **Given** `pending` U, **When** the client submits create-from with valid minimal fields, **Then** the operation returns success; product, alias, and lifecycle transition commit atomically (005 FR-063); audit events are emitted (006 FR-110).
2. **Given** the would-be alias conflicts (005 §6.5), **When** the client submits, **Then** the entire operation fails closed (no product, no alias, no transition — 005 FR-062), the operation returns an `alias-conflict` failure, and U remains `pending`.
3. **Given** minimal product fields are missing or malformed, **When** the client submits, **Then** the operation returns a `validation` failure (005 FR-070 / 006 FR-051); nothing is created; U remains `pending`.
4. **Given** two clients race to create-from U, **When** both submit, **Then** exactly one receives success and the other receives `already-reconciled` (005 US3).

---

### User Story 6 — Client dismisses an item that should not become a product (Priority: P2)

A reviewer's client submits a dismiss request for a `pending` item. On success the item transitions to `dismissed` with no alias/product side effect, and the action is audited — per 005 FR-003, consumed unchanged. A repeat dismiss on a terminal item returns `already-reconciled` with a `details.prior_state` discriminator. An out-of-scope dismiss returns non-disclosing `not-found`.

**Why this priority**: Dismiss is essential queue hygiene but has no alias side-effect and cannot ambiguate the catalog (006 US7). P2.

**Independent Test**: Dismiss a `pending` U — verify `dismissed`, no alias/product side effect, audit event present. Re-submit dismiss on the now-terminal U — verify `already-reconciled` with `details.prior_state`. Submit dismiss for an out-of-scope item — verify non-disclosing `not-found`.

**Acceptance Scenarios**:

1. **Given** `pending` U, **When** the client dismisses U, **Then** the operation returns success; U is `dismissed` (005 FR-003); no alias/product is created; an audit event is emitted (006 FR-110).
2. **Given** U is already `resolved` or `dismissed`, **When** the client dismisses U again, **Then** the operation returns `already-reconciled` carrying `details.prior_state` (006 FR-100); U is unchanged.
3. **Given** a store operator scoped to S1 dismisses an item captured at S2, **When** the client submits, **Then** the operation returns non-disclosing `not-found` (005 SI-002 / SI-004).

---

### User Story 7 — Client reopens a dismissed item (tenant-wide actors only) (Priority: P2)

A tenant-wide principal's client submits a reopen request for a `dismissed` item. Because 005's lifecycle is monotonic (005 FR-004), reopen is not a reversal: the operation creates a fresh `pending` record for the same logical identifier at the same store (005 FR-005), preserving the original `dismissed` row, and audits both the reopen action and the fresh capture. A reopen by a store-scoped operator fails: `not-found` for out-of-scope items, `forbidden` for in-scope items (006 FR-062a). A reopen on a `resolved` item, or where a `pending` sibling already exists, returns the deterministic categorized outcome.

**Why this priority**: Correcting accidental dismissals is a real need but recoverable (a POS rescan also re-creates the item). P2 (006 US8).

**Independent Test**: As a tenant-wide actor, dismiss `pending` U then reopen U — verify U stays `dismissed`, a fresh `pending` U' exists for the same tuple with an advisory marker referencing U, and both the reopen and the U' capture are audited. Verify reopen when a `pending` sibling exists returns "already pending." Verify a store-scoped operator reopening an in-scope item gets `forbidden`, and an out-of-scope item gets `not-found`.

**Acceptance Scenarios**:

1. **Given** `dismissed` U at (T, S) with no current `pending` sibling, **When** a tenant-wide principal reopens U, **Then** a fresh `pending` U' is created at (T, S) (005 FR-005); U stays `dismissed` (005 FR-004); both the reopen and U' capture are audited (006 FR-110).
2. **Given** a `pending` sibling for U's logical identifier already exists at (T, S), **When** the client reopens U, **Then** the operation returns an "already pending" outcome pointing to the existing record; no duplicate `pending` is created (006 FR-063).
3. **Given** U is `resolved`, **When** any client attempts reopen, **Then** the operation returns `already-reconciled` with `details.prior_state = resolved` (006 FR-062 / FR-100); no route to alter `resolved` state is offered.
4. **Given** a store-scoped operator and an item dismissed **within** their scope, **When** the client reopens it, **Then** the operation returns `forbidden` revealing only "tenant-wide authority required" (006 FR-062a / FR-100), and the rejection is audited (006 FR-111).
5. **Given** a store-scoped operator and an item dismissed **outside** their scope, **When** the client reopens it, **Then** the operation returns non-disclosing `not-found` (005 SI-004 / 006 FR-062a).

---

### User Story 8 — Client bulk-dismisses a bounded selection (Priority: P2)

A reviewer's client submits a bulk-dismiss request listing up to 200 in-scope `pending` item ids. The operation enforces the 200-item ceiling at the batch boundary (all-or-nothing rejection above it, `validation` category — 006 FR-070); within a valid batch it decomposes into N per-item dismiss operations under 005's existing dismiss contract (006 FR-070a), each item succeeding or failing independently with mixed-success per-item outcomes, every successful dismiss audited.

**Why this priority**: Bulk dismiss is the only safe bulk action (006 FR-070–FR-073) and materially speeds queue clearing, but it is a UX-layer batching of an existing semantic, not a new capability. P2.

**Independent Test**: Submit a bulk-dismiss of a mixed selection (some `pending` in-scope, some already-terminal, some out-of-scope) within 200 — verify each item's per-item outcome is reported per FR-100 (`dismissed` success, `already-reconciled` for terminal siblings, `not-found` for out-of-scope) without affecting other items, and every success is audited. Submit 201 items — verify the whole batch is rejected with `validation` and no item is dismissed (006 SC-008).

**Acceptance Scenarios**:

1. **Given** a selection of ≤ 200 in-scope `pending` ids, **When** the client submits bulk-dismiss, **Then** each id is dismissed under 005's per-item contract (006 FR-070a), every success is audited, and the operation returns per-item outcomes (006 SC-008).
2. **Given** a selection of > 200 ids, **When** the client submits, **Then** the operation rejects the whole batch with a `validation` failure and dismisses no item (006 FR-070).
3. **Given** a selection mixing `pending` in-scope, already-terminal, and out-of-scope ids within the ceiling, **When** the client submits, **Then** each item reports its own outcome (`dismissed` / `already-reconciled` with `details.prior_state` / `not-found`) without affecting siblings (006 SC-008).

---

### User Story 9 — Client receives structured, non-disclosing failures (Priority: P2)

Every failure the API returns uses the closed FR-100 category set as a structured envelope: `validation`, `target-unavailable`, `alias-conflict`, `idempotency-token-mismatch`, `already-reconciled` (with optional `details.prior_state`), `not-found`, `forbidden`, `system-failure`. The envelope is non-disclosing per 006 FR-090: a caller cannot distinguish "does not exist" from "exists but you lack authority." Failures the API returns are deterministic per logical action + authoritative state + actor scope, and audited where 005 mandates.

**Why this priority**: Without a categorized, non-disclosing failure envelope the API leaks data or confuses clients. P2 — the safety net around the P1 success paths (006 US9).

**Independent Test**: Exercise each FR-100 category through the operations: malformed body (`validation`); non-active target (`target-unavailable`); uniqueness violation (`alias-conflict`); replay with a changed body under the same idempotency token (`idempotency-token-mismatch`); concurrent race and terminal-state retry (`already-reconciled`, with and without `details.prior_state`); cross-tenant / out-of-scope target (`not-found`); in-scope reopen by a store operator (`forbidden`); injected backend fault (`system-failure`). For each verify: the category is correct, the envelope reveals no out-of-scope existence, and an audit event exists where 005 FR-082 requires.

**Acceptance Scenarios**:

1. **Given** any operation 005 rejects, **When** it surfaces, **Then** the API returns a category from the FR-100 closed set and no category leaks out-of-scope existence (006 FR-100 / FR-101).
2. **Given** identical inputs, authoritative state, and actor scope, **When** an operation is repeated, **Then** the API returns the same category and the same non-disclosing wording (006 FR-091).
3. **Given** a `system-failure`, **When** the client retries, **Then** the operation either succeeds idempotently or returns the same outcome — no hidden partial commit (006 FR-102 / 005 SC-007).

---

### User Story 10 — Every state change carries idempotency and audit (Priority: P2)

State-changing operations (link, create, dismiss, reopen, bulk-dismiss) accept an idempotency token and consume 005 / 001's idempotency primitive: a safe retry with the same token and body completes idempotently; the same token with a changed body returns `idempotency-token-mismatch`. Every successful action and every failed action 005 audits emits a business-level audit event attributable to the principal with a correlation id, retrievable through 005's existing audit surface — 007 introduces no parallel idempotency or audit channel.

**Why this priority**: Idempotency and audit are mandated by Constitution §II / §XII / §XIV and by 005, and are the integrity floor for any state-changing API. P2 — they underpin trust without being the client's primary task (006 US10).

**Independent Test**: Submit each state-changing operation twice with the same idempotency token and identical body — verify exactly one state change and one success result. Submit the same token with a changed body — verify `idempotency-token-mismatch`. For each successful and audited-failure action, query 005's audit surface and verify an event with the correct tenant, store, actor, action, target, correlation id, and timestamp.

**Acceptance Scenarios**:

1. **Given** a state-changing operation with idempotency token K and body B, **When** the client retries with the same K and B, **Then** exactly one state change occurs and both calls observe the same success outcome (005 idempotency primitive).
2. **Given** token K previously used with body B, **When** the client submits K with a different body B', **Then** the API returns `idempotency-token-mismatch` (006 FR-100) and no new state change occurs.
3. **Given** any successful or audited-failure action, **When** 005's audit surface is queried within the actor's authority, **Then** a corresponding event exists attributable to the principal with a correlation id (005 FR-080 / FR-082 / 006 FR-110 / FR-111 / FR-112).

---

### Edge Cases

- **Cross-tenant or out-of-scope id supplied to any operation** → non-disclosing `not-found`; never a distinct "exists but forbidden" signal except the explicit in-scope reopen `forbidden` case (006 FR-090 / FR-062a / SI-004).
- **Caller loses store access mid-session** → the next operation is refused with a non-disclosing outcome; the contract carries no stale-cache assumption, so a re-list reflects the narrowed scope with no placeholder implying out-of-scope existence (006 FR-090 / edge case).
- **Stale client view (item reconciled by another reviewer since last list)** → the action returns `already-reconciled` (with `details.prior_state` if terminal) or `not-found`; the caller is not penalized; no destructive default (006 FR-036 / FR-090).
- **Very large queue** → list operation MUST be paginated/bounded; it MUST NOT return all items at once where doing so harms responsiveness or 005 SC-002 (006 edge case).
- **Filter/facet request from a single-store operator** → facets list only in-scope dimensions; the count or identity of other stores/source systems is never inferable (006 FR-033 / SC-007).
- **Bulk-dismiss above the ceiling** → whole-batch `validation` rejection; no item dismissed (006 FR-070).
- **Bulk-dismiss with a heterogeneous in-ceiling selection** → per-item mixed-success outcomes; one item's failure never affects another (006 SC-008).
- **Replay of a state-changing call with the same idempotency token but a changed body** → `idempotency-token-mismatch`; no second state change (006 FR-100).
- **Concurrent reconciliation of the same item by two clients** → exactly one success; the other `already-reconciled`; one resolution record (005 SC-007).
- **`resolved` item whose linked/created product the caller can no longer see** → the item row remains visible; the product reference is omitted (006 FR-001a) — never a leak, never a full hide of the item.
- **Backend fault mid-action** → `system-failure` that is safe to retry idempotently; no hidden partial commit (006 FR-102 / 005 SC-007).

---

## 6. Requirements *(mandatory)*

All requirements are **contract/behavioral, API-boundary expectations**. They define the operations, their inputs, their outputs, and the guarantees enforced at the boundary. They do **not** prescribe wire format, paths, methods, status codes, field names, framework, or code. Where a requirement consumes 005 / 006 / 003 / 001 behavior, the reference is cited; that behavior is consumed unchanged.

### 6.1 Read operations

- **FR-001**: The API MUST expose a **list operation** for unknown items that returns only items the authenticated principal is authorized to see per 005's authority rules (tenant-wide → all tenant stores; store-scoped → in-scope stores only) and that defaults to `pending`-only results (006 FR-001 / FR-002).
- **FR-002**: The list operation MUST accept **filter** parameters for at least: store (within scope), source system, lifecycle state, and age bucket (006 FR-030). It MUST NOT accept a parameter that widens visibility beyond the caller's authority.
- **FR-003**: The list operation MUST accept **sort** parameters for at least: age (ascending/descending) and store (within scope), using 005's capture timestamp as the age basis (006 FR-031).
- **FR-004**: The list operation MAY accept a **grouping** parameter (store / source system / age bucket); when grouping is applied, buckets that exist only out-of-scope MUST NOT appear (006 FR-032).
- **FR-005**: The list operation MUST support **bounded pagination** (page size limit + opaque continuation cursor) and MUST NOT return all items at once where doing so would harm responsiveness or 005 SC-002 (006 edge case). The page-size ceiling is a **hard maximum of 200 items per page**; the **default page size is 50** when the client supplies none; a requested page size out of range is **rejected with a `validation` failure** (not clamped). This matches the already-shipped 005 `tenantAdminListUnknownItems` contract (`limit` min 1 / max 200 / default 50, 400 on out-of-range — `packages/contracts/openapi/catalog/unknown-items.yaml`), which 007 extends, not redefines. (Note: this read-pagination ceiling of 200 happens to share the numeric value of the FR-044 bulk-dismiss ceiling but is a distinct limit on a distinct operation.)
- **FR-006**: Any **filter-facet** data the list operation returns (available stores, source systems, etc.) MUST list only in-scope dimensions and MUST NOT reveal the count or identity of out-of-scope dimensions (006 FR-033 / SC-007).
- **FR-007**: The list operation MUST return, per `pending` item, the FR-020 safe-context field set: identifier type, identifier value (005-permitted form), source system, capture store (only if in scope), capture timestamp, and lifecycle state (006 FR-020). It MUST NOT return descriptive metadata (006 FR-021a) or any field redacted at the 003/005 logger boundary (006 FR-022).
- **FR-008**: When a client filters to `resolved` or `dismissed` items, the list operation MUST return the FR-001a field set per state — `dismissed`: identifier metadata, capture store, source system, capture + dismissal timestamps, dismissing actor; `resolved`: identifier metadata, capture store, source system, capture + resolution timestamps, resolving actor, `resolution_action`, and the linked/created product reference **only if** the caller has authority to see that product (otherwise omitted, item still returned) (006 FR-001a).
- **FR-009**: The API MUST expose an **inspect operation** that returns a single in-scope item by its opaque id with the FR-020 field set plus advisory hints permitted by FR-012/FR-040, and resolves an out-of-scope or cross-tenant id to a non-disclosing not-found (006 FR-020 / FR-022 / SI-004).
- **FR-010**: The API MUST NOT expose any read operation that returns counts, badges, summaries, or aggregates including out-of-scope items, even anonymized (006 FR-004 / FR-005 / SI-001).

### 6.2 Action operations — link

- **FR-020**: The API MUST expose a **link operation** that accepts a `pending` item id and a target product id and, when 005's link semantics pass, transitions the item to `resolved` with `resolution_action = linked`, binds the identifier as an alias, and emits the audit event — consuming 005 §6.5–§6.6 unchanged (006 FR-040).
- **FR-021**: On link failure the operation MUST return a structured failure with the correct FR-100 category, distinguishing `target-unavailable` from `alias-conflict` (006 FR-043), and MUST leave the item `pending` with no alias or product mutation (006 FR-040 / FR-081).
- **FR-022**: A target product the caller is not authorized to see (out-of-scope or forged id) MUST resolve to non-disclosing `not-found`; the conflicting product's identity MUST NOT be disclosed in an `alias-conflict` failure to a caller lacking authority (006 FR-042 / FR-081 / SI-004).
- **FR-023**: The link operation MUST NOT offer a force-link / override-conflict path (006 SI-005 / SC-003).

### 6.3 Action operations — create-from

- **FR-030**: The API MUST expose a **create-from operation** that accepts a `pending` item id plus the minimal product fields required by 005 FR-060 and, on success, atomically creates the product in tenant scope, binds the identifier as an alias, transitions the item to `resolved` with `resolution_action = created`, and emits audit events — consuming 005 §6.7 / FR-063 unchanged (006 FR-050).
- **FR-031**: On failure (validation, alias conflict, race-lost) the create-from operation MUST fail closed — no product, no alias, no transition (005 FR-062) — return the correct FR-100 category, and leave the item `pending` (006 FR-051).
- **FR-032**: The create-from operation MUST NOT pre-populate forbidden cross-store or cross-tenant data into the new product (006 FR-052); it MAY accept caller-supplied in-scope values only.

### 6.4 Action operations — dismiss, reopen, bulk-dismiss

- **FR-040**: The API MUST expose a **dismiss operation** that transitions a `pending` item to `dismissed` with no alias/product side effect and emits the audit event — consuming 005 FR-003 unchanged (006 FR-060). A dismiss on a terminal item MUST return `already-reconciled` with `details.prior_state` (006 FR-100).
- **FR-041**: The API MUST expose a **reopen operation** restricted to tenant-wide principals (Tenant Admin / Tenant Owner) that creates a fresh `pending` record for the same logical identifier per 005 FR-005, preserves the original `dismissed` row (005 FR-004), and audits both the reopen and the fresh capture (006 FR-061 / FR-110).
- **FR-042**: The reopen operation MUST enforce 006 FR-062a authority mapping: a store-scoped operator reopening an **in-scope** item MUST receive `forbidden` revealing only "tenant-wide authority required"; reopening an **out-of-scope** item MUST receive non-disclosing `not-found`; both rejections MUST be auditable (006 FR-062a / FR-111).
- **FR-043**: A reopen on a `resolved` item MUST return `already-reconciled` with `details.prior_state = resolved` (006 FR-062); a reopen where a `pending` sibling already exists for the same logical identifier at the same store MUST return an "already pending" outcome pointing to the existing record without creating a duplicate (006 FR-063).
- **FR-044**: The API MUST expose a **bulk-dismiss operation** that accepts up to 200 item ids, enforces the 200-item ceiling at the batch boundary (whole-batch `validation` rejection above it, no partial dismiss — 006 FR-070), and within a valid batch decomposes into N per-item dismiss operations under 005's existing dismiss contract (006 FR-070a) with independent per-item outcomes (006 SC-008).
- **FR-045**: The API MUST NOT expose bulk-link, bulk-create, or bulk-reopen operations (006 FR-071 / FR-072 / FR-073).

### 6.5 Response and failure contract

- **FR-050**: Every successful action operation MUST return a response that conveys the resulting lifecycle state and, where applicable, the `resolution_action`, sufficient for the client to refresh its view without a forbidden re-read.
- **FR-051**: Every failure MUST be returned as a **structured failure envelope** carrying a category from the closed FR-100 set: `validation`, `target-unavailable`, `alias-conflict`, `idempotency-token-mismatch`, `already-reconciled`, `not-found`, `forbidden`, `system-failure` (006 FR-100). The envelope MAY carry a `details` object (e.g., `details.prior_state`) but the category vocabulary MUST stay the closed set.
- **FR-052**: Failure envelopes MUST be **non-disclosing** (006 FR-090 / FR-101): a caller MUST NOT be able to distinguish "does not exist" from "exists but you lack authority," except the explicit in-scope reopen `forbidden` case (FR-042). The envelope MUST convey the category and a safe next step without leaking forbidden detail.
- **FR-053**: Failures MUST be **deterministic**: identical logical action + authoritative state + actor scope MUST yield the same category and the same non-disclosing wording (006 FR-091).
- **FR-054**: `system-failure` outcomes MUST be safe to retry: a retry either succeeds idempotently or returns the same outcome, with no hidden partial commit (006 FR-102 / 005 SC-007).

### 6.6 Authority, isolation, idempotency, audit

- **FR-060**: Every operation MUST require an authenticated dashboard principal and MUST enforce 005's authority/scope rules at the API boundary; 007 introduces no parallel authority model (006 FR-092 / SI-003).
- **FR-061**: Cross-tenant access MUST be impossible by construction; any cross-tenant lookup MUST surface as non-disclosing `not-found` (006 FR-003 / SI-001 / SI-004).
- **FR-062**: When authority cannot be determined, the operation MUST fail closed to non-disclosing `not-found` rather than return partial or leaky data (006 SI-008).
- **FR-063**: Every state-changing operation MUST be **safe to retry** with no duplicate effect (consuming 005 / 001's monotonic-lifecycle + idempotency primitive). Two retry guarantees apply at different strengths (reconciled during `/speckit-plan` against the already-shipped 005 ops — see plan §4.6):
  - **No-duplicate-effect (all state-changing operations)**: a retry MUST NOT produce a second lifecycle transition, second alias, or second audited side effect. The shipped link / create / dismiss operations achieve this via their monotonic `WHERE resolution_status = 'pending'` guard; a retry of an already-applied action returns `already-reconciled` rather than re-applying.
  - **Identical-replay-response (key-bearing operations)**: the new operations that accept an idempotency token (the 007-introduced reopen and bulk-dismiss, plus the shipped `posCaptureItem` which is out of 007 scope) MUST, on a retry with the same token and body, return the **prior response** without re-applying; the same token with a changed body returns `idempotency-token-mismatch` (006 FR-100, shipped wire code `idempotency_key_conflict`). Adding token-bearing identical-replay to the *shipped* link / create / dismiss operations is a behavior change to live operations and is deferred to a human-sign-off decision in the GATED contract slice (plan §4.6), not assumed here.
  007 introduces no parallel idempotency channel; the token is the existing `Idempotency-Key` primitive.
- **FR-064**: Every successful action and every failed action 005 audits (005 FR-082) MUST emit a business-level audit event attributable to the principal with a correlation id, retrievable through 005's existing audit surface (006 FR-110 / FR-111 / FR-112 / FR-113). 007 introduces no parallel audit channel.
- **FR-065**: No operation MUST silently create a tenant product or mutate reconciliation state without an audit event; product creation is always a caller-initiated create-from action (006 SI-006 / SI-009).

### 6.7 Candidate-match hint (excluded from v1)

- **FR-070**: The inspect operation MUST NOT include the advisory candidate-match hint in v1 (clarified 2026-05-29). The inspect operation returns the FR-009 / FR-020 safe-context field set only; no v1 operation queries, ranks, or returns candidate products. 006 FR-080 leaves the hint as MAY, and 007 v1 takes the "not surfaced" branch: the hint is a separate v2 opt-in feature carrying its own query-cost analysis and Impeccable critique. 006 FR-080's safety boundaries remain mandatory **if and when** the hint is ever surfaced in a future version — candidates sourced strictly within the caller's authority; out-of-scope products/aliases never considered, ranked, or presented; advisory only (no auto-link, no pre-select); and when no in-scope candidate exists, the hint omitted (never a "none found" message that hints at out-of-scope state) — but 007 v1 implements none of that surface.

### Key Entities

This spec introduces **no new entities.** It exposes, through API operations, the entities 003 / 005 already own:

- **Unknown Item** — per 005 §6 / 003 §6. The read operations are an authority-scoped projection over `unknown_items`; the action operations dispatch 005's lifecycle transitions. 007 adds no column, table, or index.
- **Tenant Product** — per 003 §5. Link targets and create-from outputs.
- **Product Alias** — per 003 §6. Created/reactivated by link and create-from.
- **Actor Principal** — per 001 / 002 / 005. Tenant-wide and store-scoped dashboard principals.
- **Audit Event** — per 005 §6.9 / 001's audit pipeline. Emitted by every audited operation; no new event category.
- **Idempotency Token / Record** — per 001 / 005. Consumed by every state-changing operation; no new primitive.

---

## 7. Security & Isolation Requirements

- **SI-001**: No tenant MUST observe another tenant's unknown items, identifiers, descriptive metadata, candidate matches, or reconciliation activity through any 007 operation — by direct read or inference via counts, facets, pagination totals, empty states, error envelopes, or audit retrieval (006 SI-001 / 005 SI-001).
- **SI-002**: A store-scoped principal MUST NOT observe or act on items, identifiers, candidate matches, or reconciliation activity at out-of-scope stores through any 007 operation (006 SI-002 / 005 SI-002).
- **SI-003**: Tenant-wide principals MAY act across all tenant stores only insofar as 001's membership/scope model grants tenant-wide authority. 007 does not relax that model (006 SI-003).
- **SI-004**: All cross-tenant and out-of-scope failures MUST be non-disclosing — the caller cannot tell whether the target exists — except the explicit in-scope reopen `forbidden` case (FR-042) (006 SI-004 / FR-090).
- **SI-005**: Every reconciliation operation MUST fail closed when 005 mandates it; no operation MUST offer a force-link / override-conflict path (006 SI-005 / SC-003).
- **SI-006**: No operation MUST silently create a tenant product; create-from is always caller-initiated (006 SI-006).
- **SI-007**: PII posture is unchanged. Identifier values are catalog reference data; descriptive metadata in `unknown_items.sale_context jsonb` is held back entirely in v1 (006 FR-021a) and remains subject to 003 §8 / Constitution §XIV redaction posture. 007 introduces no new redaction surface and weakens no existing posture (006 SI-007).
- **SI-008**: Errors MUST fail closed. When authority cannot be determined, an operation MUST default to non-disclosing `not-found` rather than render partial/leaky data (006 SI-008).
- **SI-009**: Any operation that changes reconciliation state MUST be auditable per 005 §6.9 — no silent state change (006 SI-009).
- **SI-010**: Every state-changing operation MUST be idempotent under 005 / 001's idempotency primitive — a replay MUST NOT produce a duplicate state change or a hidden partial commit (005 SC-007).
- **SI-011**: 007 operations MUST inherit the existing platform rate-limit / abuse-protection posture (001 / 004) and MUST NOT weaken it; 007 introduces **no new per-operation rate limit in v1** (clarified 2026-05-29). Read operations are bounded by the FR-005 page-size ceiling and bulk-dismiss by the FR-044 200-item ceiling; no operation MUST offer an unbounded enumeration or unbounded batch that would circumvent the inherited posture or threaten 005 SC-002.

---

## 8. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of `pending` items at stores within a principal's authorized scope are returned by the list operation; 0% of out-of-scope items are returned, in any count, facet, or pagination total. (Measured by isolation tests extended with review-queue-API cases — 006 SC-001 / research §R3.)
- **SC-002**: 0% of cross-tenant or out-of-scope access attempts (read or action) return anything other than a non-disclosing not-found through 007 operations, except the explicit in-scope reopen `forbidden` case. (Measured by the isolation harness — 006 SC-002.)
- **SC-003**: 0% of reconciliation actions completed via 007 create ambiguous aliases; the API offers no override-conflict path. (006 SC-003.)
- **SC-004**: 100% of state transitions completed via 007 (link, create, dismiss, reopen→fresh-pending, bulk-dismiss item-success) are linkable to an audit event by correlation id within 005 SC-004's audit-query SLA. (006 SC-004.)
- **SC-005**: 100% of state-changing operations are retry-safe with no duplicate effect (single lifecycle transition / alias / audited side effect on replay). For the key-bearing operations (007 reopen + bulk-dismiss), a replay with the same idempotency token and body additionally produces one **consistent response**, and the same token with a changed body returns `idempotency-token-mismatch`. (Measured by the idempotency-replay integration suite — 005 SC-007; the no-duplicate-effect guarantee for the reused shipped ops is measured by their existing monotonic-guard tests.)
- **SC-006**: 0% of operations leave a caller with a stale-view ambiguity that yields an incorrect lifecycle outcome: every action either succeeds idempotently or returns `already-reconciled` / `not-found` / `forbidden`, never a silently-incorrect success. (006 SC-006.)
- **SC-007**: A store-scoped principal with no in-scope items receives a "scope is empty" list result and can infer the existence of no out-of-scope item by any signal — count, facet, pagination total, or response timing. (Measured by the isolation harness — 006 SC-007.)
- **SC-008**: Bulk-dismiss enforces the 200-item ceiling at the batch boundary (whole-batch rejection above it) and yields the same per-item correctness as single dismiss within a valid batch: every dismissed item is `dismissed` and audited; every rejected item reports its FR-100 category without affecting siblings. (Measured by the bulk-dismiss integration suite under mixed-success workloads — 006 SC-008.)
- **SC-009**: 100% of failures returned by 007 operations carry a category from the closed FR-100 set and a non-disclosing message; 0% leak out-of-scope existence. (Measured by the failure-category contract suite covering all eight categories — 006 FR-100 / FR-101.)

---

## 9. Assumptions

- **005 Wave 2 is COMPLETE on `main`** (per the project Active-feature record, 2026-05-29), so all link / create / dismiss / reopen / conflict / audit semantics this API exposes are implemented and consumable. Where any consumed 005 behavior were found not yet on `main` at implementation time, that is a dependency, not work for 007 to perform.
- 005's lifecycle, idempotency, reconciliation, conflict, audit, observability, and isolation semantics are authoritative ground truth; 007 consumes them unchanged.
- 006's product requirements are the authoritative user-facing definition; every 007 operation realizes a 006 requirement and adds no user-facing behavior 006 does not specify.
- "Reopen" is fresh-`pending`-record creation (005 FR-005), not lifecycle reversal; reopen authority is tenant-wide only (006 FR-062a).
- The default list result is `pending`-only; `resolved` / `dismissed` are reached via explicit lifecycle filter, with FR-001a field rules.
- Bulk operations: only bulk-dismiss is in scope for v1, capped at 200 ids per submission (006 FR-070). No bulk-link / bulk-create / bulk-reopen.
- List pagination is bounded with a **hard maximum of 200 items per page** and a **default of 50** (FR-005), matching the already-shipped 005 `tenantAdminListUnknownItems` contract; an out-of-range page size is rejected with a `validation` failure (not clamped). This is a distinct limit from the 200-item bulk-dismiss ceiling (FR-044), even though they share the numeric value.
- Rate limiting / throttling: 007 consumes the existing platform rate-limit posture (001 / 004) unchanged and introduces **no new per-operation limits in v1** (clarified 2026-05-29, SI-011). Bulk-dismiss is already bounded at 200 ids per submission, so no fresh throttle is warranted; any future per-operation limit is a separate decision consistent with 007's no-parallel-channel discipline.
- Descriptive metadata (`unknown_items.sale_context jsonb`) is held back entirely in v1 (006 FR-021a). The candidate-match hint is **excluded from v1** (clarified 2026-05-29, FR-070) — 006 FR-080 leaves it MAY and 007 v1 takes the "not surfaced" branch; the hint is a v2 opt-in. 006 FR-080's safety boundaries remain mandatory only if a future version surfaces it.
- Wire format — concrete path strings, HTTP methods, status codes, header names, JSON field names, the OpenAPI YAML, and the runtime validation schemas — is deferred to this feature's `plan.md` / `tasks.md` and the `[GATED]` OpenAPI artifact; this spec pins behavior and contract obligations, not chrome.
- The dashboard UI that consumes these contracts is a separate future feature, routed through Impeccable before any UI code lands (006 §11).
- Authentication uses the existing dashboard-principal mechanism; 007 introduces no new auth mechanism and assumes the existing one.

---

## 10. Dependencies

| Dependency | What 007 relies on it for |
|---|---|
| **specs/006-unknown-items-review-queue** | Authoritative product-level definition of the review experience (visibility, safe-context fields, action meanings, failure categories, audit/isolation expectations). 007 realizes 006's FRs as a contract; it consumes 006 unchanged. **Hard prerequisite.** |
| **specs/005-pos-catalog-sync-reconciliation** | Authoritative source of truth for unknown-item lifecycle, idempotency, link/create/dismiss reconciliation, conflict semantics, audit events, observability signals, isolation guarantees, and the seven base failure categories. **Hard prerequisite — 005 Wave 2 COMPLETE on `main`.** |
| **specs/003-catalog-foundation** | Underlying data model (`tenant_products`, `product_aliases`, `unknown_items`), alias uniqueness, RLS, redaction posture. Consumed transitively via 005. |
| **specs/001-foundation-auth-tenant-store** | Auth, membership/scope model, audit pipeline + correlation-id infrastructure, idempotency primitive. Consumed transitively via 005. |
| **specs/002-pos-operator-identity** | POS principal identity model — referenced indirectly because queue items were captured by POS principals. 007 does not call POS principals. |
| **Constitution v3.0.1** | §II multi-tenant RLS, §III backend authority, §IV contract-first, §IX source-of-truth, §XII object safety, §XIV PII discipline. |

007 introduces **no new dependencies** beyond those it transitively consumes through 005 / 006.

---

## 11. Open Questions

None blocking. The four material ambiguities 006 resolved during its own `/speckit-clarify` (bulk-dismiss ceiling = 200, reopen authority = tenant-wide only, terminal-item detail = FR-001a, v1 advisory scope) are inherited and consumed unchanged. The three behavioral ambiguities surfaced during 007's own `/speckit-clarify` (2026-05-29) are now resolved and recorded in the Clarifications section: (a) the candidate-match hint is **excluded from v1** (FR-070); (b) the list page-size ceiling is a **hard maximum of 200, default 50, reject-on-out-of-range** (FR-005, reconciled during `/speckit-plan` to match the already-shipped 005 list contract); and (c) 007 introduces **no new per-operation rate limit in v1**, inheriting the existing platform posture (SI-011). The sole remaining open item is **HOW-level and intentionally deferred** to `/speckit-plan` and the `[GATED]` OpenAPI artifact: the concrete wire format (paths, methods, status codes, header names, JSON field names, validation-schema shapes). It does not change the behavioral contract this spec pins.
