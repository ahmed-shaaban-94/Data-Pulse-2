# Feature Specification: Sales / Transaction Capture

**Feature ID**: 008
**Short name**: sales-transaction-capture
**Status**: Draft
**Created**: 2026-05-30
**Owner**: Ahmed Shaaban
**Depends on**: [specs/005-pos-catalog-sync-reconciliation](../005-pos-catalog-sync-reconciliation/spec.md) (POS ingestion seam, idempotency token semantics, audit/isolation posture — consumed and extended) · [specs/003-catalog-foundation](../003-catalog-foundation/spec.md) (catalog source-of-truth that sale lines snapshot from; money pinned at `numeric(19,4)` + ISO currency) · [specs/002-pos-operator-identity](../002-pos-operator-identity/spec.md) (authenticated POS principal: tenant + store + device) · [specs/001-foundation-auth-tenant-store](../001-foundation-auth-tenant-store/spec.md) (auth / scope / audit pipeline / idempotency primitive / platform rate-limit posture)
**Constitution version**: v3.0.1 — primary touchpoints §III (backend authority — money + POS-totals-preserved), §IX (Source-of-Truth Model — sale-line snapshot), §X (Retail Temporal Semantics), §XI (Idempotency & External IDs), §XII (Authorization & Object Safety), §XIII (Auditability & Provenance), and the **Per-Tenant Resource Isolation** section (first ingestion-heavy feature gate)
**Input**: User description: "008-sales-transaction-capture"
**Blocked on**: ~~the **Money + Temporal Decision Gate**~~ — **RESOLVED 2026-05-30.** The gate (`gate-money-temporal.md`) closed all owner decisions (transaction money A.1–A.6, per-entity timestamp set B, payload-hash C, concurrency D.1, per-tenant bound D.2, sale-fact classification/retention D.3); resolutions are mirrored in §Clarifications (Session 2026-05-30) and §11. The gate no longer blocks implementation/planning — **`/speckit-plan` is unblocked.**

---

## Clarifications

### Session 2026-05-30

- Q: 008 is the first feature to model a sale. Does it introduce new entities, or (like 005/007) consume existing ones? → A: It introduces new entities — `sales` and `sale_lines` (and the void/refund terminal-event records). This is the first time the SaaS owns a sale fact. The new schema, migrations, DTOs, and OpenAPI are HOW and are **out of scope for this spec** (planning-only `/speckit-specify` output); the entities are defined here at the product/behavioral level only. The highest existing migration is `0011`; an implementing slice would add `0012+` under the `[GATED]` migration path. (Scope clarification.)
- Q: Catalog pricing money is already pinned (`numeric(19,4)` + `char(3)` ISO currency, paired-currency CHECK — 003). Does 008 re-decide it? → A: No. Catalog/store/price-history money is pinned and consumed as-is. Only **transaction-level** money (line tax representation, invoice-vs-per-line rounding, banker's-vs-half-up, tender/change/multi-tax modeling, and the chosen money library/representation the constitution's Follow-up TODO demands) is open, and it is owner-decided in the Money + Temporal Decision Gate, not in this spec. (Money-scope clarification.)
- Q: Is the sale a mutable resource (does it need optimistic-concurrency `version` columns per §III)? → A: A captured sale is an **immutable historical fact** (§IX SaleLine-snapshot, §X no-rewrite). Concurrency is therefore **idempotent dedup on `sourceSystem + externalId`** at ingestion (§XI), not last-write-wins and not a version column on an append-only fact. Corrections — void and refund — are modeled as **separate terminal-event records that reference the original sale, never as in-place mutations** (§X `voidedAt`/`refundedAt`). The only narrowly-mutable fields are the processing-state fields the SaaS owns (`processedAt`, the advisory POS-total-mismatch flag); their posture is stated in FR-061/FR-062 and §6.8. (Concurrency clarification.)
- Q: 008 is the first ingestion-heavy feature. Does it carry per-tenant resource isolation? → A: Yes — the constitution's **Per-Tenant Resource Isolation** section mandates that the first POS sync feature land with a documented per-tenant resource-isolation posture. 008 consumes the existing platform rate-limit posture (001 / 004) unchanged for inline single-sale capture and **extends** it with a documented bulk-sync (offline-recovery) bound. Specific numeric limits are initial defaults and an owner decision; the *existence* of the posture is mandatory here. (Resource-isolation clarification.)

**Money + Temporal Decision Gate — RESOLVED 2026-05-30** (owner: Ahmed Shaaban). The following close OQ-1..OQ-7; full rationale in [`gate-money-temporal.md`](./gate-money-temporal.md) §Decisions Recorded:

