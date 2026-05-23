# Feature Specification: POS Catalog Sync & Unknown Item Reconciliation

**Feature ID**: 005
**Short name**: pos-catalog-sync-reconciliation
**Status**: Draft
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban
**Depends on**: [specs/003-catalog-foundation](../003-catalog-foundation/spec.md)
**Constitution version**: 3.0.0 — primary touchpoints §II (multi-tenant RLS), §III (backend authority), §IV (contract-first), §IX (Source-of-Truth Model), §X (Retail Temporal Semantics), §XIV (PII discipline)

---

## Clarifications

### Session 2026-05-23

- Q: When a POS at store S submits identifier I and an active alias for I exists in the tenant but is store-scoped to a different store S', how should the platform behave at capture time? → A: Capture as unknown at S; do not auto-resolve cross-store. Reconciliation can later link to the same product, which creates a store-scoped alias at S. (OQ-1 resolved.)
- Q: When a POS resubmits an identifier that was previously dismissed (same tenant, store, identifier type + value + source system), what should happen? → A: Capture a fresh pending unknown-item record; the previously dismissed row stays terminal as audit history. Lifecycle states remain monotonic per record (no dismissed → pending transition). The review queue may surface a "previously dismissed" hint as advisory metadata. (OQ-2 resolved.)
- Q: Should POS submissions be allowed to carry optional descriptive fields (cashier-typed item name, vendor description, etc.) on the unknown-item record? → A: **Only to the extent already supported by 003 today.** 003's `unknown_items` already carries an opaque `sale_context jsonb` field with redaction-at-logger-boundaries (per 003 §8, Constitution §14). If a tenant POS chooses to include descriptive hints, they travel inside that existing field; the platform does NOT interpret them, MUST NOT use them as identity, MUST NOT drive automatic matching from them, and treats them as advisory metadata only. **005 introduces no new column on `unknown_items` and requires no amendment to 003 `data-model.md`.** The first-non-null sticky semantic and any explicit dedicated label field are deferred to a future, separately-specified opt-in feature (see Appendix B). (OQ-3 resolved — revised 2026-05-23 to remove implementation dependency on 003.)
- Q: What are the idempotency token semantics for POS capture submissions — scope, TTL, and mismatch behavior? → A: Token is keyed by the tuple `(tenant_id, device_id, token)`. TTL is approximately 24 hours from first observation. Token-versus-payload mismatch (same token, different logical identifier or different store) fails closed — the system rejects the request with a deterministic conflict outcome and produces no side-effects. This spec pins these semantics; 002's POS contract may further refine but must not contradict them. (Idempotency clarification.)
- Q: What is the capture-latency target for inline POS submissions? → A: p95 ≤ 500 ms, p99 ≤ 1 s, measured at the SaaS boundary (server-side processing time, excluding POS network egress and cashier-side rendering). Applies to single-item capture submissions; bulk-sync submissions are governed by SC-002 throughput, not this latency budget. (Performance clarification.)

---

## 1. Background & Why

POS terminals submit item references during sales and during periodic catalog sync. Some of those references — barcodes, SKUs, PLUs, supplier codes, or vendor-specific POS identifiers — will not yet exist in the tenant's catalog. The platform must accept these submissions without:

- Silently inventing trusted catalog records (which would violate §IX).
- Rewriting sale history when reconciliation later occurs (which would violate §X).
- Letting tenants observe each other's submissions or aliases (which would violate §II and §XIV).
- Producing ambiguous aliases that resolve a single identifier to two different products.

The Catalog Foundation (003) already defines the data shapes: `tenant_products`, `product_aliases`, and `unknown_items`, including alias uniqueness rules, the unknown-item lifecycle states, and RLS for all three tables. **What 003 does not define is the workflow** — how a POS submission becomes an unknown item, how a tenant admin clears the review queue, how repeats become idempotent, and what audit signals are emitted along the way.

This feature specifies that workflow at the product level only. It is the bridge between POS ingestion and the catalog source-of-truth model. Implementation lands in a later, separately-gated feature.

---

## 2. Goals

- Define the end-to-end product workflow that turns a POS-submitted item reference into either (a) a resolved alias on an existing tenant product, (b) a new tenant product, or (c) a captured unknown-item record awaiting human reconciliation.
- Define idempotency so a POS retrying the same submission never produces duplicate unknown-item records or duplicate aliases.
- Define the reconciliation paths — *link to existing product* and *create new product* — and the precise effect each has on aliases and on the originating unknown-item record.
- Define alias conflict handling so reconciliation **fails closed** when it would produce ambiguity.
- Define isolation expectations across tenants, across stores, and across role scopes for every step of the workflow.
- Define business-level audit and observability expectations so reconciliation actions are traceable to an actor with a correlation id.
- Define user-visible outcomes (success and failure) at a product level — without prescribing API shape, status codes, screens, or schema.

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, workers, or jobs.
- No `plan.md`, `tasks.md`, `data-model.md`, `research.md`, or contract YAML in this PR.
- No DB schema changes, Drizzle schema, or SQL migrations. Catalog tables remain as defined in 003.
- No OpenAPI files, package files, lockfiles, CI changes, generated files, or app source modifications.
- No API endpoint design. No dashboard UI screens. No POS app implementation. No client SDK shape.
- No inventory, orders, sales, refunds, invoices, reporting, billing, dbt, ClickHouse, Dagster, analytics, or observability dashboard work.
- No change to existing alias uniqueness or RLS rules from 003 — this spec consumes them, it does not redefine them.
- No automatic creation of tenant products from POS submissions. The unknown-item flow is the only path; auto-create remains explicitly forbidden until a separately-specified opt-in feature lands (consistent with 003 §6.3 Q10 resolution).
- No tax engine, no pricing engine, no promotions engine.
- No POS-side behaviour for the sale itself when an unknown item occurs (block / allow at zero / allow with override). That belongs to a future sales feature.

