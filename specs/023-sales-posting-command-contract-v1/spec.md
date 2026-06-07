# Feature Specification: Sales-Posting Command Contract v1

**Feature Branch**: `023-sales-posting-command-contract-v1`

**Feature ID**: 023

**Short name**: sales-posting-command-contract-v1

**Created**: 2026-06-07

**Status**: 📋 **PLAN-ONLY — implement in future only if needed**

**Constitution version**: 3.0.1

**Input**: User description: "Sales-posting command contract v1"

---

> ## ⚠️ PLAN-ONLY — implement in the future ONLY if a concrete need is confirmed
>
> 023 is the **"sales-posting command, *if needed*"** arc handoff named by 018.
> It is a **planning + contract-design spec only** — it authors NO code, NO
> OpenAPI YAML, NO schema, NO migration. **It is NOT scheduled for
> implementation.**
>
> The shipped pull/feed transport (012 contract + 015) already posts sales
> end-to-end and is sufficient for the pilot. 023's command transport is an
> **additive, parallel, optional** alternative that earns implementation **only
> if a concrete need is later confirmed** (e.g. low-latency single-sale posting,
> an operator "post this sale now" repair flow, or a cursor-less connector
> runtime). That need-confirmation is **task T005, an explicit owner gate** — the
> `[GATED]` contract slice MUST NOT run until it clears. If no need materialises,
> 023 stays planning-only indefinitely.
>
> Transport direction (OQ-1) is already resolved → **connector-initiated**
> (genuine DP2→connector push rejected, 2026-06-07; preserves §IX).

---

## 0. What this spec is (and is not)

This is the **planning + contract-design spec** for 023 — a **command-style**
(per-work-item, imperative) realisation of the DP2 ↔ ERPNext-connector sales
posting boundary, named by 018 as a future arc handoff: *"023 (sales-posting
command, if needed)."*

The shipped arc already posts sales over a **pull/feed bidirectional**
transport: the 012 contract
(`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`) exposes
`connectorPullPostings` (the connector PULLS a cursor feed of pending postings)
and `connectorAckOutcome` (the connector POSTs an outcome ack). 015 (CLOSED)
implements that feed/ack end-to-end. **023 is an ADDITIVE, VERSIONED,
PARALLEL transport option — NOT a redesign or replacement of 012/015.** The
pull feed remains the default and stays untouched.

It is **docs / planning + contract-design only**: no application code, no DB
schema, no migration, no OpenAPI YAML, no `package.json`/lockfile, no CI, no
connector code. The eventual `[GATED]` artifact is a new OpenAPI YAML under
`packages/contracts/openapi/erpnext-connector/` — this spec **describes** it in
prose but does **not** author it (it is authored in a later `[GATED]`
023-CONTRACT slice, gated per §VIII).

Like 011/012/013/015's spec PRs, this spec establishes purpose, the command
transport shape, the obligations the eventual contract MUST satisfy, the
constraints it inherits verbatim from 012, the failure posture, and the open
questions. **Implementation stays blocked** until 023 runs its Spec-Kit chain
(`plan.md` → Constitution Check → the `[GATED]` contract → `tasks.md` →
`execution-map.yaml`) and the Agent OS gates clear.

Companion documents produced by the plan step: `plan.md`, `research.md`,
`data-model.md`, `tasks.md`, `analysis.md`, `review.md`.

---

## 1. Background & Why

The arc invariant (012 contract header, 017, `contract-obligations.md`, §IX) is:
**DP2 makes NO outbound HTTP calls. DP2 EXPOSES endpoints; the connector CALLS
them.** The connector is the only component that talks to ERPNext; it holds the
ERPNext credentials and authenticates to DP2 as a dedicated, tenant-scoped,
revocable **machine** principal (`connectorBearer`, the opaque revocable bearer
baseline — NOT POS `clerkJwt`, NOT a human cookie session).

