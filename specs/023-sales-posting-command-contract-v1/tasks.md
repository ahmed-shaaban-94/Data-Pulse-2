---
description: "Task list for 023 sales-posting command contract v1"
---

# Tasks: Sales-Posting Command Contract v1

**Input**: Design documents from `specs/023-sales-posting-command-contract-v1/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Constitution**: v3.0.1

**Tests**: Contract conformance tests are REQUIRED (§IV, §VI) — written RED before
the YAML is authored GREEN.

**Organization**: Tasks are grouped by user story. **This planning chain produces
only planning artifacts.** Tasks that touch the `[GATED]`
`packages/contracts/openapi/**` surface (and the conformance test) are flagged
`[GATED]` and are **NOT executed in this no-implement pass** — they document the
future implementation slice that runs after the need + OQ-1 are resolved and
explicit `[GATED]` approval is recorded.

> **Hard blocker — DO NOT author the YAML or any `packages/**` file in this pass.**
> Every `[GATED]` task below is a *description of future work*, not an instruction
> to execute now.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 / FND (foundational) / POL (polish)
- **[GATED]**: Touches a forbidden surface — requires explicit approval; not run now.

---

## Phase 1: Setup / Planning (this chain)

- [X] T001 [FND] Create the spec dir + branch via `create-new-feature.ps1` (done).
- [X] T002 [FND] Author `spec.md` (clarified; 5 auto-resolved; OQ-1 escalated to
  owner and RESOLVED 2026-06-07 → connector-initiated).
- [X] T003 [FND] Author `plan.md` (Constitution Check PASS), `research.md`, `data-model.md`.
- [X] T004 [FND] Author `tasks.md` (this file) + `analysis.md` + `review.md`.

**Checkpoint**: planning artifact set complete; no code, no gated surface touched.

---

## Phase 2: Foundational (blocking prerequisites — gates on human decisions, NOT this chain)

**⚠️ CRITICAL**: No `[GATED]` contract task may begin until ALL of these clear.

- [ ] T005 [FND] **Confirm the concrete need** for a command transport (low-latency
  single posting / operator "post now" repair / cursor-less connector runtime).
  If no need, 023 stays planning-only (Assumptions, OQ-1 note). *Owner gate.*
- [X] T006 [FND] **Resolve OQ-1** (genuine DP2→connector push vs connector-initiated
  command). **RESOLVED 2026-06-07 by owner: connector-initiated; genuine push
  REJECTED for 023** (preserves §IX; push would need its own decision record +
  separate spec). The contract slice's auth/path design is now UNBLOCKED under the
  connector-initiated model. *(spec §10 OQ-1 / Clarifications Q6 / research D-1.)*
- [ ] T007 [FND] Record explicit `[GATED]` approval to author the new contract YAML
  under `packages/contracts/openapi/erpnext-connector/` (§VIII). *Owner gate.*

**Checkpoint**: need confirmed (T005) + ~~OQ-1 resolved~~ (T006 ✅ done
2026-06-07) + gated approval recorded (T007) → the contract slice may run. Only
T005 (need confirmation) and T007 (§VIII gate) remain open.

---

## Phase 3: User Story 1 — Connector executes a single sale-posting command (P1) 🎯 MVP

**Goal**: A connector fetches one specific work-item by reference and receives the
full 008 posting payload (sale projection + resolved item identity + provenance +
businessDate), scope-bound to its principal.

**Independent Test**: The conformance spec asserts the command operation exists,
requires `connectorBearer`, takes a `workItemRef`, returns a `PostingWorkItem`,
and refuses cross-tenant refs non-disclosingly.

### Tests for US1 (RED first) ⚠️ [GATED — not run in this pass]

- [ ] T008 [GATED] [US1] Add a RED structural conformance test
  `apps/api/test/erpnext-connector/contract/posting-command.contract.spec.ts`
  asserting: `connectorExecutePostingCommand` exists with a stable distinct
  `operationId` under `/api/connector/v1/erpnext/commands/{workItemRef}`, secured by
  `connectorBearer`, returning `PostingWorkItem`; loaded via the non-recursive
  `loadOpenApiContracts` with an explicit `dir` (mirror `posting-feed.contract.spec.ts`).

### Implementation for US1 [GATED — not run in this pass]

- [ ] T009 [GATED] [US1] Author the command-fetch operation in the new
  `packages/contracts/openapi/erpnext-connector/posting-command.yaml`:
  path/`operationId`/`connectorBearer` security/`PostingWorkItem` response
  (copy `PostingWorkItem`/`Sale`/`SaleLine`/`ReversalRef` verbatim from 012, omit
  `itemCursor`). Turn T008 GREEN.
- [ ] T010 [GATED] [US1] Add the non-disclosing `NotFound` (404) response + the
  `WorkItemRef` path param (scope-bound, uuid) + `validation_failure` for
  body/query-supplied scope (§XII). Assert in T008.
- [ ] T011 [GATED] [US1] Copy the shared value schemas verbatim from 012:
  `DecimalAmount`, `CurrencyCode`, `ErpnextItemRef`, `ErpnextDocumentRef`, `Error`.
  Assert money fields are strings (no float) + currency-paired (SC-005).

**Checkpoint**: US1 demonstrable against the conformance harness.

---

## Phase 4: User Story 2 — Connector reports the command outcome idempotently (P1)

**Goal**: The connector reports `posted`/`failed_transient`/`permanently_rejected`
for a command; idempotent via REQUIRED `Idempotency-Key`; reuses 015/017 state.

**Independent Test**: Conformance asserts the ack operation requires
`Idempotency-Key`, documents 200/201/409, conditional `documentRef`/`reason`, and
reuses `OutcomeAckRequest`/`RecordedOutcome`.

### Tests for US2 (RED first) ⚠️ [GATED — not run in this pass]

- [ ] T012 [GATED] [US2] Extend the conformance spec: `connectorAckPostingCommand`
  exists at `…/commands/{workItemRef}/outcome`, `x-idempotency: required`,
  `Idempotency-Key` header REQUIRED, responses 200 (replay, `Idempotent-Replayed`)
  / 201 (fresh) / 409 (`idempotency_key_conflict`), with the conditional-field
  validation (`documentRef` on `posted`, `reason` on `permanently_rejected`). RED.

### Implementation for US2 [GATED — not run in this pass]

- [ ] T013 [GATED] [US2] Author the ack operation in `posting-command.yaml`:
  copy `OutcomeAckRequest`/`RecordedOutcome`/`RejectionReason`/`EtaStatus` verbatim
  from 012; reuse the existing `IdempotencyInterceptor` semantics in the contract
  description; closed `error.code` set (NO `snapshot_required`). Turn T012 GREEN.
- [ ] T014 [GATED] [US2] Add the `Conflict` (409 `idempotency_key_conflict`) +
  `IdempotentReplayed` header + the 200-vs-201 replay/fresh split, mirroring 012.
- [ ] T015 [GATED] [US2] Document (in the YAML description + data-model) that the
  ack advances ONLY the 015 posting status and reuses the 017 DLQ/reconciliation
  state — the 008 sale fact is never mutated (FR-014). No new schema/migration.

**Checkpoint**: US1 + US2 both demonstrable; the full command exchange is contracted.

---

## Phase 5: User Story 3 — Additive & version-isolated (P2)

**Goal**: 023 provably never touches/renames/breaks the 012 feed and names no
ERPNext doctype field (O-6).

**Independent Test**: Conformance asserts zero diff to `posting-feed.yaml`, zero
`operationId` collision, and no ERPNext-doctype field names in 023 schemas.

### Tests for US3 (RED first) ⚠️ [GATED — not run in this pass]

- [ ] T016 [GATED] [US3] Add a conformance assertion that 023 `operationId`s are
  distinct from all 012 `operationId`s and that `posting-feed.yaml` is unchanged
  (no edit in the 023 slice). RED until the additive YAML lands.
- [ ] T017 [GATED] [US3] Add a schema-scan assertion: no 023 schema field name
  references an ERPNext doctype field; documents addressed only by `doctype`+`name`
  (O-6, SC-006). RED.

### Implementation for US3 [GATED — not run in this pass]

- [ ] T018 [GATED] [US3] Finalise `posting-command.yaml` `info`/`tags`/`servers`
  + a header description stating: additive to 012, command transport,
  no-outbound-HTTP preserved, Payment Entry deferred (gate A.5). Turn T016/T017
  GREEN. Confirm `posting-feed.yaml` byte-unchanged.

**Checkpoint**: all three stories demonstrable; the command contract coexists with
the feed.

---

## Phase 6: Polish & cross-cutting [GATED — not run in this pass]

- [ ] T019 [GATED] [POL] Full `erpnext-connector` contract suite green (012 + 023
  conformance specs) in CI.
- [ ] T020 [POL] Update the spec's `wave-status.md` (if created) + this repo's
  `CLAUDE.md` arc note to mark 023 contract SHIPPED (docs-only edit, not gated).
- [ ] T021 [POL] Record forward notes: any future Payment Entry / tender extension
  is a versioned additive change; a command-posting metric (if added by an
  implementation slice) registers in the shared `api.metrics.ts`.

---

## Dependencies & Execution Order

- **Phase 1 (planning)**: done in this chain.
- **Phase 2 (foundational gates T005–T007)**: human/owner decisions —
  **block every `[GATED]` task**. OQ-1 (T006) is CLEARED (connector-initiated,
  2026-06-07); the need (T005) + gated approval (T007) MUST still clear first.
- **Phase 3 (US1)**: after Phase 2; the MVP — fetch + payload.
- **Phase 4 (US2)**: after Phase 2; co-MVP — outcome ack. Independent of US1's YAML
  edits in principle but shares one file (`posting-command.yaml`), so US1→US2 is
  sequential within that file.
- **Phase 5 (US3)**: after the YAML exists (US1/US2) — additive/version assertions.
- **Phase 6 (polish)**: after all stories.

### Within each user story

- Conformance test RED before the YAML turns it GREEN (§VI).
- One concern per task; shared file (`posting-command.yaml`) edits are sequential.

### Parallel opportunities

- T005 and the *drafting* of T008/T012/T016 conformance assertions could be drafted
  in parallel, but **all execution is blocked** behind Phase 2 gates in this pass.
- Within the single contract file, tasks are mostly sequential (same file).

---

## Notes

- **No `[GATED]` task runs in this no-implement pass.** They describe the future
  implementation slice.
- The eventual contract YAML is the ONLY gated artifact; there is **no DB
  schema/migration** in 023 (state reused from 015/017).
- OQ-1 was an owner decision; **RESOLVED 2026-06-07 toward connector-initiated**,
  so this spec proceeds under the §IX-preserving model. (Had it gone to genuine
  push, a separate decision record + spec + new `[GATED]` slices — callback
  registration, egress posture — would have been required; that path is rejected
  and out of scope.)