---

## 4. Actors

| Actor | Role in this workflow |
|---|---|
| **POS Device / POS Backend** | Submits item references during sale and sync. Triggers unknown-item capture. Authenticates per spec 002. Has no read access to tenant-admin reconciliation surfaces. |
| **Store Operator / Store Manager** | Reviews unknown items captured at their store. May reconcile within their store scope only. Cannot reconcile across stores unless granted tenant-level authority. |
| **Tenant Admin** | Reviews and reconciles unknown items across all stores in their tenant. May link to existing products or create new tenant products. May dismiss invalid items. |
| **Tenant Owner** | Same authority as Tenant Admin for this workflow. Listed for completeness. |
| **Platform Operator** | No direct access to tenant data. Reads aggregate platform-wide signals (e.g., unknown-item capture rate) for operational health only. Cannot read tenant-specific unknown items or aliases. |
| **Anonymous / unauthenticated** | No access whatsoever. |

Cross-store reconciliation by tenant admins is permitted **only if the existing tenant-membership / store-scope model grants tenant-wide authority**. The spec does not introduce a new permission; it consumes 001's permission model.

---

## 5. User Scenarios & Testing *(mandatory)*

### User Story 1 — POS captures an unknown item without breaking the sale (Priority: P1)

A POS device scans an identifier (barcode, SKU, PLU, or external POS id) during a sale or sync push. The platform looks up the identifier against the tenant's active aliases. If no match is found, the platform records the submission as an unknown item scoped to the correct tenant and store, returns a deterministic acknowledgement that includes a stable unknown-item reference, and emits the appropriate audit / observability signal. The POS continues operating — what happens to the sale itself at the POS is out of scope for this spec.

**Why this priority**: This is the entry point. Without capture, none of the downstream reconciliation paths matter. It must also be safe-by-default — capture cannot silently mint a trusted catalog record, and it cannot leak across tenants.

**Independent Test**: A POS authenticated to tenant T and store S submits an identifier the tenant has never seen. Verify: (a) an unknown-item record exists scoped to (T, S) with status pending; (b) no `tenant_products` row was created; (c) the response is deterministic and references the captured record by a stable id; (d) a parallel POS authenticated to a different tenant cannot see this record by any means.

**Acceptance Scenarios**:

1. **Given** a POS authenticated to tenant T and store S, **and** identifier I is unknown to T's catalog (no alias match anywhere in T), **When** the POS submits I, **Then** an unknown-item record is created with `tenant_id = T`, `store_id = S`, lifecycle state `pending`, and the response references the record by a stable identifier visible only to T.
2. **Given** the POS retries the exact same submission (same identifier, same identifier type, same source system if applicable, same store), **When** the retry arrives, **Then** the platform returns the *same* unknown-item reference as the first call and does not create a second record.
3. **Given** the POS submits an identifier I that already resolves to an active alias for product P in tenant T (tenant-wide or for store S per the alias scope rules), **When** the lookup succeeds, **Then** no unknown-item record is created; the platform returns a resolved reference to P; no alias is mutated.
4. **Given** POS authenticated to tenant T submits identifier I and another tenant T' also has an unknown item for I, **When** the submission is processed, **Then** T's record and T'`s record are fully isolated; neither tenant can observe the other's record by id, by listing, or by any conflict response.
5. **Given** the POS submission omits a required field (identifier value, identifier type), or sends a malformed payload (out-of-range length, non-printable characters, unsupported identifier type), **When** validation runs, **Then** the submission is rejected with a deterministic failure outcome; no unknown-item record is created; no alias is created; an observability signal records the rejection by category but not by raw value.

---

### User Story 2 — Tenant admin reviews and reconciles the queue (Priority: P1)

Tenant admins (and tenant-wide owners) see a review queue of pending unknown items scoped to their tenant. For each item they can: link it to an existing tenant product (which creates or updates the appropriate alias), create a new tenant product (which carries the alias forward), or dismiss the item as invalid. Every action is auditable. Store-scoped operators see only items captured at stores they have access to and can reconcile only within that scope.

**Why this priority**: Capture without reconciliation accumulates noise. P1 reconciliation paths must exist alongside P1 capture so the workflow forms a closed loop in MVP.

**Independent Test**: Given a tenant with three pending unknown items captured across two stores, verify: (a) a tenant admin sees all three; (b) a store manager scoped to store S1 sees only items captured at S1; (c) linking item to an existing product transitions the item to `resolved`, attributes the action to the acting principal, and produces the expected alias write; (d) creating a new product from an unknown item also transitions the item to `resolved` and produces both the product and the alias; (e) dismissing transitions the item to `dismissed` and produces no alias.