- Q: A.1 — transaction-money precision/scale? → A: **`numeric(19,4)`** for all transaction money (line price/amount, total, tax), identical to the 003 catalog money — one money model, no rounding boundary. (Resolves OQ-1 precision.)
- Q: A.2 — line-tax representation? → A: **Single per-line tax amount, snapshot only** — the SaaS stores what the POS charged and does not recompute tax; multi-tax breakdown deferred to a later feature. (Resolves OQ-1 tax shape.)
- Q: A.3 — per-line vs invoice-level rounding for the SaaS comparison total? → A: **Per-line** (round each line, then sum) — matches typical POS receipts, fewest false mismatch flags. POS-reported total preserved verbatim regardless (FR-030). (Resolves OQ-1 rounding granularity.)
- Q: A.4 — rounding mode? → A: **Half-up** (arithmetic) — matches most retail POS and human expectation. (Resolves OQ-1 rounding mode.)
- Q: A.5 — persist tender/change/multi-tax, or defer? → A: **Defer to the dedicated payments feature (010)**; **no tender persistence in 008 v1**. Keeps 008 to the sale fact + POS-reported total; avoids §XIV payment-class data in the first slice. (Resolves OQ-2.)
- Q: A.6 — in-application money representation / library? → A: **String-backed money value object** (`{ amount: string, currency }` validated at the boundary, round-tripped to DB `numeric(19,4)`); **no new dependency**, so **no `[GATED]` `package.json` add**. (A.2's snapshot-tax choice means the SaaS does almost no money arithmetic, so a big-decimal library is unwarranted.) (Resolves OQ-1 money library.)
- Q: B — per-entity timestamp required vs optional? → A: **NOT NULL: `occurredAt`, `receivedAt`, `businessDate` on `sales`; `voidedAt`/`refundedAt` on terminal events. Nullable: `processedAt` (null-until-processed, §V), `sourceClockAt` (POS may omit). `sale_lines` inherit the parent's `occurredAt`/`businessDate`.** Strong invariants on server-owned/business-critical times while tolerating partial offline payloads (§X). (Resolves OQ-3 / FR-020.)
- Q: C — payload-hash algorithm + canonicalization + scope? → A: **SHA-256 over canonical (sorted-key / JCS) JSON, hashing the full payload** — stable across cosmetic re-serialization so provenance stays reconciliation-stable. (Resolves OQ-4 / FR-040.)
- Q: D.1 — concurrency posture ratification? → A: **Ratified** — immutable fact, concurrency = idempotent dedup on `sourceSystem + externalId`, **no** optimistic `version` column on an append-only fact, corrections are append-only terminal events. (Resolves OQ-5 / FR-070.)
- Q: D.2 — per-tenant bulk-sync bound defaults? → A: **Offline-recovery batch ceiling 500 sale events/request**, layered on the inherited 001/004 platform rate-limit posture (no unbounded batch path). Initial defaults, tunable in `/speckit-plan` without re-opening the gate; the posture's *existence* is the mandate (FR-080/SI-011). (Resolves OQ-6.)
- Q: D.3 — sale-fact data class + retention? → A: **Business-class** (no customer identity in v1), **retention inherits the 001 long-horizon insert-only posture**, right-to-erasure tombstones any future PII field rather than deleting the fact. Reclassifies if customer-reference/tender data is later admitted (SI-012). (Resolves OQ-7 / §13 row XIV, removing the "pending D.3" scope.)

---

## 0. Scope of This Spec

This spec defines, at **product/behavioral altitude**, how the SaaS backend **captures, stores, and preserves the truth of a completed retail sale** submitted by a POS device — building on the POS ingestion seam that **005** established for unknown-item capture, not re-inventing ingestion.

This spec defines:

- The **sale fact model** — `sales` (the invoice/transaction) and `sale_lines` (the per-line snapshot), plus the **void** and **refund** terminal-event records — at the entity/behavioral level: what each entity *means*, what it *snapshots*, what it *preserves*, and what it MUST NOT mutate.
- The **line-level snapshot discipline**: price, name, tax treatment, and unit are frozen at sale time so later catalog/store-override changes never mutate a past sale line (§IX/§X).
- The **temporal field set** each entity tracks (`occurredAt` / `receivedAt` / `processedAt` / `businessDate` / `sourceClockAt`, and `voidedAt` / `refundedAt` modeled as separate terminal events).
- **Idempotent ingestion**: a duplicate sale event (same `sourceSystem + externalId`, and/or the same idempotency token) MUST NOT double-apply (§XI), reusing 005's dedup + idempotency-token contract.
- **POS-totals fidelity**: POS-reported totals are preserved exactly as received; the SaaS MAY compute and flag a mismatch but MUST NOT silently rewrite them (§III).
- **Object safety**: forbidden mass-assignment fields, strict boundary validation, safe-404 cross-tenant, default-deny (§XII).
- **Provenance**: `sourceSystem`, `externalId`, ingestion timestamps, and a payload hash retained per ingested sale event so the SaaS view is reconcilable to the original payload (§IX/§XIII).
- The **concurrency posture** of the new resource (immutable fact + idempotent dedup + append-only terminal events), and the narrow mutable processing-state surface.
- The **per-tenant resource-isolation posture** for this first ingestion-heavy feature.

This spec is **explicitly not**:

- An implementation: no NestJS modules, controllers, services, workers, guards, interceptors, repositories, or file paths.
- A persistence-authoring task: it does **not** author Drizzle schema, SQL migrations, indexes, RLS policies, or CHECK constraints. Those are HOW, produced downstream in this feature's own `plan.md` / `tasks.md`; the schema + migration land under the `[GATED]` paths.
- A wire-authoring task: it does **not** author the OpenAPI YAML, path strings, HTTP methods/status codes, header or JSON field names, or Zod schemas (`[GATED]` `packages/contracts/openapi/**`).
- A money/temporal decision: it does **not** pick a transaction-money precision, a rounding mode, a tax-representation shape, a tender model, the per-entity timestamp nullability, or the payload-hash algorithm. Those are owner decisions deferred to the **Money + Temporal Decision Gate** (`gate-money-temporal.md`).
- A pricing engine, a tax engine, a promotions engine, a returns/refunds *workflow* (this spec models the *record* of a void/refund event; the dashboard refund workflow depth, approvals, and partial-refund UX are later features).
- A reporting / analytics surface (sales reporting, marts, dbt are later features — see §3).

The discriminating value of 008: it is the **first feature where the SaaS owns a sale fact**. 003 owns the catalog the lines snapshot from; 005 owns the unknown-item capture seam; 008 introduces the sale itself and binds the constitution's previously-unexercised retail-temporal and source-of-truth-snapshot principles (§IX/§X) to a concrete entity.

---

## 1. Background & Why

The SaaS is a retail data control plane and trust layer (Constitution preamble). To date it owns identity/tenancy (001/002), the catalog source-of-truth (003), and the POS catalog-reconciliation seam (005). **It does not yet model a sale.** 005 captures *only* the catalog-reconciliation signal — an unknown item reference — and explicitly does **not** model sale transactions, invoices, line items, totals, or payments (005 §3 Non-Goals: "No inventory, orders, sales, refunds, invoices, reporting, billing…"; "No POS-side behaviour for the sale itself when an unknown item occurs"). The single sale-adjacent field 005 touches, `unknown_items.sale_context`, is **opaque advisory metadata** — non-identity, non-matching, non-authoritative — which confirms rather than weakens that 005 models no sale.

Without a sale-capture feature:

- The historical truth of what was actually sold — at what price, under what name, with what tax, in what unit, at what moment — has nowhere authoritative to live. The catalog (003) is *reference for current state*, not *truth for a past invoice* (§IX Source-of-Truth Hierarchy).
- The retail-temporal principles (§X) and the sale-line-snapshot principle (§IX) — the entire reason the constitution distinguishes "when it happened" from "when we found out," and "the catalog now" from "the line then" — have no entity to bind to. (001 §14 records §IX/§X as *"not exercised — no sale entities are defined here."* 008 is where they become exercised.)
- POS reconciliation, reporting, and analytics features that all depend on a durable, provenance-preserving sale fact have no foundation.

This feature specifies that sale fact at the product level: the entities, the snapshot discipline, the temporal semantics, the idempotent ingestion, the totals-fidelity rule, the provenance, the isolation, and the audit. Implementation lands in later, separately-gated slices, and is **blocked on the Money + Temporal Decision Gate** (§11).

---

## 2. Goals

- Define the **sale fact model** — `sales`, `sale_lines`, and the `void` / `refund` terminal-event records — at the entity/behavioral level.
- Define the **line-level snapshot**: each `sale_line` freezes the product's price, name, tax treatment, and unit *as of sale time*; later catalog or store-override changes MUST NOT mutate it (§IX/§X).
- Define the **temporal field set** each entity tracks and the rule that void/refund are separate terminal events, never in-place mutations of the original sale.
- Define **idempotent ingestion** keyed by `sourceSystem + externalId` (and/or the request-level idempotency token), reusing 005's dedup + token contract so a retried or re-delivered sale event never double-applies (§XI).
- Define **POS-totals fidelity**: POS-reported totals are stored verbatim; the SaaS MAY flag a computed mismatch but MUST NOT silently rewrite them (§III).
- Define **object-safety** expectations at the ingestion boundary: forbidden mass-assignment fields, strict body validation, safe-404 cross-tenant, default-deny (§XII).
- Define **provenance** retained per ingested sale event so the SaaS view is reconcilable to the original payload (§IX/§XIII).
- Define the **concurrency posture** of the new resource and the narrow mutable processing-state surface (§III / Concurrency).
- Define the **per-tenant resource-isolation posture** required of the first ingestion-heavy feature (Per-Tenant Resource Isolation).
- Define **tenant/store isolation, non-disclosure, and audit** expectations for every capture and terminal-event path (§II/§XII/§XIII).
- Define user-visible outcomes (success and failure) at the product level — without prescribing API shape, status codes, screens, or schema.

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, workers, guards, interceptors, or jobs.
- No `plan.md`, `tasks.md`, `data-model.md`, `research.md`, or contract YAML in **this** PR.
- No DB schema, Drizzle schema, SQL migration, index, RLS policy, or CHECK constraint authored here. (An implementing slice would add migration `0012+` — current highest is `0011` — under the `[GATED]` path.)
- No OpenAPI files, package files, lockfiles, CI changes, generated files, or app source modifications.
- No API endpoint design, path strings, status codes, header or field names. No dashboard UI screens. No POS app implementation. No client SDK shape.
- **No transaction-money decision** — line-tax representation, per-line vs invoice-level rounding, banker's vs half-up, tender/change/multi-tax modeling, and the money library/representation are owner decisions in the Money + Temporal Decision Gate, not here. (Catalog-pricing money is already pinned at `numeric(19,4)` + ISO currency in 003 and is consumed as-is.)
- **No timestamp required-vs-optional decision** — this spec names the *field set* each entity tracks; the gate decides which are required vs optional per entity.
- No pricing engine, tax engine, or promotions engine.
- No **returns/refunds workflow depth** — approvals, partial-refund UX, restocking, store-credit issuance, refund-to-tender routing. 008 models the *record* of a void/refund terminal event referencing a sale; the operational workflow is a later feature (see below). Deferred: **010** (payments/tender reconciliation details outside 008 scope), **012** (returns/refunds workflow + sales reporting), per the project roadmap convention.
- No inventory / stock-movement modeling, no purchasing/supplier modeling. (No such schema exists in the repo today; introducing it is a separate feature.)
- No **payment/tender persistence** in 008 unless the gate decides otherwise. Payments today exist only as the contract stub `packages/contracts/openapi/pos-payments/vouchers.yaml`; tender / `PaymentAttempt` modeling is POS-Pulse-side and contract-only, and any backend tender persistence invokes §XIV payment-class classification — a reason the gate frames tender modeling as defer-by-default.
- No reporting, analytics, dbt, ClickHouse, Dagster, billing, or observability-dashboard work.
- No change to 003's catalog schema, 005's reconciliation contracts, or any shipped RLS — 008 reads the catalog to build the line snapshot and rides 005's ingestion seam; it does not redefine either.

---

## 4. Actors

| Actor | Role in this workflow |
|---|---|
| **POS Device / POS Backend** | Submits completed sale events (and, on offline recovery, batches of them) during/after a sale, and submits void/refund terminal events. Authenticates per 002 (tenant + store + device). Has no read access to tenant-admin surfaces. **Note (dependency):** POS-Pulse does not yet *emit* sales — see §10. |
| **Store Operator / Store Manager** | May read sale facts captured at stores within their scope. May initiate void/refund terminal events only within their store scope (operational depth deferred — see §3). |
| **Tenant Admin / Tenant Owner** | May read sale facts across all stores in their tenant and reconcile flagged total-mismatches. May initiate void/refund across the tenant where the membership model grants tenant-wide authority. |
| **Platform Operator** | No direct access to tenant sale data. Reads aggregate platform-wide signals (e.g., POS sync lag, duplicate-event rate, reconciliation-mismatch rate) for operational health only. Cannot read tenant-specific sales. |
| **Background Worker** | Performs any off-request sale processing (e.g., setting `processedAt`, computing the POS-total-mismatch flag, building/refreshing the line snapshot where catalog lookup is involved). Carries `tenantId` / `storeId` / `correlationId` and establishes tenant context before DB access (§V). |
| **Anonymous / unauthenticated** | No access whatsoever. |

This spec introduces **no new permission, role, or membership model.** It consumes 001's membership/scope model and 002's POS principal identity as-is.

---

## 5. User Scenarios & Testing *(mandatory)*

### User Story 1 — POS captures a completed sale as an immutable fact (Priority: P1)

A POS device submits a completed sale: a transaction header (store, business context, POS-reported totals, currency, timestamps, provenance) and one or more lines (each referencing a catalog item or an ad-hoc line, with the price, name, tax treatment, and unit *as charged at the POS*). The SaaS records the sale as an immutable fact scoped to the correct tenant and store, freezes each line as a snapshot, preserves the POS-reported totals exactly, retains provenance, returns a deterministic acknowledgement with a stable sale reference, and emits the audit/observability signal. The POS continues operating.

**Why this priority**: This is the entry point and the whole point — without sale capture there is no sale fact, no snapshot, no downstream void/refund/reporting. It must be safe-by-default: capture cannot mutate the catalog, cannot rewrite POS totals, and cannot leak across tenants.

**Independent Test**: A POS authenticated to tenant T and store S submits a sale with two lines referencing active tenant products. Verify: (a) a `sales` record exists scoped to (T, S) with the POS-reported totals stored verbatim; (b) two `sale_lines` exist, each carrying a frozen price/name/tax/unit snapshot; (c) the response references the sale by a stable id visible only to T; (d) provenance (`sourceSystem`, `externalId`, ingestion timestamps, payload hash) is retained; (e) a parallel POS authenticated to a different tenant cannot see the sale by any means; (f) subsequently editing the referenced product's catalog price/name does **not** change the captured `sale_lines`.

**Acceptance Scenarios**:

1. **Given** a POS authenticated to tenant T and store S submits a completed sale with valid lines, **When** capture runs, **Then** a `sales` record is created with `tenant_id = T`, `store_id = S`, the POS-reported totals stored exactly as received, the submission currency recorded, and the response references the sale by a stable identifier visible only to T.
2. **Given** the same sale, **When** capture runs, **Then** each submitted line produces a `sale_line` that **freezes** the line's price, item name, tax treatment, and unit as charged — independent of any later catalog change (§IX/§X).
3. **Given** a captured sale, **When** the referenced product's Tenant-Catalog price, name, or tax treatment is later changed, **Then** the existing `sale_lines` are **unchanged**; the snapshot remains the historical truth for that invoice (§X "historical sale facts MUST NOT be silently rewritten by catalog changes").
4. **Given** the POS re-delivers the exact same sale event (same `sourceSystem + externalId`, and/or the same idempotency token), **When** the duplicate arrives, **Then** the platform returns the *same* sale reference and does **not** create a second `sales` record or double-apply any side-effect (§XI; reuses 005's dedup contract).
5. **Given** a POS submits a sale whose POS-reported total does not equal the sum the SaaS computes from the lines, **When** capture runs, **Then** the platform **preserves the POS-reported total verbatim**, records the sale, and **MAY flag the mismatch** as an advisory signal — but MUST NOT rewrite the POS total (§III).
6. **Given** a POS authenticated to tenant T submits a sale and another tenant T' has a sale with a colliding `externalId`, **When** both are processed, **Then** the two are fully isolated; neither tenant can observe the other's sale by id, by listing, or by any response — dedup is scoped within the tenant (§II/§XI).

---

### User Story 2 — Delayed offline sync is captured without rewriting time (Priority: P1)

A POS that was offline reconnects and submits sale events whose `occurredAt` is hours, days, or weeks behind the moment of receipt. The SaaS accepts them, preserves `occurredAt` and the POS-reported `sourceClockAt` as received, stamps its own `receivedAt`, derives `businessDate` from the store timezone (not the client clock), and never uses client-reported time as a security clock.

**Why this priority**: Offline-first POS is the design assumption (Constitution §IV/§X). A backend that silently rejects or rewrites delayed events loses data on every recovery and lies to every audit (§X rationale). P1 because it is inseparable from correct capture.

**Independent Test**: Submit a sale with `occurredAt` two weeks in the past and a `sourceClockAt` slightly skewed from server time. Verify: (a) the sale is accepted, not rejected; (b) `occurredAt` and `sourceClockAt` are stored as received; (c) `receivedAt` reflects the server clock at receipt; (d) `businessDate` is derived from the store timezone, not the client clock; (e) no security/authorization decision in the flow consulted the client-reported clock.

**Acceptance Scenarios**:

1. **Given** a sale event whose `occurredAt` is well behind `receivedAt`, **When** it is submitted, **Then** it is captured normally — never rejected or silently rewritten on the basis of the time gap (§X "delayed events are expected").
2. **Given** the POS reports a `sourceClockAt` that disagrees with the server clock, **When** the sale is captured, **Then** `sourceClockAt` is preserved verbatim and is **never** used as the security clock; token/idempotency-TTL and rate-limit windows are evaluated against the server clock (§X).
3. **Given** a sale near a tenant-local day boundary, **When** `businessDate` is derived, **Then** it is computed from the **store timezone**, not the raw client clock (§X).
4. **Given** all timestamps are stored, **Then** each is stored as UTC `TIMESTAMPTZ` (§X "Storage default is UTC").

---

### User Story 3 — A void is recorded as a separate terminal event (Priority: P2)

An authorized actor (or the POS, per the eventual contract) records that a previously-captured sale was voided. The SaaS records a **void terminal event** that references the original sale and stamps `voidedAt` — it does **not** mutate or delete the original `sales` / `sale_lines` rows. The original sale fact and its line snapshots remain intact as historical truth; the void is an additional fact layered on top.

**Why this priority**: Voids are real and must be representable, but the P1 capture path is the value driver and must exist first. P2 — required for correctness of the historical record, secondary to capture.

**Independent Test**: Capture a sale, then record a void for it. Verify: (a) a void terminal-event record exists referencing the original sale, with `voidedAt` set; (b) the original `sales` row and its `sale_lines` are byte-for-byte unchanged; (c) the void is attributed to the acting principal with a correlation id and is auditable; (d) a second void of the same sale is handled deterministically (idempotent / already-voided outcome), not as a duplicate terminal event.

**Acceptance Scenarios**:

1. **Given** a captured sale, **When** a void is recorded, **Then** a separate void terminal-event record is created referencing the sale with `voidedAt` set, and the original sale + lines are **not** mutated (§X "terminal mutating events… modeled separately, not by mutating it").
2. **Given** a sale already voided, **When** another void for the same sale arrives, **Then** the platform returns a deterministic already-voided / idempotent outcome and creates no duplicate terminal event.
3. **Given** any void, **When** it completes, **Then** an audit event attributes it to the acting principal with tenant, store, target sale reference, and correlation id (§XIII).

---

### User Story 4 — A refund is recorded as a separate terminal event (Priority: P2)

An authorized actor records a refund against a previously-captured sale. The SaaS records a **refund terminal event** referencing the original sale and stamps `refundedAt` — again without mutating the original sale or its line snapshots. (The operational *workflow* of refunds — approvals, partial-refund line selection, tender routing, restocking — is **out of scope**; this story covers the durable *record* only.)

**Why this priority**: Same posture as voids — required for a faithful historical record, secondary to the P1 capture path. P2.

**Independent Test**: Capture a sale, record a refund terminal event against it. Verify: (a) a refund terminal-event record exists referencing the original sale with `refundedAt` set; (b) the original sale + lines are unchanged; (c) the refund is auditable to the acting principal with a correlation id; (d) re-delivery of the same logical refund event (same provenance / idempotency token) does not double-apply.

**Acceptance Scenarios**:

1. **Given** a captured sale, **When** a refund terminal event is recorded, **Then** a separate refund record references the sale with `refundedAt` set, and the original sale + lines are **not** mutated (§X).
2. **Given** the refund event carries POS-reported refund amounts, **When** it is recorded, **Then** those amounts are preserved as received; the SaaS MAY flag a mismatch against the original sale but MUST NOT rewrite the POS-reported refund figures (§III).
3. **Given** the same logical refund event is re-delivered (same `sourceSystem + externalId` and/or idempotency token), **When** it arrives again, **Then** it is deduplicated and not double-applied (§XI).
4. **Given** any refund, **When** it completes, **Then** an audit event attributes it to the acting principal with a correlation id (§XIII).

---

### User Story 5 — Ingestion is idempotent and provenance-preserving (Priority: P2)

POS devices retry and re-deliver on transient failure and on offline recovery. A re-delivered sale, void, or refund event from the same source must not create a duplicate record, must not double-apply totals or terminal effects, and must be reconcilable to its original payload via retained provenance.

**Why this priority**: Idempotency and provenance are mandated by §XI and §IX/§XIII and are the integrity floor for ingestion, but the P1 stories already require single-shot correctness; P2 captures the retry/provenance surface explicitly so test coverage and contract design lock it in.

**Independent Test**: Submit the same sale event 5 times (same `sourceSystem + externalId`) and again under the same idempotency token; verify exactly one `sales` record exists and the response is identical across calls. Verify the retained provenance (`sourceSystem`, `externalId`, ingestion timestamps, payload hash) allows reconstructing which payload produced the record. Verify duplicate-event telemetry increments while capture telemetry does not.

**Acceptance Scenarios**:

1. **Given** a sale event with a given `(sourceSystem, externalId)` at tenant T, **When** the same pair arrives again, **Then** the platform resolves it to the **same** `sales` record and does not double-apply (§XI dedup contract).
2. **Given** a request-level idempotency token consistent with 005's contract — keyed by the tuple `(tenant_id, device_id, token)`, honored for at least 24h from first observation — **When** the POS retries with the same token and the same payload, **Then** the platform returns the prior response with no duplicate side-effects (§XI; 005 FR-021a/FR-021b).
3. **Given** the same idempotency token reused within its TTL **but** with a **different** logical payload, **When** the request arrives, **Then** the platform rejects it with a deterministic mismatch-conflict outcome and produces no side-effects (§XI; 005 FR-021c fail-closed).
4. **Given** any captured sale/void/refund, **When** provenance is queried, **Then** `sourceSystem`, `externalId`, ingestion timestamps, and a payload hash are retained, sufficient to reconcile the SaaS record to the original payload (§IX/§XIII).
5. **Given** the same opaque token string supplied by two different POS devices in the same tenant, **When** both arrive, **Then** each is an independent idempotency key (no collision); both process on their own merits (005 FR-021a).

---

### User Story 6 — Capture is tenant/store-isolated, object-safe, and auditable (Priority: P2)

Every capture and terminal-event path is scoped to the authenticated principal's tenant and store, rejects body-supplied authority fields, validates strictly at the boundary, fails closed by default, surfaces cross-tenant access as non-disclosing not-found, and emits an attributable audit event.

**Why this priority**: Isolation, object safety, and audit are mandated by §II/§XII/§XIII and are the safety net around the P1 paths. P2 — must be present, but the P1 capture stories are the value drivers.

**Independent Test**: (a) Submit a sale whose body includes `tenant_id`, `store_id`, `created_by`, `processed_at`, or a server-owned total field — verify those are ignored/rejected, never honored (malicious-override probe, §VI). (b) Submit a sale with unknown extra keys — verify strict-validation rejection. (c) Read a sale by id as a different tenant's principal — verify non-disclosing not-found. (d) Drive a capture → void → refund lifecycle — verify each transition emits an audit event with tenant, store, actor, action, target, correlation id, timestamp.

**Acceptance Scenarios**:

1. **Given** a sale submission whose body carries any of `tenant_id`, `store_id`, `created_by`, `processed_at`, `received_at`, the server-derived `business_date`, or a server-owned total/flag, **When** validation runs, **Then** those fields are **not** body-assignable — tenancy/store/provenance/processing-state resolve from server-side context (token, path, server clock), never from the body (§XII mass-assignment).
2. **Given** a submission with unknown keys or malformed values, **When** validation runs, **Then** it is rejected with a deterministic failure outcome and no record is created; strict boundary validation rejects unknown keys (§XII `.strict()`).
3. **Given** a principal of tenant T' requests a sale owned by tenant T, **When** the lookup runs, **Then** the response is indistinguishable from "does not exist" — a non-disclosing not-found, never an authorization error that reveals existence (§II/§XII safe-404).
4. **Given** an endpoint path with no explicit authorization, **When** reached, **Then** it fails closed — default-deny (§XII).
5. **Given** any state-changing path (capture, void, refund, mismatch-flag-set), **When** it completes or is rejected where 005-class audit applies, **Then** an audit event is emitted with actor, tenant, store, action, target sale reference, correlation id, outcome, and timestamp (§XIII).

---

### Edge Cases

- **POS total vs computed total mismatch** → POS total preserved verbatim; SaaS MAY set an advisory mismatch flag and emit the existing **reconciliation-mismatch-rate** signal (§VII); never a silent rewrite (§III). The mismatch flag is a SaaS-owned processing-state field (§6.8), not POS-supplied.
- **Delayed/offline event** (`occurredAt` far behind `receivedAt`) → captured normally, never rejected or rewritten on the time gap (§X).
- **Skewed `sourceClockAt`** → preserved as received; never used for any security/authorization/TTL decision (§X).
- **Duplicate sale event** (same `sourceSystem + externalId`) → resolves to the same record; no double-apply; duplicate-event-rate signal increments (§XI/§VII).
- **Idempotency token reused with a changed payload** → deterministic mismatch-conflict, no side-effects (005 FR-021c).
- **Cross-tenant `externalId` collision** → fully isolated; dedup is tenant-scoped (§II/§XI).
- **Void/refund referencing a non-existent or out-of-scope sale** → non-disclosing not-found (§XII safe-404); no terminal event created.
- **Second void / re-delivered refund** → deterministic already-applied/idempotent outcome; no duplicate terminal event (§XI).
- **Catalog change after capture** → past `sale_lines` unchanged; snapshot is the historical truth (§IX/§X).
- **Ad-hoc / non-catalog line** (a line with no matching tenant product — e.g., an unknown-item sale that 005 would also capture for reconciliation) → the line still snapshots the price/name/tax/unit *as charged*; 008 records the sale-line truth, while 005's seam independently records the catalog-reconciliation signal. The two are complementary and MUST NOT be conflated.
- **Bulk offline-recovery sync** (a batch of many sale events, possibly with intra-batch duplicates) → each logical event deduplicates to a single record; ordering within the batch does not affect final state; per-tenant resource-isolation bounds (§7) apply so one tenant's recovery burst does not starve others.
- **Tender/payment data present in the payload** → in v1 (absent a gate decision to model tender) tender data is **not persisted** by 008; if a future gate decision admits it, it is **payment-class** and subject to §XIV redaction/classification. Raw POS payloads are never logged verbatim (§VII/§XIV).
- **Missing store context** → a POS principal without a resolved store binding cannot capture a sale (every sale is store-scoped); rejected deterministically (§II store-access).
- **Currency** → every monetary field carries an explicit ISO-4217 currency code, even in a single-currency MVP (§III / Money). Catalog money is already pinned `numeric(19,4)` + `char(3)`; transaction-money precision is gate-decided.

---

## 6. Requirements *(mandatory)*

All requirements are **behavioral / product-level**. They do **not** prescribe schema, migrations, RLS DDL, wire format, paths, methods, status codes, field names, framework, or code. Where a requirement consumes 005 / 003 / 001 / 002 behavior or a Constitution principle, the reference is cited; that behavior is consumed unchanged. Requirements marked **[GATE]** state a constitutionally-fixed obligation whose *open parameter* is resolved in the Money + Temporal Decision Gate — the obligation holds regardless; only the parameter is owner-decided.

### 6.1 Sale fact model & snapshot

- **FR-001**: The system MUST introduce a `sales` entity — the transaction/invoice header — carrying `tenant_id` (NOT NULL), `store_id` (NOT NULL), the submission currency (ISO-4217), the POS-reported totals (preserved per FR-040), the temporal field set (§6.3), and the provenance set (§6.5). A captured sale is an **immutable historical fact**.
- **FR-002**: The system MUST introduce a `sale_lines` entity — one row per sold line — each **snapshotting** the line's price, item name, tax treatment, and unit **as charged at sale time**, plus the line quantity and line-level monetary amounts as reported. Each line carries `tenant_id` and `store_id` consistent with its parent sale.
- **FR-003**: Each `sale_line` snapshot MUST be **frozen at capture**: later changes to the referenced Tenant-Catalog product, Store Override, or price history MUST NOT mutate any existing `sale_line` (§IX SaleLine-snapshot, §X no-rewrite). A `sale_line` MAY reference the catalog item it was derived from for lineage, but the snapshot values are authoritative for the invoice, not the live catalog values.
- **FR-004**: A `sale_line` MAY be an **ad-hoc/non-catalog line** (no resolvable tenant product); it still snapshots the price/name/tax/unit as charged. 008 does not require a catalog match to capture a line, and MUST NOT auto-create a tenant product from a sale line (catalog creation is 005's human-driven reconciliation path only).
- **FR-005 [GATE]**: Every monetary field on `sales` and `sale_lines` MUST be exact-decimal (`numeric(p,s)`) — floating-point money is forbidden — and MUST carry an explicit ISO-4217 currency code (§III / Money). The **transaction-money precision/scale**, the **line-tax representation**, the **per-line vs invoice-level rounding rule**, and the **banker's-vs-half-up mode** are resolved in the Money + Decision Gate; this requirement fixes only that money is exact-decimal + currency-bearing. (Catalog-pricing money is already pinned at `numeric(19,4)` + `char(3)` in 003 and is consumed as-is.)

### 6.2 Terminal events (void / refund)

- **FR-010**: Void and refund MUST be modeled as **separate terminal-event records** that reference the original sale; they MUST NOT mutate or delete the original `sales` / `sale_lines` rows (§X "modeled separately… not by mutating it").
- **FR-011**: Recording a void MUST stamp `voidedAt` on the void terminal-event record (server clock) and MUST leave the original sale + lines unchanged.
- **FR-012**: Recording a refund MUST stamp `refundedAt` on the refund terminal-event record (server clock) and MUST leave the original sale + lines unchanged. POS-reported refund amounts are preserved per FR-040.
- **FR-013**: Re-delivery of the same logical terminal event (same `sourceSystem + externalId` and/or idempotency token) MUST be deduplicated and MUST NOT create a duplicate terminal event or double-apply (§XI). A second void/refund of an already-terminal sale MUST yield a deterministic already-applied outcome.
- **FR-014**: A void/refund referencing a sale the actor is not authorized to see, or that does not exist, MUST surface as a **non-disclosing not-found** (§XII safe-404); no terminal event is created.
- **FR-015**: This spec models the *record* of a void/refund only. Refund/void **workflow depth** — approvals, partial-refund line selection, restocking, tender routing, store credit — is **out of scope** and deferred (see §3, §12).

### 6.3 Temporal semantics

- **FR-020**: Sales-bearing entities MUST model the temporal field set defined in §X: `occurredAt` (business event time), `receivedAt` (SaaS receipt, server clock), `processedAt` (SaaS processing complete), `businessDate` (tenant-local day from **store timezone**), `sourceClockAt` (POS-reported clock, preserved). Void/refund terminal events carry `voidedAt` / `refundedAt` respectively. **Which of these are required vs optional per entity is a [GATE] decision** (Money + Temporal Decision Gate); this requirement fixes the field *set* and the meaning of each.
- **FR-021**: All timestamps MUST be stored as UTC `TIMESTAMPTZ` (§X "Storage default is UTC").
- **FR-022**: Security and authorization clocks — idempotency-token TTL, rate-limit windows, any expiry decision — MUST be evaluated against the **server clock**, never against `sourceClockAt` or any client-reported time (§X).
- **FR-023**: `businessDate` MUST be derived from the **store timezone**, not the raw client clock (§X).
- **FR-024**: Delayed events (`occurredAt` arbitrarily behind `receivedAt`) MUST be captured normally and MUST NOT be rejected or silently rewritten on the basis of the time gap (§X "delayed events are expected").

### 6.4 POS-totals fidelity

- **FR-030**: POS-reported totals on a `sales` record (and POS-reported amounts on a refund terminal event) MUST be **preserved exactly as received** (§III "POS totals MUST be preserved as received"). The submission currency MUST be preserved as received.
- **FR-031**: The SaaS MAY compute its own total from the line snapshots and MAY set an **advisory mismatch flag** (a SaaS-owned processing-state field — §6.8) when the POS-reported total differs, and MAY emit the existing **reconciliation-mismatch-rate** observability signal (§VII). The SaaS MUST NOT silently rewrite the POS-reported total under any circumstance.
- **FR-032**: The mismatch flag is **advisory and non-authoritative**: it MUST NOT alter, suppress, or block the captured sale; the POS-reported total remains the recorded value (§III).

### 6.5 Provenance

- **FR-040**: Every ingested sale, void, and refund event MUST retain provenance: `sourceSystem`, `externalId`, ingestion timestamp(s), and a **payload hash** (or equivalent) sufficient to reconcile the SaaS record to the original payload at any time (§IX/§XIII). **The payload-hash algorithm is a [GATE] decision** (Money + Temporal Decision Gate); this requirement fixes only that a payload hash is retained.
- **FR-041**: The `(sourceSystem, externalId)` pair MUST resolve to the same SaaS record across retries within a tenant — it is the dedup contract (§XI). The pair is **never** body-assignable authority; it is recorded provenance.
- **FR-042**: Raw POS payloads MUST NOT be logged verbatim; provenance retention is a stored, redaction-disciplined surface, not a logging behavior (§VII/§XIV).

### 6.6 Idempotent ingestion

- **FR-050**: Sale, void, and refund ingestion MUST be idempotent on `sourceSystem + externalId`: a duplicate event MUST be detected and MUST NOT be double-applied (§XI). At most one `sales` record exists per logical `(tenant, sourceSystem, externalId)`.
- **FR-051**: When the POS contract supplies a request-level idempotency token, the system MUST honor it for sale/void/refund capture, reusing 005's token semantics unchanged: tuple `(tenant_id, device_id, token)` (005 FR-021a), honored ≥24h from first observation (005 FR-021b), token-vs-payload mismatch fails closed with a deterministic conflict and no side-effects (005 FR-021c). 008 introduces **no new idempotency primitive** — it consumes 001/005's existing `Idempotency-Key` mechanism.
- **FR-052**: A duplicate-detected ingestion MUST return the prior record's reference/response and MUST NOT increment capture telemetry; it MAY increment the existing **duplicate-event-rate** signal (§VII).

### 6.7 Isolation & object safety

- **FR-060**: Every `sales`, `sale_lines`, void, and refund row MUST carry NOT NULL `tenant_id` (and `store_id` where the entity is store-scoped) and MUST be protected by fail-closed RLS using the safe `current_setting('app.current_tenant', true)::uuid` form (§II). Cross-tenant access MUST surface as non-disclosing not-found (§II/§XII).
- **FR-061**: `tenant_id`, `store_id`, `created_by`/actor, the provenance pair, the server-derived `business_date`, `received_at`, `processed_at`, the mismatch flag, and any other server-owned field MUST NOT be **body-assignable** (§XII mass-assignment). Tenancy/store/actor resolve from the authenticated principal and path; server-owned timestamps/flags resolve from server-side processing.
- **FR-062**: Request validation MUST be **strict at the boundary** — unknown keys rejected (`.strict()` or equivalent), malformed values rejected — producing a deterministic failure outcome with no side-effects (§XII). Endpoints with no explicit authorization MUST fail closed — default-deny (§XII).
- **FR-063**: Object-level authorization MUST be enforced on every protected read and write: a request naming a target sale/line/terminal-event MUST verify the principal may act on that object, not merely reach the endpoint (§XII).

### 6.8 Concurrency posture

- **FR-070**: A captured sale (and its lines) is an **immutable historical fact**. The concurrency posture is **idempotent dedup on `sourceSystem + externalId`** (FR-050), not last-write-wins and not an optimistic-concurrency `version` column — a version column on an append-only fact table is explicitly **not** the chosen posture, and this is the §III/Concurrency justification the constitution requires when LWW/optimistic-locking is not used. Corrections are **append-only terminal events** (void/refund), never in-place updates (§X).
- **FR-071**: The only narrowly-mutable surface is the **SaaS-owned processing state** — `processedAt` and the advisory mismatch flag — written once by the SaaS during/after processing (typically off-request, §V). These fields are **not** POS-supplied (FR-061) and do **not** make the sale fact mutable; they record SaaS processing, not business state. Their write is idempotent and converges under retry (§XI). Concurrent capture of the same logical sale is resolved by the dedup contract (FR-050), so exactly one record results regardless of arrival order.

### 6.9 Per-tenant resource isolation

- **FR-080**: As the **first ingestion-heavy POS feature**, 008 MUST land with a documented per-tenant resource-isolation posture (Per-Tenant Resource Isolation section). It **consumes the existing platform rate-limit posture (001 / 004) unchanged** for inline single-sale capture and **extends** it with a documented bound on **bulk offline-recovery sync** so one tenant's recovery burst cannot starve others. Specific numeric limits are initial defaults and an **owner decision**; the existence of the posture is mandatory here.
- **FR-081**: Heavy or batched sale processing MUST NOT block the request path: off-request work (e.g., snapshot enrichment, mismatch computation, `processedAt`) belongs in a worker carrying `tenantId` / `storeId` / `correlationId` and establishing tenant context before DB access (§V). Bulk-sync fair-sharing MUST be considered before the bulk path ships (Per-Tenant Resource Isolation).

### 6.10 Audit & observability

- **FR-090**: Every sale capture, void, refund, and audited rejection MUST emit a business-level audit event attributed to the acting principal (POS device / operator / admin) with tenant, store, action, target reference, correlation id, outcome, and timestamp (§XIII canonical audit shape). The POS-device anonymous/actor labeling follows §XIII for pre-/non-user actors.
- **FR-091**: Observability MUST emit into the **already-named** constitution signals — **POS sync lag**, **duplicate-event rate**, **reconciliation-mismatch rate** (§VII) — and MUST NOT introduce a parallel naming scheme. (`unknown-item rate` remains 005's; 008 adds no new metric category.)
- **FR-092**: Audit is **insert-only** at the application layer; raw payloads, tokens, and any payment-class data MUST NOT appear in audit `metadata` or logs — redaction at the emitter/logger boundary (§VII/§XIII/§XIV).

### 6.11 User-visible outcomes

- **FR-100**: Success outcomes MUST be deterministic per logical action: same input + same authoritative state → same response (including the duplicate-detected replay returning the prior outcome).
- **FR-101**: Failure outcomes MUST distinguish at least these categories: validation-failure, not-found (cross-tenant or out-of-scope, non-disclosing), idempotency-token-mismatch (per 005 FR-021c, distinct from a duplicate), already-applied (re-delivered terminal event), conflict, system-failure. The specific transport encoding is deferred to this feature's `[GATED]` contract.
- **FR-102**: All outcomes MUST avoid leaking the existence of records the actor lacks authority to see (§II/§XII).

### Key Entities

This spec introduces the following **new** entities (the first sale-fact entities the SaaS owns). They are defined here at the behavioral level only; schema/migration/DTO/OpenAPI are HOW and out of scope.

- **Sale** (`sales`, new): the transaction/invoice header. Tenant- and store-scoped. Immutable historical fact. Carries the submission currency (ISO-4217), POS-reported totals (preserved), the §6.3 temporal field set, the §6.5 provenance set, and the SaaS-owned processing state (`processedAt`, advisory mismatch flag). The next migration (`0012+`) would create it under the `[GATED]` path.
- **Sale Line** (`sale_lines`, new): one row per sold line, child of `sales`. **Snapshots** price, item name, tax treatment, and unit as charged at sale time, plus quantity and line amounts. Frozen at capture; later catalog changes never mutate it. MAY reference a Tenant Product / Store Override for lineage but is not bound to live catalog values.
- **Void Terminal Event** (new): a separate record referencing a `sales` row, stamping `voidedAt`. Append-only; never mutates the original sale.
- **Refund Terminal Event** (new): a separate record referencing a `sales` row, stamping `refundedAt`, preserving POS-reported refund amounts. Append-only; workflow depth out of scope.
- **Tenant Product / Store Override / Price History** (existing, per 003): the catalog source-of-truth a `sale_line` snapshots *from*. Read-only for 008; never mutated by capture.
- **Unknown Item** (existing, per 003/005): the catalog-reconciliation signal 005 captures. **Complementary to, not part of,** the sale fact — an ad-hoc sale line and an unknown-item capture may both arise from the same scan, but they are distinct records with distinct purposes (FR-004, Edge Cases).
- **Idempotency Token / Record** (existing, per 001/005): consumed by every state-changing ingestion path; no new primitive.
- **Audit Event** (existing, per 001 + 005 §6.9): emitted by every audited path; no new event category.
- **Actor Principal** (existing, per 001/002): POS device / store operator / tenant admin / tenant owner. Consumed as-is.

---

## 7. Security & Isolation Requirements

- **SI-001**: A tenant MUST NOT observe another tenant's sales, sale lines, terminal events, totals, or provenance by any means — direct read, inference via error messages, conflict responses, dedup behavior (`externalId` collisions), or audit retrieval (§II).
- **SI-002**: Store-scoped operators MUST NOT observe or act on sales captured at stores outside their scope (§II store-access).
- **SI-003**: Tenant-wide actors MAY act across all stores only insofar as 001's membership/scope model grants tenant-wide authority. 008 introduces no new permission.
- **SI-004**: All cross-tenant and out-of-scope failures MUST be **non-disclosing** — the caller cannot tell whether the target exists (§II/§XII safe-404).
- **SI-005**: Capture MUST be **object-safe**: authority/provenance/processing fields are never body-assignable; strict boundary validation rejects unknown keys; endpoints fail closed by default (§XII).
- **SI-006**: The SaaS MUST NOT silently rewrite POS-reported totals or refund amounts; mismatch flagging is advisory and non-authoritative (§III).
- **SI-007**: A captured sale fact and its line snapshots MUST be **immutable** after capture; corrections are append-only terminal events; catalog changes never mutate past lines (§IX/§X).
- **SI-008**: Provenance (`sourceSystem`, `externalId`, ingestion timestamps, payload hash) MUST be retained and reconcilable; raw payloads MUST NOT be logged verbatim (§IX/§XIII/§VII).
- **SI-009**: PII / payment posture — identifier/catalog reference values are catalog reference data, not PII. Any customer reference or tender/payment data that a future gate decision admits into the sale fact is **payment-class** and MUST flow through the §XIV redaction/classification posture before leaving the tenant boundary in any log, metric, audit, or read API. In v1 (absent a gate decision), tender/payment data is not persisted by 008 (§3).
- **SI-010**: Every state-changing ingestion MUST be idempotent under the `sourceSystem + externalId` / `Idempotency-Key` contract — a replay MUST NOT produce a duplicate record or a hidden partial commit (§XI).
- **SI-011**: As the first ingestion-heavy feature, 008 MUST inherit the existing platform rate-limit / abuse-protection posture (001 / 004) and MUST land with a documented bulk-sync per-tenant bound; no path MUST offer an unbounded batch that circumvents the inherited posture or starves other tenants (Per-Tenant Resource Isolation).
- **SI-012**: The new sale-fact entities (`sales`, `sale_lines`, void/refund terminal events) MUST be classified for data-lifecycle purposes (§XIV). The default posture pending the gate decision (D.3): the sale fact itself is **business-class** (not PII, not payment-class — it carries catalog reference values, quantities, and POS-reported monetary totals, no customer identity), inheriting the platform retention posture (001 audit-retention precedent: long-horizon, insert-only for the immutable fact). A documented retention window and a right-to-erasure note (audit-immutable; PII-field tombstoning if any customer reference is ever admitted) MUST be recorded before implementation. Any future admission of customer-reference or tender/payment data reclassifies the affected fields as PII/payment-class under SI-009 and re-triggers this requirement.

---

## 8. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of captured `sale_lines` are immutable under subsequent catalog change — for any sale captured before a catalog price/name/tax edit, the `sale_lines` snapshot is byte-for-byte identical after the edit. (Measured by a snapshot-immutability integration test: capture, edit catalog, re-read lines.)
- **SC-002**: 100% of POS-reported totals are preserved exactly as received; 0% are rewritten by the SaaS. Where the SaaS computes a differing total, the difference surfaces only as an advisory flag + the reconciliation-mismatch signal. (Measured by a totals-fidelity test with deliberately mismatched payloads.)
- **SC-003**: Duplicate ingestion produces exactly one record per logical `(tenant, sourceSystem, externalId)` regardless of retry/re-delivery count; the response is identical across replays. (Measured by an idempotency-replay integration test.)
- **SC-004**: 100% of cross-tenant or out-of-scope access attempts (read, void, refund) surface as non-disclosing not-found; 0% reveal existence. (Measured by the isolation harness extended with sales cases — §VI cross-tenant/cross-store sweep.) Additionally, a **raw-SQL RLS-bypass probe** against each new sale-fact table (`sales`, `sale_lines`, void/refund) with `app.current_tenant` set to the wrong tenant MUST return **zero rows** (§VI RLS bypass probe) — locked into plan/tasks alongside the sweep.
- **SC-005**: 0% of malicious-override attempts succeed — injecting `tenant_id`, `store_id`, `created_by`, `processed_at`, `received_at`, `business_date`, the provenance pair, or a server-owned total/flag into a request body is ignored or rejected, never honored. (Measured by the malicious-override test class, §VI.)
- **SC-006**: 100% of void/refund corrections are recorded as separate terminal events; 0% mutate or delete the original sale or its lines. (Measured by a terminal-event-immutability test: original rows unchanged after void and after refund.)
- **SC-007**: 100% of delayed/offline events (`occurredAt` arbitrarily behind `receivedAt`) are captured, not rejected; `sourceClockAt` is preserved and never consulted for a security/TTL decision. (Measured by a delayed-sync integration test.)
- **SC-008**: 100% of captured sale/void/refund events retain reconcilable provenance (`sourceSystem`, `externalId`, ingestion timestamps, payload hash); a stored record is traceable to the payload that produced it. (Measured by a provenance-reconciliation test.)
- **SC-009**: 100% of sale capture / void / refund / audited-rejection paths are linkable to an audit event by correlation id within the audit-query SLA established for catalog operations (005 SC-004). (Measured by an audit-linkage test.)
- **SC-010**: Inline single-sale capture completes server-side within the latency budget the owner sets for this feature (directional default: align with 005 SC-008 — p95 ≤ 500 ms, p99 ≤ 1 s at the SaaS boundary). Bulk offline-recovery sync is governed by the §7 per-tenant bound, not this inline budget. (Measured in pre-release load tests; the exact budget is confirmable by the owner.)

---

## 9. Assumptions

- **005's POS ingestion seam is the foundation** — its dedup contract (`(tenant_id, store_id, identifier_type, value, source_system)` natural dedup + the `@Idempotent('required')` request-level token, tuple `(tenant_id, device_id, token)`, ≥24h TTL, fail-closed mismatch) is the established pattern 008 sale-ingestion builds **alongside**, not a thing 008 re-invents. 008 mounts a sibling POS-facing ingestion path in the same seam (the only `/api/pos/v1/...` device-token surface in catalog today).
- **003's catalog is the snapshot source** — Tenant Product / Store Override / Price History supply the values a `sale_line` freezes at capture. Catalog-pricing money is already pinned `numeric(19,4)` + `char(3)` ISO currency with paired-currency CHECKs and is consumed as-is.
- **001/002 supply identity, scope, audit, the idempotency primitive, and the platform rate-limit posture.** 008 consumes them; it introduces no new auth, audit, or idempotency mechanism.
- **The constitution's four money/temporal Follow-up TODOs are *this feature's* gate.** Transaction-money representation/precision, the per-entity timestamp required/optional set, the payload-hash algorithm, and the per-tenant request-quota / noisy-neighbor policy (Sync Impact Report TODOs #1, #2, #3, #6) are unresolved at constitution level and are resolved in the Money + Temporal Decision Gate before implementation — not improvised in code, not pre-decided in this spec. (TODO #7, data-classification/retention, is added to the gate as item D.3; TODO #4, audit-storage growth, is deferred per its own clause.)
- A captured sale is an **immutable fact**; corrections are append-only terminal events; the only mutable surface is SaaS-owned processing state.
- **The dashboard UI and sales reporting are separate future features.** This spec defines what is *captured and preserved*, not how it is rendered or reported.
- The highest existing migration is `0011`; an implementing slice would add `0012+` under the `[GATED]` migration path.

---

## 10. Dependencies

| Dependency | What 008 relies on it for |
|---|---|
| **specs/005-pos-catalog-sync-reconciliation** | The POS ingestion **seam** (the `/api/pos/v1/...` device-token surface), the dedup contract, and the idempotency-token semantics (tuple / TTL / fail-closed mismatch) that 008 sale-ingestion builds **alongside** and reuses. **Hard prerequisite (pattern).** |
| **specs/003-catalog-foundation** | The catalog source-of-truth (`tenant_products`, `product_aliases`, `store_product_overrides`, `price_history`) a `sale_line` snapshots **from**, and the already-pinned `numeric(19,4)` + ISO-currency money representation 008 inherits for catalog-derived values. **Hard prerequisite.** |
| **specs/002-pos-operator-identity** | Authenticated POS principal (tenant + store + device) that submits sale/void/refund events; the device identity behind the idempotency tuple. |
| **specs/001-foundation-auth-tenant-store** | Tenant/store/membership model, audit pipeline + correlation-id, the `(tenant, store, client, key)` idempotency primitive, and the platform rate-limit posture 008 inherits and extends. |
| **Constitution v3.0.1** | §III (money exact-decimal + POS-totals-preserved), §IX (sale-line snapshot / provenance), §X (retail temporal semantics), §XI (idempotency / external IDs), §XII (object safety), §XIII (auditability / provenance), Per-Tenant Resource Isolation, §V (worker seam). The four money/temporal Follow-up TODOs in the Sync Impact Report are this feature's gate. |
| **POS-Pulse (separate repo) — DEPENDENCY NOTE, not a blocker** | The live end-to-end loop additionally needs POS-Pulse to **emit sales**. POS-Pulse does **not** emit sales today (it integrates only via the existing contracts; sales emission is unimplemented on the POS side). 008's backend capture surface can be specified, built, and tested against contract fixtures **independently**; the live loop is gated on a POS-Pulse change that is **out of this repo's ownership**. Flag for roadmap coordination — does **not** block 008's spec, plan, or backend implementation. |

008 introduces **no new dependency** beyond those it transitively consumes; it does add **new entities** (`sales`, `sale_lines`, void/refund terminal events) — the first sale-fact entities in the system.

---

## 11. Open Questions

> **RESOLVED 2026-05-30.** All of OQ-1..OQ-7 below were owner-decided in the **Money + Temporal Decision Gate** (`gate-money-temporal.md` §Decisions Recorded) and mirrored into §Clarifications (Session 2026-05-30) above. The gate is **CLOSED**; **`/speckit-plan` is unblocked.** The original questions are retained below for provenance with their resolutions noted inline.

The following were **decisions for the owner**, consolidated in the **Money + Temporal Decision Gate** (`gate-money-temporal.md`). They blocked planning/implementation, not this specification — now resolved:

- **OQ-1 — Transaction-money representation** *(constitution Follow-up TODO #1 + Money-Tax-Rounding)*: line-tax representation, per-line vs invoice rounding, banker's-vs-half-up, `numeric(p,s)` precision/scale, money library. **→ RESOLVED (gate A.1–A.4, A.6): `numeric(19,4)`, single per-line snapshot tax, per-line + half-up, string-backed value object (no new dependency).**
- **OQ-2 — Tender / change / multi-tax modeling** *(Money-Tax-Rounding + §XIV)*: persist tender or defer? **→ RESOLVED (gate A.5): deferred to payments feature 010; no tender persistence in 008 v1.**
- **OQ-3 — Per-entity timestamp required/optional set** *(constitution Follow-up TODO #2 + §X)*: which timestamps NOT NULL vs nullable. **→ RESOLVED (gate B): `occurredAt`/`receivedAt`/`businessDate` NN on `sales`, `voidedAt`/`refundedAt` NN on terminal events; `processedAt`/`sourceClockAt` nullable; `sale_lines` inherit parent.**
- **OQ-4 — Payload-hash algorithm** *(constitution Follow-up TODO #3 + §IX/§XIII)*: algorithm + canonicalization. **→ RESOLVED (gate C): SHA-256 over canonical (sorted-key) JSON, full payload.**
- **OQ-5 — Concurrency posture confirmation** *(§III / Concurrency)*: immutable-fact + dedup, no version column. **→ RESOLVED (gate D.1): ratified — no optimistic `version` column on the append-only fact; dedup is the concurrency control.**
- **OQ-6 — Per-tenant bulk-sync bound** *(Per-Tenant Resource Isolation)*: initial numeric defaults. **→ RESOLVED (gate D.2): 500 sale events/request ceiling + inherited 001/004 platform posture (tunable in plan).**
- **OQ-7 — Sale-fact data class + retention window** *(constitution Follow-up TODO #7 + §XIV; spec SI-012)*: data class + retention + erasure. **→ RESOLVED (gate D.3): business-class, inherit 001 long-horizon insert-only retention, tombstone-on-erasure for any future PII field. The §13 row XIV "pending D.3" scope is removed.**

---

## 12. Out of Scope (Reaffirmed)

- No API endpoint shape, paths, status codes, header/field names, or contract YAML.
- No DB schema, Drizzle schema, SQL migration, index, RLS DDL, or CHECK constraint.
- No transaction-money decision (precision, rounding, tax shape, tender model) — gate-owned.
- No timestamp nullability decision — gate-owned.
- No payload-hash algorithm choice — gate-owned.
- No pricing engine, tax engine, or promotions engine (→ 010).
- No returns/refunds **workflow** depth, no sales **reporting/analytics** (→ 012).
- No inventory / stock-movement, no purchasing/supplier modeling.
- No payment/tender persistence in v1 (gate may revisit; payment-class under §XIV).
- No dashboard UI, no POS-side sale behavior, no client SDK.
- No analytics, dbt, ClickHouse, Dagster, billing, or CI/observability-dashboard work.
- No task breakdown — `/speckit-plan` is the next command **after the Money + Temporal Decision Gate is resolved**; `/speckit-tasks` follows the plan.

---

## 13. Constitution Check

Against `.specify/memory/constitution.md` v3.0.1. 008 is the **first feature to exercise §IX/§X/§XI on a real sale entity** — where 001 §14 recorded these as *"not exercised — no sale entities are defined here,"* 008 binds them.

| Principle | How this spec satisfies it |
|---|---|
| I. Reference, Not Source of Truth | Sale model specified from current requirements + the constitution, not lifted from legacy `Data-Pulse`. |
| II. Multi-Tenant SaaS by Default | FR-060 (NOT NULL `tenant_id`/`store_id`, fail-closed RLS), FR-063, SI-001..004 — every sale/line/terminal-event tenant+store scoped; cross-tenant = non-disclosing 404. |
| III. Backend Authority & Data Integrity (NON-NEGOTIABLE) | FR-005 (exact-decimal + currency, floats forbidden), FR-030..032 (POS totals preserved, never silently rewritten), FR-070..071 (concurrency posture justified: immutable fact + idempotent dedup, not LWW, not a version column). |
| IV. Contract-First POS Integration | POS ingestion is contract-first via the `[GATED]` OpenAPI path (deferred HOW); 008 builds on 005's `/api/pos/v1/...` seam; no raw DB entities in responses (binds plan/task). No wire shape authored here. |
| V. Async Work Belongs in Workers | FR-081 — heavy/batched processing off the request path; worker carries tenantId/storeId/correlationId and sets tenant context before DB access. |
| VI. Test-First Quality | SC-001..010 specify the test posture; isolation harness + cross-tenant/cross-store sweep + malicious-override (FR-061) + idempotency-replay (FR-050) + the **raw-SQL RLS-bypass probe** (wrong-tenant GUC ⇒ zero rows) on each new sale-fact table (SC-004) bind plan/tasks; RED before GREEN. |
| VII. Observable Systems | FR-091 reuses the **already-named** signals (POS sync lag, duplicate-event rate, reconciliation-mismatch rate); FR-042/FR-092 forbid raw-payload/secret logging. No parallel naming. |
| VIII. Reproducible & Versioned Releases | New schema/migration (`0012+`) and OpenAPI are `[GATED]` and approval-recorded; none authored in this spec. Migration reversibility binds the implementing slice. |
| IX. Source-of-Truth Model | **Exercised.** FR-002/FR-003 (SaleLine snapshot is truth for the invoice; catalog is reference); FR-040..042 (raw POS payload + provenance preserved/traceable). Cross-layer write ("catalog edit mutates past sale") is forbidden by FR-003. |
| X. Retail Temporal Semantics | **Exercised.** FR-020..024 (the full timestamp field set, UTC storage, server security clock, store-tz `businessDate`, delayed events accepted); FR-010..012 (void/refund as separate terminal events, never in-place mutation). |
| XI. Idempotency & External IDs | FR-050..052 (`sourceSystem + externalId` dedup, no double-apply), FR-051 (reuses 001/005's `Idempotency-Key` primitive + token semantics); SI-010. |
| XII. Authorization & Object Safety | FR-061 (mass-assignment forbidden), FR-062 (strict `.strict()` boundary, default-deny), FR-063 (object-level authz), FR-014/SI-004 (safe-404). |
| XIII. Auditability & Provenance | FR-090 (canonical audit shape per event), FR-040..042 (provenance: sourceSystem/externalId/ingestion timestamps/payload hash), FR-092 (insert-only, emitter-redacted). |
| XIV. PII & Data Lifecycle Discipline | **Exercised; D.3 RESOLVED 2026-05-30.** SI-009 — tender/payment data is payment-class under §XIV; v1 persists none (A.5 deferred tender to 010); raw payloads never logged; redaction at the boundary. SI-012 / gate D.3 — sale-fact entities are classified **business-class**, **retention inherits the 001 long-horizon insert-only posture**, and right-to-erasure tombstones any future PII field rather than deleting the immutable fact. The earlier "pending D.3" scope is removed: classification, retention window, and erasure note are now recorded. |

**Spec-level Constitution Check: PASS.** The constitutional **Follow-up TODOs** that this feature exercises (money representation #1, timestamp required/optional #2, payload-hash algorithm #3, per-tenant quota #6, sale-fact classification/retention #7) were owner-decided in the Money + Temporal Decision Gate (§11 / `gate-money-temporal.md` §Decisions Recorded, RESOLVED 2026-05-30) — none is a violation, and all are now closed. (TODO #4, audit-storage growth, remains deferred per its own clause.)

---

## Appendix A — Scenario-to-Requirement Coverage

| Scenario | Covered by |
|---|---|
| POS submits a completed sale, recorded as an immutable fact | US1; FR-001, FR-002, FR-005, FR-060 |
| Line-level snapshot frozen against later catalog change | US1; FR-002, FR-003; SC-001 |
| POS totals preserved; mismatch flagged not rewritten | US1; FR-030..032; SC-002 |
| Duplicate sale event deduplicated (no double-apply) | US1 + US5; FR-050..052; SC-003 |
| Delayed/offline sync accepted; time not rewritten | US2; FR-020..024; SC-007 |
| Void recorded as a separate terminal event | US3; FR-010, FR-011, FR-013; SC-006 |
| Refund recorded as a separate terminal event | US4; FR-010, FR-012, FR-013; SC-006 |
| Provenance retained + reconcilable | US5; FR-040..042; SC-008 |
| Idempotency-token semantics (reused from 005) | US5; FR-051; 005 FR-021a/b/c |
| Tenant/store isolation + object safety + safe-404 | US6; FR-060..063; SI-001..005; SC-004/SC-005 |
| Concurrency posture (immutable + dedup, append-only corrections) | US1 + US3 + US4; FR-070, FR-071; OQ-5 |
| Per-tenant resource isolation (first ingestion-heavy feature) | Edge Cases + FR-080, FR-081; SI-011; OQ-6 |
| Audit on every state change | US6; FR-090..092; SC-009 |