The 012 pull feed works by having the connector poll a cursor feed. A
**command-style** transport is the imperative alternative: rather than scanning
a feed for "what is pending since cursor X," the connector addresses **one
specific posting work-item** by reference and executes the posting command for
it — a request/command resource per work-item, with the outcome reported in the
same exchange or via the existing ack. This trades the feed's batch/cursor
ergonomics for lower-latency, targeted, single-item posting and simpler connector
state (no cursor to retain).

**Why "if needed":** the pull feed is sufficient for the pilot. A command
transport earns its place only if a concrete need emerges — e.g. near-real-time
single-sale posting where feed-poll latency is unacceptable, an operator-triggered
"post this sale now" repair flow that wants a synchronous result, or a connector
runtime that cannot retain a durable cursor. This spec records that need as an
explicit assumption to validate, not a foregone conclusion (see §Assumptions and
the flagged open question).

023 **reuses 012's design vocabulary verbatim** (money, idempotency,
non-disclosure, error envelope, sale projection, Payment Entry deferral) so the
command transport and the feed transport speak the same dialect and a connector
can support either against a stable boundary.

---

## 2. Purpose

Define, at the planning + contract-design level:

- The **command transport shape**: how the connector posts ONE specific sale
  work-item imperatively, by reference, and how the outcome is reported — while
  preserving the no-outbound-HTTP invariant (the connector still initiates the
  call to DP2).
- The **obligations** the eventual `[GATED]` 023-CONTRACT YAML MUST satisfy,
  inherited from the 012 obligations (O-1..O-6) and the signed posting decision.
- The **idempotency, temporal, and money** discipline the command surface must
  satisfy (mirrored verbatim from 012, no new primitive).
- The **additive/versioning posture**: a new `operationId` set and a new path
  segment that never touch or rename the 012 feed operations (§IV).
- The **failure posture** (DLQ + reconciliation reuse via 015/017, no silent
  rewrite of the sale fact, §IX/§X).
- The **open questions** — the one genuinely-human decision (genuine
  DP2→connector push vs connector-initiated command) was escalated as OQ-1 and
  **RESOLVED by the owner 2026-06-07 → connector-initiated** (push rejected).

---

## 3. Non-Goals

This feature is **planning + contract-design only**. It explicitly does **NOT**:

- Author **OpenAPI YAML** under `packages/contracts/openapi/**` — including any
  edit to `erpnext-connector/posting-feed.yaml` (read-only input). The eventual
  command-contract YAML is a **future `[GATED]` 023-CONTRACT slice**.
- **Redesign or deprecate the 012 pull feed.** The feed remains the default; 023
  is additive. No `operationId` rename, no version reuse, no breaking change to
  012 (§IV).
- Author any **DB schema, Drizzle schema, or SQL migration** (`packages/db/**`).
  Any posting-status / work-item state is owned by 015's existing model; 023
  reads/advances it, it does not introduce a new schema here.
- Implement the **command endpoint** (DP2-side handler) or any **connector
  code** — those are future implementation slices / the connector repo.
- Introduce **tender / Payment Entry** fields — the gate A.5 deferral holds
  (008 models no tender). The command work-item carries the sale only.
- Add any **ERPNext/Frappe client dependency** or register any outbox event type
  (separate `[GATED]` approvals).