**Acceptance Scenarios**:

1. **Given** unknown item U is pending in tenant T at store S, **and** product P exists and is active in T's catalog, **When** a tenant admin links U to P, **Then** U transitions to `resolved` with resolution action `linked`, an alias is created (or, if a retired alias already matches, reactivated) referencing P with the identifier captured in U, and the action is auditable to the acting principal with a correlation id.
2. **Given** unknown item U is pending in tenant T at store S, **When** a tenant admin chooses *create new product* and supplies the minimal product fields required by the existing tenant-product contract, **Then** a new `tenant_products` record is created in T, an alias is created referencing it with the identifier captured in U, and U transitions to `resolved` with resolution action `created`.
3. **Given** unknown item U is pending, **When** a tenant admin dismisses U as invalid, **Then** U transitions to `dismissed`, no alias is created, no product is created, and the action is auditable.
4. **Given** a store manager scoped only to store S1, **When** they list unknown items, **Then** they see only items captured at S1 — not items captured at other stores in the same tenant.
5. **Given** a store manager scoped only to S1 attempts to reconcile an unknown item captured at S2 (e.g., by guessing its reference), **When** the action is submitted, **Then** the platform rejects it with a non-disclosing response that does not reveal whether the item exists.

---

### User Story 3 — Alias conflicts fail closed (Priority: P1)

Reconciliation must never produce ambiguous aliases. If linking or creating would violate the alias uniqueness rules already defined in 003 §6, the operation fails closed: the unknown item stays `pending`, no alias is created, no product is created, and the operator receives a deterministic conflict outcome that names the *category* of conflict (e.g., "alias already bound to a different product") without leaking the conflicting product's details unless the actor has authority to see them.

**Why this priority**: This is the safety floor for the whole feature. Without it, reconciliation could silently create overlapping aliases and downstream sales would resolve the same scan to two different products — a §IX violation.

**Independent Test**: Pre-seed tenant T with an active tenant-wide alias on identifier I bound to product P1. Capture an unknown item for the same I (which should not happen if lookup is correct, but is constructed here for conflict-test purposes). Attempt to link the unknown item to product P2. Verify: (a) operation fails with a conflict outcome; (b) U remains `pending`; (c) no new alias row exists; (d) the conflict is observable in the audit / metrics stream.

**Acceptance Scenarios**:

1. **Given** an active alias for identifier I in tenant T already binds I to product P1, **When** a tenant admin attempts to link an unknown item carrying I to product P2, **Then** the operation fails closed; U remains `pending`; no alias mutation occurs; the operator sees a conflict outcome.
2. **Given** an active alias for identifier I in tenant T already binds I to product P1, **When** a tenant admin attempts to create a *new* product from an unknown item carrying I, **Then** the operation fails closed in the same way (no new product is created either).
3. **Given** two tenant admins simultaneously attempt to reconcile the same pending unknown item U, **When** the operations race, **Then** exactly one succeeds; the other receives a deterministic "already reconciled" outcome; U has exactly one resolution record; no duplicate alias is created.
4. **Given** an alias conflict, **Then** the platform emits the `duplicate_alias_conflict` observability signal already named in 003 §9, attributing it to the acting principal and a correlation id.

---

### User Story 4 — Repeats and retries are idempotent (Priority: P2)

POS devices retry on transient failure. A retried submission of the same logical identifier from the same source must not create a second unknown item, must not create a second alias, and must not double-count in observability signals beyond a retry counter.

**Why this priority**: Idempotency is essential for production POS reliability, but the P1 stories already require single-shot correctness. P2 captures the retry surface explicitly so test coverage and contract design lock it in.

**Independent Test**: Submit the same unknown identifier 5 times from the same authenticated POS in rapid succession. Verify exactly one unknown-item record exists; verify the response is identical across all 5 calls; verify retry telemetry increments but capture telemetry does not.

**Acceptance Scenarios**:

1. **Given** POS submits identifier I at tenant T, store S, **When** the same logical submission arrives again (identical identifier + identifier type + source system + store + tenant), **Then** the platform returns the existing unknown-item reference without creating a new record.
2. **Given** POS submits identifier I and the network drops the response, **When** POS retries with a request-level idempotency token consistent with the existing POS contract from 002 (token scoped to `(tenant_id, device_id, token)`, honored for at least 24h), **Then** the platform honors the token: same record, same response, no duplicate side-effects.
3. **Given** identifier I has already been *resolved* (linked or created-new) since the previous POS submission, **When** the POS submits I again, **Then** the platform returns the resolved-product outcome (not an unknown-item outcome). No new unknown-item record is created; no alias is mutated.
4. **Given** a POS device reuses the same idempotency token within its 24h TTL **but** sends a different logical payload (different identifier, type, source system, or store), **When** the request arrives, **Then** the platform rejects it with a deterministic mismatch-conflict outcome distinct from `duplicate_alias_conflict`; no unknown-item record is created; no alias is mutated; the rejection is auditable.
5. **Given** the same opaque token string is supplied by two different POS devices in the same tenant, **When** both requests arrive, **Then** each is treated as an independent idempotency key (no collision); both submissions process on their own merits.

---

### User Story 5 — Reconciliation actions are fully auditable (Priority: P2)

Every state transition — capture, link, create-new, dismiss, reactivate-after-failure — produces a business-level audit event scoped to the tenant, attributed to the acting principal (POS device, store operator, tenant admin), and linked by a correlation id consistent with the audit pipeline established in 001 and the catalog signals defined in 003 §9.

**Why this priority**: Audit is required by Constitution §II/§XII/§XIV but is not part of the user's primary task flow, so it's P2 — must be present, but P1 stories are the value drivers.

**Independent Test**: Drive the full lifecycle of one unknown item from capture → conflict → eventual link. Verify each transition produced an audit event referencing the correct actor, tenant, store (when applicable), and correlation id. Verify no PII (e.g., raw barcode value if redaction is required by §XIV) leaks into observability streams beyond what 003 §9 already permits.

**Acceptance Scenarios**:

1. **Given** any state transition for an unknown item, **When** the transition completes, **Then** an audit event is emitted with: tenant id, store id (if applicable), actor id, actor type, action (`captured` | `linked` | `created` | `dismissed` | `conflict_rejected`), unknown-item reference, target product reference (if applicable), correlation id, and timestamp.
2. **Given** a conflict rejection (US3), **Then** an audit event is still emitted reflecting the attempt and its rejection — failed reconciliation attempts are first-class audit events.
3. **Given** the observability streams already defined in 003 §9 (e.g., `duplicate_alias_conflict`), **When** events emitted by this workflow flow through, **Then** they conform to those names without introducing a parallel naming scheme.

---

### Edge Cases