- Build **scheduled, batch, or fan-out** posting — the command surface is
  single-work-item by design (batch stays the feed's job).

---

## 4. Source-of-truth & boundary posture (§IX)

- **DP2 is the source of truth** for the sale fact (008) and its posting status
  (015). The command exchange NEVER mutates the immutable sale fact; it only
  advances posting status, exactly as the 012 ack does (§IX, §X — void/refund are
  separate terminal events, never edits).
- **DP2 exposes; the connector calls.** The command resource lives at a DP2
  endpoint the connector invokes. DP2 makes no outbound HTTP. (The genuine-push
  alternative is the single flagged open question — see §10.)
- **Scope is taken from the authenticated connector principal ONLY.** Body- or
  query-supplied tenant/store scope is rejected (§XII strict boundary). No
  `tenant_id` is echoed in any response.
- **Money is exact-decimal string + ISO-4217 currency**, `numeric(19,4)`, never
  a float (§III money rule, gate A.6) — verbatim from 012.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connector executes a single sale-posting command (Priority: P1)

A connector instance, authenticated as its machine principal, addresses one
specific pending posting work-item by its server-issued reference and executes
the posting command for it — receiving the work-item payload it needs to post
(the 008 sale projection with DP2-resolved ERPNext Item identity) without
scanning a feed, and reporting the posting outcome back so DP2 advances the
posting status. The sale fact is never mutated.

**Why this priority**: This is the core value of a command transport — targeted,
low-latency, single-item posting addressed by reference. Without it, 023 delivers
nothing. It is the MVP and is independently demonstrable against the contract
conformance harness.

**Independent Test**: Load the eventual contract YAML in the conformance spec and
assert: the command operation exists with a stable `operationId`, requires
`connectorBearer`, takes a work-item reference, returns the full posting
work-item payload (sale projection + resolved item identity + provenance +
`businessDate`), and accepts/returns the canonical wire shapes — all without any
reference to the 012 feed operations.

**Acceptance Scenarios**:

1. **Given** a pending posting work-item in the connector principal's tenant
   scope, **When** the connector invokes the command operation with that
   work-item reference, **Then** the response carries the complete 008 sale
   projection (header + frozen lines, each with a DP2-resolved `erpnextItemRef`),
   provenance (`sourceSystem`, `externalId`, `payloadHash`), and `businessDate`,
   with money as exact-decimal string + currency.
2. **Given** a work-item reference that belongs to a different tenant or does not
   exist, **When** the connector invokes the command, **Then** DP2 returns a
   non-disclosing `not_found` (404-class) with no existence leak (§II/§XII).
3. **Given** a request whose body or query carries a `tenant_id` / `store_id`,
   **When** the command is invoked, **Then** the server-owned scope field is
   rejected (`validation_failure`), never honored (§XII mass-assignment ban).
4. **Given** a `reversal` work-item (from an 008 void/refund terminal event),
   **When** the connector invokes the command, **Then** the payload references
   the original sale's provenance (`reversalOf`) so the connector posts a NEW
   reversing document, never an edit of the original (O-4).

---

### User Story 2 - Connector reports the command outcome idempotently (Priority: P1)

The connector reports the outcome of executing a posting command (`posted` with
the ERPNext document reference / `failed_transient` / `permanently_rejected` with
a structured reason). The outcome report is idempotent: a retry with the same
`Idempotency-Key` replays the prior recorded outcome and never double-applies; a
duplicate `posted` echoes the existing document reference rather than creating a
second; a key reused with a different logical outcome is a 409 conflict.

**Why this priority**: The return path is non-optional — a command is not
complete until DP2 records its outcome (O-2). At-least-once delivery means the
outcome report MUST be idempotent (§XI). This is co-MVP with US1.

**Independent Test**: Assert the outcome operation requires `Idempotency-Key`,
documents 200-replay / 201-fresh / 409-conflict, requires `documentRef` on
`posted` and `reason` on `permanently_rejected`, and reuses the canonical
recorded-outcome projection — verifiable structurally against the contract.

**Acceptance Scenarios**:

1. **Given** a freshly executed command, **When** the connector reports
   `posted` with a `documentRef`, **Then** DP2 records the outcome once (201) and
   advances the posting status; the sale fact is unchanged.
2. **Given** an already-reported outcome, **When** the connector retries with the
   same `Idempotency-Key` and the same logical outcome, **Then** DP2 returns the
   identical recorded-outcome projection (200, `Idempotent-Replayed: true`) with
   no double-apply.
3. **Given** a reported `posted` outcome, **When** the connector re-reports the
   same work-item with a DIFFERENT logical outcome under the same key, **Then**
   DP2 returns 409 `idempotency_key_conflict` with no side effects.
4. **Given** a `permanently_rejected` outcome with a structured `reason`,
   **When** it is recorded, **Then** DP2 dead-letters the work-item and raises a
   reconciliation flag (017), reusing the existing 015 O-3 / 017 state — no new
   DLQ primitive (O-2).

---

### User Story 3 - The command contract is additive and version-isolated (Priority: P2)

A contract reviewer (and the connector maintainer) can confirm that 023 adds a
new posting transport WITHOUT touching, renaming, or breaking the 012 pull-feed
operations, and that the command contract speaks only in Retail-Tower terms
(sale, line, businessDate, outcome, documentRef) — never ERPNext doctype field
names — so an ERPNext version change never alters this DP2-facing contract.

**Why this priority**: §IV makes `operationId` renames and version reuse breaking
changes. The arc's stability depends on the command transport being purely
additive and on O-6 version-independence. It is P2 because it gates safe
coexistence rather than the posting capability itself.

**Independent Test**: A conformance assertion that the 012 feed operations and
their `operationId`s are unchanged (no diff to `posting-feed.yaml`), that 023's
operations have new distinct `operationId`s under a new path segment, and that no
023 schema names an ERPNext doctype field.

**Acceptance Scenarios**:

1. **Given** the 023 contract YAML, **When** it is loaded alongside 012, **Then**
   the 012 `connectorPullPostings` / `connectorAckOutcome` operations and their
   `operationId`s are byte-unchanged.
2. **Given** the 023 contract, **When** schema field names are inspected, **Then**
   none names an ERPNext doctype field; documents are addressed only by the
   generic `doctype` + `name` shape (O-6).
3. **Given** a future Payment Entry / tender extension, **When** it lands, **Then**
   it is a versioned, backward-compatible addition (the deferral holds today,
   gate A.5).

---

### Edge Cases

- **Stale / already-resolved work-item**: invoking the command for a work-item
  already in a terminal posting state (already `posted`) MUST be safe — it returns
  the recorded outcome / current state idempotently, never re-posts.
- **Work-item not yet projectable** (e.g. a sale line with no confirmed 013
  `erpnext_item_map` resolution): such items fail-to-DLQ in DP2 BEFORE the command
  can offer them (011 posting rider R2/R3/R4), so every command-offered work-item
  carries a resolved `erpnextItemRef`. Invoking the command for a non-projectable
  ref is a non-disclosing `not_found`.
- **Concurrent commands for the same work-item** (two connector instances /
  retries): the idempotent outcome contract (§XI) ensures exactly one logical
  outcome; a duplicate `posted` echoes the same `documentRef`.
- **Foreign-scope / cross-tenant reference**: identical `not_found` for
  cross-tenant, out-of-scope, and genuinely-absent refs — no existence leak.
- **Missing conditional field**: `posted` without `documentRef`, or
  `permanently_rejected` without `reason`, is a deterministic `validation_failure`
  with no record created.
- **Auth refusal**: a missing / invalid / revoked connector bearer, a missing
  tenant binding, or an in-scope-but-not-permitted principal all return the same
  generic non-disclosing 401.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The eventual `[GATED]` 023 contract MUST define a **command
  operation** by which the connector executes the posting of ONE specific
  work-item, addressed by a server-issued, scope-bound work-item reference, with a
  stable `operationId` distinct from any 012 operation.
- **FR-002**: The command operation MUST return the complete posting **work-item
  payload** (O-1): the 008 sale projection (header + frozen lines), each line's
  DP2-resolved `erpnextItemRef`, provenance (`sourceSystem`, `externalId`,
  `payloadHash`), `businessDate`, and the `kind` (`sale_post` | `reversal`) — so
  the connector posts WITHOUT reaching back into DP2.
- **FR-003**: For a `reversal` work-item, the payload MUST carry the original
  sale's provenance (`reversalOf`) so the connector posts a NEW reversing document
  (credit note / return invoice), never an edit of the original (O-4).
- **FR-004**: The contract MUST define an **outcome report** operation (or reuse
  the recorded-outcome projection) by which the connector reports `posted` (with
  `documentRef`) | `failed_transient` | `permanently_rejected` (with structured
  `reason`) for a command (O-2). A work-item is not complete until DP2 records its
  outcome.
- **FR-005**: The outcome report MUST be **idempotent** via a REQUIRED
  `Idempotency-Key` header, reusing the existing `IdempotencyInterceptor`: an
  identical retry replays the stored response (200, `Idempotent-Replayed: true`);
  a duplicate `posted` echoes the existing `documentRef`; a key reused with a
  different logical outcome returns 409 `idempotency_key_conflict`. No new
  idempotency primitive (§XI, O-3).
- **FR-006**: The command and outcome operations MUST authenticate via
  `connectorBearer` (opaque revocable tenant-scoped machine bearer) — NOT
  `clerkJwt`, NOT a human cookie session. Auth is verified at the API edge,
  fail-closed.
- **FR-007**: Tenant/store/actor scope MUST resolve from the authenticated
  connector principal ONLY; body- or query-supplied scope MUST be rejected
  (`validation_failure`), never honored (§XII mass-assignment ban, strict body).
- **FR-008**: A cross-tenant / out-of-scope / absent work-item reference MUST
  return a non-disclosing `not_found` (404-class) with NO existence leak via any
  response or error shape (§II/§XII).
- **FR-009**: All monetary fields MUST be exact-decimal strings paired with an
  ISO-4217 `currency_code` (`numeric(19,4)` at rest), never floats (§III, gate
  A.6) — verbatim from 012's `DecimalAmount` / `CurrencyCode`.
- **FR-010**: All request/response bodies MUST be explicit wire projections (§IV)
  — no raw DB shape, no credentials, no `payloadHash` echoed in the outcome
  response, no `tenant_id`.
- **FR-011**: All operations MUST use the canonical `Error` envelope identical to
  `auth.openapi.yaml` / `outbox.openapi.yaml` / `pos-sales/sales.yaml` /
  `posting-feed.yaml`, with a closed `error.code` set on this surface
  (`validation_failure`, `idempotency_key_conflict`, `not_found`,
  `system_failure`, plus the generic 401 refusal). `request_id` is always present.
- **FR-012**: The contract MUST be **version-independent** (O-6): it speaks only
  in Retail-Tower terms; ERPNext documents are addressed by the generic
  `doctype` + `name` shape; no schema names an ERPNext doctype field.
- **FR-013**: 023 MUST NOT touch, rename, deprecate, or break the 012 pull-feed
  operations. The command operations live under a new path segment and carry new
  distinct `operationId`s; 012 coexists unchanged (§IV additive versioning).
- **FR-014**: The command exchange MUST NEVER mutate the immutable 008 sale fact;
  it advances only the 015 posting status, reusing the existing 015 O-3 / 017
  DLQ + reconciliation state (§IX/§X). No new posting-status schema is introduced
  by this contract.
- **FR-015**: Invoking the command for a work-item already in a terminal posting
  state MUST be safe and idempotent — it returns the current recorded state and
  never re-posts.
- **FR-016**: The work-item payload MUST NOT carry tender / payment fields — the
  Payment Entry deferral (gate A.5) holds; `posTotal` is the sale total, not
  tender. A future tender extension is a versioned, backward-compatible addition.
- **FR-017**: The eventual contract YAML MUST be exercised by an automated
  **conformance test** (§IV, §VI), loaded with an explicit `dir` because the
  production `loadOpenApiContracts` helper is non-recursive — mirroring how
  `posting-feed.yaml` is loaded.

### Key Entities *(include if feature involves data)*

- **Posting Command (work-item execution request)**: the connector's imperative
  request to post one specific work-item, addressed by `workItemRef`. Carries no
  body scope; scope is the principal's. Returns the posting work-item payload.
- **Posting Work-Item payload**: the 008 sale projection (header + frozen lines
  with resolved `erpnextItemRef`) + provenance + `businessDate` + `kind` +
  optional `reversalOf` — mirrors the 012 `PostingWorkItem`/`Sale`/`SaleLine`
  shapes verbatim (curated subset, no advisory/request-only fields).
- **Outcome report**: `posted` (with `documentRef`) | `failed_transient` |
  `permanently_rejected` (with structured `reason`); idempotent via
  `Idempotency-Key`. Mirrors 012's `OutcomeAckRequest`.
- **Recorded outcome (response projection)**: `workItemRef` + `outcome` +
  nullable `documentRef` + `recordedAt` (server clock) + `dlqueued` flag —
  mirrors 012's `RecordedOutcome`.
- **ErpnextDocumentRef / ErpnextItemRef**: generic `doctype` + `name` addressing
  (O-6), reused verbatim from 012.
- **Error envelope**: canonical `{ error: { code, message, request_id } }`,
  reused verbatim.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A contract reviewer can determine, from the eventual YAML alone,
  exactly how a connector executes a single posting command and reports its
  outcome — without reading connector code or the 012 feed contract.
- **SC-002**: 100% of the obligations inherited from 012 (O-1..O-4, O-6) and the
  posting decision are satisfied by the command surface, verifiable line-by-line
  against the contract.
- **SC-003**: The conformance test suite passes 100% (every operation, every
  closed error code, the idempotency replay/conflict behavior, and the
  no-existence-leak posture are asserted structurally).
- **SC-004**: Zero diff to `posting-feed.yaml` and zero `operationId` collisions
  with 012 — the command transport is provably additive (§IV).
- **SC-005**: Zero monetary fields typed as `number`/float; every monetary field
  is a string paired with a currency code (gate A.6), verifiable by schema scan.
- **SC-006**: Zero schema field names referencing ERPNext doctype internals
  (O-6), verifiable by schema scan.

## Assumptions

- **Need is provisional.** The pull feed (012/015) is sufficient for the pilot.
  023 is built "if needed"; this spec assumes a concrete need (low-latency
  single-sale posting, an operator "post now" repair flow, or a cursor-less
  connector runtime) will be confirmed before the `[GATED]` 023-CONTRACT slice is
  authorized. If no need materialises, 023 stays planning-only.
- **No-outbound-HTTP invariant holds.** The default realisation keeps the
  connector as the caller (DP2 exposes the command endpoint). Genuine
  DP2→connector push is NOT assumed (see §10 open question).
- **015 posting-status model is reused as-is.** 023 introduces no new
  posting-status / DLQ schema; it advances the existing 015 state and reuses the
  017 reconciliation/repair surface.
- **013 item resolution is DP2-side.** Every command-offered work-item already
  carries a DP2-resolved `erpnextItemRef` (011 rider R2); unresolved items
  fail-to-DLQ before offer.
- **Payment Entry deferral holds** (gate A.5) — the command work-item carries the
  sale only, no tender.
- **Connector principal provisioning is a DP2 implementation concern** (012/018),
  not part of this wire contract; the contract pins only that auth is an opaque
  revocable tenant-scoped service bearer.
- **Single region** data-residency posture (inherited platform default, §XIV);
  the contract carries no PII beyond the sale projection already exposed by 012.

---

## 10. Open Questions

- **OQ-1 (RESOLVED 2026-06-07 by owner — connector-initiated command):**
  "Command" means a **connector-initiated** imperative POST/GET against a
  DP2-exposed endpoint. DP2 remains the HTTP **server**; the connector remains the
  only outbound caller. This **preserves the §IX no-outbound-HTTP invariant** that
  the entire 012/015/017 arc is built on, and mirrors 012's
  `connectorPullPostings` / `connectorAckOutcome` idiom. The genuine DP2→connector
  **push** alternative (DP2 making an outbound call to a connector-hosted endpoint)
  was **REJECTED** for 023: it would invert a signed constitutional invariant and
  would require its own decision record (connector callback URL registration,
  outbound HTTP egress posture, retry/backoff ownership, mTLS / signing) plus a
  separate spec. It is explicitly out of scope for 023. *No residual ambiguity —
  the contract's auth/path design (T006) is now unblocked to author under the
  connector-initiated model once the need (OQ-2) and the §VIII gate (T007) clear.*

(All clarifications are resolved — see Clarifications below.)

---

## Clarifications

### Session 2026-06-07

- **Q1 — Does 023 replace or complement the 012 pull feed?**
  **A:** Complement (additive, parallel, versioned). 015 is CLOSED and consumes
  012 as fixed; 018 names 023 as "if needed." A replacement would force an
  `operationId`/version break (§IV) and re-litigate a shipped surface.
  *Rationale: additive is the only constitution-safe reading; the roadmap frames
  023 as an option, not a migration.* (Resolved into §0, §3, FR-013, US3.)

- **Q2 — Where does the command work-item payload come from, and what shape?**
  **A:** It mirrors the 012 `PostingWorkItem` / `Sale` / `SaleLine` verbatim (the
  008 sale projection with DP2-resolved `erpnextItemRef`, provenance,
  `businessDate`, `kind`, optional `reversalOf`). *Rationale: a connector should
  post identically regardless of transport; reusing the 012 shapes guarantees that
  and avoids a divergent dialect.* (Resolved into FR-002, FR-003, Key Entities.)

- **Q3 — How is the command outcome reported, and is it idempotent?**
  **A:** Via the same outcome vocabulary as 012's `connectorAckOutcome` —
  `posted`/`failed_transient`/`permanently_rejected`, REQUIRED `Idempotency-Key`,
  200-replay / 201-fresh / 409-conflict, duplicate `posted` echoes the existing
  `documentRef`. *Rationale: §XI + O-2/O-3 are non-negotiable; reusing the existing
  interceptor avoids a new primitive.* (Resolved into FR-004, FR-005, US2.)

- **Q4 — Does the command exchange ever introduce new posting-status / DLQ
  schema, or mutate the sale fact?**
  **A:** No. It advances the existing 015 posting status and reuses the 017
  reconciliation/repair state; the immutable 008 sale fact is never mutated.
  *Rationale: §IX/§X immutable facts + READ-NOT-MIRROR discipline; a new schema
  here would be a gated drift with no justification.* (Resolved into §4, FR-014,
  Non-Goals.)

- **Q5 — Does the command carry tender / Payment Entry?**
  **A:** No — the gate A.5 deferral holds (008 has no tender). `posTotal` is the
  sale total, not tender; a future tender extension is a versioned, backward-
  compatible addition. *Rationale: re-introducing tender was not authorized and
  008 cannot supply it.* (Resolved into FR-016, US3 scenario 3, Assumptions.)

- **Q6 — (OQ-1, owner decision) Connector-initiated command vs genuine
  DP2→connector push?**
  **A:** **Connector-initiated command.** The connector remains the HTTP client;
  DP2 stays the server. Genuine push is REJECTED for 023. *Rationale: owner ruling
  2026-06-07 — preserves the §IX no-outbound-HTTP invariant the 012/015/017 arc
  depends on; genuine push would invert a signed constitutional invariant and
  needs its own decision record + spec, not this contract.* (Resolved into §10
  OQ-1, §2, §4, FR-006, Assumptions; clears analysis finding F-01.)

---

## Constitution Check (spec-level)

| Principle | Touch | Posture |
|---|---|---|
| §II Multi-tenant / fail-closed / non-disclosure | Yes | Scope from principal; cross-tenant ref → non-disclosing `not_found`. PASS |
| §III Backend authority / money | Yes | Backend records outcome; exact-decimal string money, no float. PASS |
| §IV Contract-first / additive versioning / no raw DB | Yes | New `operationId`s, new path segment, wire projections, conformance test; 012 untouched. PASS |
| §IX Source-of-truth / immutable facts | Yes | Sale fact never mutated; only posting status advances. PASS |
| §X Retail temporal | Yes | `businessDate` drives ERPNext posting_date; reversals are new docs. PASS |
| §XI Idempotency | Yes | REQUIRED `Idempotency-Key`, replay/conflict semantics reused. PASS |
| §XII Object safety | Yes | Body scope rejected; strict bodies; default-deny auth. PASS |
| §VIII Gated surfaces | Yes (deferred) | The contract YAML is `[GATED]`; this spec only describes it. PASS |
| §XIV PII | Yes | No PII beyond the already-exposed 012 sale projection; single region. PASS |

No principle is violated by this planning spec. The one decision that could
touch §IX (genuine DP2→connector push) was RESOLVED by the owner on 2026-06-07
in favour of the **connector-initiated command** model (OQ-1 / Clarifications
Q6) — genuine push is rejected for 023, so the §IX no-outbound-HTTP invariant is
preserved with no residual risk.