- **Duplicate external ids across source systems**: Two distinct POS source systems may legitimately use the same external id for different products. Capture and resolution must scope external POS identifiers by `source_system` per 003 §6 alias rules. A submission missing `source_system` for an `external_pos_id` is invalid.
- **Missing store context**: A POS authenticated only at tenant scope without a store binding cannot submit unknown items (every unknown item is store-scoped per 003). Such submissions are rejected with a deterministic outcome.
- **Reconciliation targeting an inactive or retired product**: Linking to a retired product is rejected the same way as a conflict — fail closed, no alias mutation. The operator is told the target is unavailable; the unknown item remains `pending`.
- **Reconciliation targeting a deleted product** (if the catalog allows hard delete): Treated identically to retired — fail closed.
- **Reactivating a previously retired alias**: If reconciliation would re-create an alias that exists in the retired state for the same `(tenant, identifier_type, value, store_scope, product)` tuple, the platform reactivates the existing row rather than inserting a duplicate. The action is still audited as a reconciliation event.
- **Concurrent reconciliation race on the same unknown item** (covered in US3 #3): exactly one succeeds, the other receives a deterministic "already reconciled" outcome.
- **Concurrent reconciliation race producing the same alias from two different unknown items**: exactly one succeeds; the other fails closed as an alias conflict; both audit events are emitted.
- **Bulk capture pressure** (e.g., POS sync push of 10k items, half unknown): the workflow must remain correct under volume — duplicates within the same payload deduplicate to a single unknown-item record per logical identifier; ordering of capture across the payload does not affect final state. (Performance budgets are not set here; see §8 SC-002.)
- **Retry after partial-failure during reconciliation**: If reconciliation fails mid-flight (e.g., alias write succeeds but product create rolls back, or vice versa), the system is left in a consistent state — either both effects committed or neither. The unknown item's lifecycle state reflects reality, never an intermediate.
- **Resolved item resubmitted from a different store of the same tenant**: If the alias is tenant-wide for that identifier type, the lookup resolves at the new store and no unknown-item record is created. If the alias is store-scoped to a different store (per 003 §6 rules), capture proceeds and a new pending unknown-item record is created at the new store (per FR-030a); reconciliation can then link to the existing product, producing a store-scoped alias at the new store. Cross-store boundaries are never crossed silently at capture.
- **Dismissed item resubmitted from the same store**: A fresh `pending` unknown-item record is created (per FR-005). The dismissed row remains terminal — there is no dismissed-to-pending transition. The review queue MAY render a "previously dismissed once" hint so reviewers can decide whether to dismiss again or reconcile this time; this is advisory only and does not affect lifecycle semantics.
- **Tenant admin attempting cross-tenant reconciliation**: Impossible by construction — RLS scoped per 003 §6 ensures the target product is not visible. The attempt fails as a non-disclosing not-found, not as an authorization error.
- **PII / sensitive identifier values**: Identifier values (barcodes, SKUs) are *catalog reference data*, not PII per the existing redaction matrix. Any optional descriptive metadata (per FR-006) that a tenant chooses to send travels inside 003's existing `unknown_items.sale_context jsonb` field, which already mandates redaction at all logger boundaries (per 003 §8 and Constitution §14). This spec does not weaken that posture and introduces no new redaction surface.

---

## 6. Requirements *(mandatory)*

### 6.1 Lifecycle states

- **FR-001**: The system MUST treat unknown-item lifecycle as the closed set of states already defined in 003 §6: `pending`, `resolved`, `dismissed`. No new states are introduced.
- **FR-002**: The system MUST enforce that a `pending` item carries no `resolved_at`, `resolved_by`, or `resolution_action`, and that a `resolved` or `dismissed` item carries all three.
- **FR-003**: The system MUST attach `resolution_action ∈ { linked, created, dismissed }` to every non-pending state, mapping respectively to *link to existing product*, *create new product from unknown item*, and *dismiss as invalid*.
- **FR-004**: Lifecycle transitions MUST be monotonic per record: `pending → resolved`, `pending → dismissed`, and no other transitions are permitted. A `resolved` or `dismissed` row is terminal and MUST NOT be transitioned back to `pending` by any workflow.
- **FR-005**: When a POS resubmits an identifier whose previous unknown-item record in the same tenant + store is `dismissed`, the system MUST treat the resubmission as new evidence: a fresh `pending` unknown-item record is created per FR-020 / FR-032 semantics, and the previously dismissed row is preserved unchanged for audit. The fresh record MAY carry advisory metadata indicating a prior dismissal exists, but this is review-queue UX and not a lifecycle change.
- **FR-006**: POS-supplied descriptive metadata (cashier-typed item name, vendor description, etc.) MUST be treated as **non-identity, non-matching, non-authoritative**: it MUST NOT influence alias resolution, conflict detection, idempotency keys, lifecycle state, or any automated decision. The platform's behavior is determined entirely by the identifier metadata defined in 003 §8 (`identifier_type`, `value`, `source_system`, `store_id`, `tenant_id`). Descriptive metadata is OPTIONAL on every submission; absence MUST NOT cause rejection.
- **FR-006a — No new storage surface**: 005 MUST NOT introduce a new column, table, index, or constraint on `unknown_items` or any other 003 entity. Persistence of optional descriptive metadata is permitted only to the extent that 003's existing `unknown_items.sale_context jsonb` field already supports it (per 003 §8). 005 introduces no schema amendment to 003 and no migration of its own. Any dedicated descriptive-field surface (a typed column, a sticky-first-write rule, structured vendor metadata, etc.) is a future opt-in feature outside the scope of 005 — see Appendix B for forward-looking guidance.

### 6.2 Tenant and store scoping

- **FR-010**: Every unknown-item record MUST carry a non-null `tenant_id` and a non-null `store_id` consistent with the POS principal's resolved store binding.
- **FR-011**: The system MUST reject POS submissions where the principal has no resolved store binding.
- **FR-012**: Unknown-item visibility MUST follow the RLS rules established in 003 for the `unknown_items` table without modification.
- **FR-013**: Cross-tenant access — read or write — MUST be impossible and MUST surface as a non-disclosing not-found, never as an authorization error that reveals existence.
- **FR-014**: Store-scoped operators MUST see only unknown items in stores they have access to. Tenant-wide actors (Tenant Admin / Tenant Owner) MUST see all unknown items in their tenant.
- **FR-015**: Cross-store reconciliation by a tenant admin MUST be permitted only if the existing membership model grants tenant-wide authority. No new permission is introduced.

### 6.3 Idempotency for POS submissions

- **FR-020**: The system MUST treat repeated POS submissions of the same logical identifier (identifier type, value, source system where applicable, store, tenant) as idempotent: at most one `pending` record exists per logical identifier within a tenant.
- **FR-021**: When the existing POS contract from 002 supplies a request-level idempotency token, the system MUST honor it for unknown-item capture: the same token produces the same response and the same side-effects.
- **FR-021a — Token scope**: Idempotency tokens supplied with POS capture submissions MUST be keyed by the tuple `(tenant_id, device_id, token)`. Two devices submitting the same opaque token string within the same tenant MUST be treated as independent idempotency keys; collisions across devices MUST NOT occur. A device's `device_id` is the authenticated POS principal's stable device identity established by spec 002.
- **FR-021b — Token TTL**: The platform MUST honor a captured idempotency token for at least 24 hours from the timestamp of its first observation. After the TTL elapses, the same token MAY be reused for a new submission and MUST be treated as a fresh request. The platform MAY garbage-collect expired tokens; the TTL is a minimum honor window, not a maximum retention.
- **FR-021c — Token / payload mismatch fails closed**: Within the TTL window, if a previously-seen idempotency token is reused with a *different* logical payload (a different identifier type, value, source system, or store from the original submission keyed by that token), the platform MUST reject the request with a deterministic conflict outcome. No new unknown-item record is created; no alias is mutated; no audit event records the rejected submission as a successful capture (it MUST be observable as a rejected-mismatch event distinct from a `duplicate_alias_conflict`).
- **FR-022**: When an identifier has been resolved since a prior submission, a new submission MUST return the resolved-product outcome and MUST NOT create a new unknown-item record.

### 6.4 Duplicate detection on capture

- **FR-030**: On every POS submission, the system MUST first attempt to resolve the identifier against the active alias set per 003 §6 alias scope rules (tenant-wide vs. store-scoped vs. `external_pos_id` by source system).
- **FR-030a**: Resolution at capture time MUST respect the *submitting* store's scope. Specifically, a store-scoped alias bound to a different store of the same tenant MUST NOT resolve a submission from store S. Such submissions resolve as if the identifier were unknown at S and proceed to unknown-item capture per FR-031. Tenant-wide aliases (and `external_pos_id` aliases scoped by `source_system` per 003 §6) resolve normally for any store of the tenant.
- **FR-031**: When resolution succeeds, the system MUST NOT create an unknown-item record and MUST return the resolved-product outcome.
- **FR-032**: When resolution fails and a `pending` unknown-item record already exists for the same logical identifier in the same store, the system MUST return that existing record's reference rather than create a second one.

### 6.5 Alias uniqueness and conflict behavior

- **FR-040**: Alias uniqueness rules defined in 003 §6 (tenant-wide partial unique, external-pos-id by `source_system`, store-scoped partial unique) are the canonical authority. This workflow MUST NOT bypass them.
- **FR-041**: Any reconciliation action that would violate an active alias unique index MUST fail closed: no alias mutation, no product mutation, the unknown item remains `pending`.
- **FR-042**: Alias conflict responses MUST NOT disclose the conflicting product to an actor without authority to see that product. They MUST name the category of conflict.
- **FR-043**: The system MUST emit the `duplicate_alias_conflict` observability signal defined in 003 §9 for every conflict rejection, attributed to the acting principal and correlation id.

### 6.6 Reconciliation — link to existing product

- **FR-050**: Linking an unknown item U to an existing tenant product P MUST: (a) verify P is active in the same tenant as U; (b) create or reactivate an alias on P with the identifier captured in U; (c) transition U to `resolved` with `resolution_action = linked`; (d) emit the corresponding audit event.
- **FR-051**: If P is retired, deleted, or in any other non-active state, the operation MUST fail closed with a deterministic "target unavailable" outcome. U remains `pending`.
- **FR-052**: If the alias to be created would conflict per FR-041, the operation MUST fail closed; U remains `pending`; no alias mutation occurs.
- **FR-053**: All link operations MUST be transactional: the alias write and the unknown-item state transition succeed together or neither occurs.

### 6.7 Reconciliation — create new product

- **FR-060**: Creating a new tenant product from an unknown item MUST require the minimal product fields already required by the tenant-product contract from 003 §5. This spec does not introduce new mandatory product fields.
- **FR-061**: Successful creation MUST: (a) create the tenant product in U's tenant; (b) create an alias on it with the identifier captured in U; (c) transition U to `resolved` with `resolution_action = created`; (d) emit the corresponding audit events.
- **FR-062**: If the alias to be created would conflict per FR-041, the entire operation MUST fail closed — neither the product nor the alias is created; U remains `pending`.
- **FR-063**: All create operations MUST be transactional: product, alias, and lifecycle transition succeed together or none occur.

### 6.8 Invalid / incomplete / malformed POS payloads

- **FR-070**: Submissions missing required fields (identifier value, identifier type, store binding) MUST be rejected without side-effects.
- **FR-071**: Submissions with malformed values (value length outside the bounds enforced by 003 §6 for aliases, unsupported `identifier_type`, missing `source_system` for `external_pos_id`) MUST be rejected without side-effects.
- **FR-072**: Rejections MUST produce a deterministic failure outcome distinguishable from a successful unknown-item capture. The category of failure MUST be observable; raw identifier values MUST NOT appear in observability streams unless 003 §9 already permits.

### 6.9 Audit and observability expectations

- **FR-080**: Every state transition (capture, link, create, dismiss, conflict-rejection) MUST emit one audit event attributed to the acting principal with a correlation id.
- **FR-081**: Observability signal names MUST conform to the catalog signals defined in 003 §9. This spec does not introduce a parallel naming scheme.
- **FR-082**: Failed reconciliation attempts (conflict, target-unavailable, race-loser) MUST emit audit events — failure is a first-class action.
- **FR-083**: Audit events MUST be retrievable by the same audit-query surface established for catalog operations in 003.

### 6.10 User-visible outcomes

- **FR-090**: Success outcomes MUST be deterministic per logical action: same input + same state → same response.
- **FR-091**: Failure outcomes MUST distinguish at least these categories: validation-failure, target-unavailable, alias-conflict, idempotency-token-mismatch (per FR-021c, distinct from alias-conflict), already-reconciled (race-loser), not-found (cross-tenant or out-of-scope), system-failure. The specific transport encoding is deferred to a future API spec.
- **FR-092**: All outcomes MUST avoid leaking the existence of records the actor does not have authority to see.

### Key Entities

This spec introduces **no new entities**. It consumes the following from 003:

- **Unknown Item** (`unknown_items` per 003 §6): a capture-only record of a POS-submitted identifier that did not resolve to a known product. Scoped to (tenant, store). Lifecycle states `pending` / `resolved` / `dismissed`.
- **Product Alias** (`product_aliases` per 003 §6): the authoritative mapping from an external identifier (barcode, SKU, PLU, supplier code, external POS id) to a tenant product, with the uniqueness rules defined in 003.
- **Tenant Product** (`tenant_products` per 003 §5): the authoritative tenant-owned product record. Reconciliation reads it (link) and writes it (create-new).
- **Actor Principal** (per 001 + 002): POS device / store operator / tenant admin / tenant owner. This spec consumes the existing identity model; it does not modify it.

---

## 7. Security & Isolation Requirements

- **SI-001**: A tenant MUST NOT observe another tenant's unknown items, aliases, products, or reconciliation records by any means — direct read, indirect inference via error messages, conflict responses, or audit retrieval.
- **SI-002**: Store-scoped operators MUST NOT observe or act on unknown items captured at stores outside their scope.
- **SI-003**: Tenant-wide actors MAY act across all stores in their tenant only if the existing membership / scope model grants tenant-wide authority. This spec does not relax the existing model.
- **SI-004**: All cross-tenant or out-of-scope failures MUST be non-disclosing (the actor cannot tell whether the target exists).
- **SI-005**: All conflicts MUST fail closed. The platform MUST NOT, under any circumstance, create an alias that would resolve a single identifier to two distinct products within the same scope.
- **SI-006**: The platform MUST NOT silently create tenant products from POS submissions. Product creation is a human-driven reconciliation action only.
- **SI-007**: Identifier values are catalog reference data and are not subject to PII redaction. Any optional descriptive metadata (per FR-006) a tenant chooses to send is carried inside 003's existing `unknown_items.sale_context jsonb`, which already mandates redaction at all logger boundaries per 003 §8 and Constitution §14. 005 introduces no new redaction surface and does not weaken the existing posture.

---

## 8. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of POS submissions for unknown identifiers in a tenant produce exactly one `pending` unknown-item record per logical identifier, regardless of retry count, within a single store scope. (Measured by reconciliation-queue uniqueness audits.)
- **SC-002**: Bulk POS sync pushes containing up to 10,000 items, with up to 50% unknown, produce a count of unknown-item records equal to the count of distinct logical unknown identifiers in the payload — no more, no less. (Measured by integration test under the unknown-mix workload.)
- **SC-003**: 0% of reconciliation actions create ambiguous aliases. (Measured by an invariant check: for every active alias scope key defined in 003 §6, exactly zero rows have a count > 1.)
- **SC-004**: 100% of state transitions on unknown items are linkable to an audit event by correlation id within the audit-query SLA already defined for catalog operations in 003.
- **SC-005**: 0% of cross-tenant or out-of-scope access attempts succeed; 100% surface as non-disclosing not-found responses, verified by the existing isolation test harness extended with unknown-item / reconciliation cases.
- **SC-006**: Tenant admins can clear a pending unknown-item queue of 50 items in under 10 minutes of focused work, assuming a representative mix of link / create / dismiss actions. (Measured by usability dry-run; treat as a directional target for the eventual UI feature, not a gate on this spec.)
- **SC-007**: 0% of reconciliation operations leave the system in a partially-committed state (alias without lifecycle transition, lifecycle transition without alias, product without alias when create-new was the path). Verified by transactional-integrity tests.
- **SC-008**: Inline POS capture submissions (single-item, not bulk sync) complete server-side within **p95 ≤ 500 ms and p99 ≤ 1 s**, measured at the SaaS boundary — i.e., the elapsed time from receipt of the request at the API edge to dispatch of the response, excluding POS-side network egress, ingress, and cashier-side rendering. Bulk catalog-sync submissions are governed by SC-002 throughput rather than this latency budget. Measured continuously in production via the observability surface and verified in pre-release load tests against a representative tenant catalog size.

---

## 9. Assumptions

- The Catalog Foundation (003) data model — `tenant_products`, `product_aliases`, `unknown_items`, their RLS, their alias uniqueness indexes, and the `pending` / `resolved` / `dismissed` lifecycle — is the authoritative ground truth for this workflow. 003's spec is clarified but not yet implemented at runtime; this feature cannot ship before 003 implements those structures.
- POS Operator Identity (002) supplies authenticated principals for POS submissions, including the tenant and resolved store binding. No new identity surface is introduced here.
- Foundation (001) supplies the audit pipeline, the correlation-id infrastructure, the membership / scope model, and the idempotency-token primitive consumed in FR-021.
- The redaction matrix and PII posture are already defined in 003 §10 and the existing redaction-matrix template. This spec does not amend them.
- The catalog signals named in 003 §9 (e.g., `duplicate_alias_conflict`, capture / resolve / dismiss counters) are the canonical observability surface this workflow emits into.
- "Active" alias resolution semantics — exclude `retired_at IS NOT NULL` rows — are exactly as defined in 003 §6.
- The minimal fields required to create a tenant product from an unknown item are those already required by 003 §5 for `tenant_products`. This spec does not introduce new mandatory product fields.
- The unknown-item review queue is consumed by a future dashboard / admin UI feature, out of scope here. This spec defines what the queue *contains* and how *actions* on it behave, not how it is rendered.

---

## 10. Dependencies

| Dependency | What we rely on it for |
|---|---|
| **specs/003-catalog-foundation** | Authoritative data model: `tenant_products`, `product_aliases`, `unknown_items`, alias uniqueness rules, lifecycle states, RLS, audit signals, redaction posture. **Hard prerequisite.** Implementation of 003's data layer must land before this workflow can ship. |
| **specs/002-pos-operator-identity** | Authenticated POS principals with tenant + store binding. Source of the idempotency token primitive consumed by capture. |
| **specs/001-foundation-auth-tenant-store** | Tenant / store / membership model, audit pipeline, correlation-id infrastructure, RBAC scoping consumed by this workflow without modification. |
| **Constitution v3.0.0** | §II (multi-tenant RLS), §III (backend authority — POS cannot bypass), §IV (contract-first), §IX (source-of-truth — no silent product creation), §X (temporal semantics — reconciliation does not rewrite history), §XIV (PII / redaction). |

---

## 11. Open Questions

The following are unresolved product decisions. They block planning, not specification.

- ~~**OQ-1 — Cross-store identifier scope for alias resolution at capture time**~~ — **Resolved 2026-05-23**: capture as unknown at S; no cross-store auto-resolution at capture. See Clarifications session 2026-05-23 and FR-030a.

- ~~**OQ-2 — Dismiss reversibility**~~ — **Resolved 2026-05-23**: capture a fresh `pending` item; lifecycle remains monotonic per record. See Clarifications session 2026-05-23 and FR-004 / FR-005.

- ~~**OQ-3 — Opportunistic POS-supplied descriptive fields**~~ — **Resolved 2026-05-23 (revised same day)**: descriptive metadata is non-identity, non-matching, non-authoritative, and is carried only to the extent 003 already supports (inside the existing `unknown_items.sale_context jsonb` field). 005 introduces **no new column**, no schema amendment to 003, and no migration. A dedicated typed label field, first-non-null sticky semantics, and structured vendor metadata are deferred to a future opt-in feature — see Appendix B. See Clarifications session 2026-05-23, FR-006, and FR-006a.

---

## 12. Out of Scope (Reaffirmed)

- No API endpoint shape, status codes, or contract YAML.
- No dashboard UI screens or component-level design.
- No POS-side sale behavior when an unknown item occurs.
- No auto-create policy.
- No analytics, reporting, dbt, ClickHouse, Dagster, or billing changes.
- No CI / observability dashboard work.
- No migration design, schema diff, or Drizzle code.
- No task breakdown — `/speckit-tasks` is the next planned command after `/speckit-plan`, and `/speckit-plan` is the next planned command after this spec is clarified.

---

## Appendix B — Future Guidance (Non-Normative): Dedicated POS Descriptive Field

> **Status: non-normative — guidance for a future opt-in feature only.** Nothing in this appendix is required by 005. None of it imposes any obligation on 003. It exists to preserve design thinking for a future spec author who decides the operational pain of reviewers seeing only a bare identifier (per SC-006) is large enough to justify a dedicated typed surface.

If a future feature decides to add a dedicated typed surface for POS-supplied descriptive metadata to `unknown_items`, the design considerations below were vetted during 005's clarify session and are preserved here for reuse. **They are not requirements of 005.**

### B.1 Suggested shape

A single optional bounded free-text column on `unknown_items`, e.g. `pos_supplied_label TEXT NULL`, with a check constraint `length(pos_supplied_label) <= 200`. Single field, not a structured set — minimizes schema surface and avoids ongoing 003 amendments as POS vendors invent new hint shapes.

### B.2 Sticky first-non-null write semantic

If such a field is added, write semantics should be **first-non-null sticky**: once a non-null value is captured for a given unknown-item record, subsequent POS submissions for the same logical identifier MUST NOT overwrite it. Rationale: a reviewer is going to use the label to decide whether to link, create, or dismiss. A later submission overwriting the field between the reviewer's glance and click would let a misbehaving or malicious POS rewrite the evidence a reviewer is judging. First-non-null sticky preserves the evidentiary value at the moment of first observation while still letting a later submission populate the field if the first one omitted it.

### B.3 Redaction posture

A dedicated typed column would be free-text and therefore higher PII risk than the opaque `sale_context jsonb` (which is already redaction-flowed wholesale). The future feature MUST flow the dedicated field through the redaction matrix defined in 003 §10 before it leaves the tenant boundary in any audit, log, metric, or read API.

### B.4 Identity / matching guarantees (unchanged from 005)

Even with a dedicated column, the field MUST remain non-identity, non-matching, non-authoritative — identical to FR-006 in 005. Adding storage does not change the safety properties.

### B.5 Implementation sequencing if/when adopted

A future spec implementing this would need: (a) a gated amendment to 003's `data-model.md` to add the column, the check constraint, and (if needed) a redaction-matrix entry; (b) a gated SQL migration; (c) a contract change to expose the field in the POS capture payload; (d) tests for the sticky write semantic and the redaction posture. None of this is in scope for 005.

---

## Appendix A — Scenario-to-Requirement Coverage

| Original scenario (from request) | Covered by |
|---|---|
| 1. POS submits unknown item | US1; FR-001, FR-010, FR-030 |
| 2. SaaS records as unknown scoped to tenant + store | US1; FR-010, FR-011, FR-014 |
| 3. Tenant admin reviews unknown items | US2; FR-014 |
| 4. Tenant admin links to existing product | US2; FR-050–FR-053 |
| 5. Tenant admin creates new product from unknown item | US2; FR-060–FR-063 |
| 6. Aliases created/updated after reconciliation | US2 + US3; FR-040, FR-050, FR-061 |
| 7. Repeated POS submissions are idempotent | US4; FR-020–FR-022, FR-031–FR-032 |
| 8. Conflicting aliases rejected safely | US3; FR-040–FR-043, FR-052, FR-062 |
| 9. Cross-tenant / cross-store denied | US1 + US2 + Edge Cases; FR-012–FR-015, SI-001–SI-005 |
| 10. Reconciliation auditable | US5; FR-080–FR-083 |
