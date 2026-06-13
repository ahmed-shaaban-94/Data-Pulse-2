# Tasks: Surface Provider-Neutral `user_id` on the POS-Facing Operator Response

**Feature**: `033-pos-facing-user-id-surface` | **Branch**: `feat/033-pos-facing-user-id-surface` | **Date**: 2026-06-13

**Input**: [spec.md](spec.md) · [plan.md](plan.md)

**Status**: PLAN/TASKS authored under owner-cleared Materialize Stop Gate (2026-06-13). **No code, contract YAML, or migration is authored by this document.** Execution of T1–T6 is the separate implementation dispatch and is subject to the standing gates (esp. the `[GATED]` contract path in T1).

**Scope reminder**: one additive response field. Estimated production change ≈ 10–20 LOC + tests. No migration (FR-033-6), no envelope change (FR-033-5), no resolution-path change.

---

## Conventions

- **[GATED]** — touches a forbidden path (`packages/contracts/openapi/**`); requires explicit gated-path approval at execution time.
- **[P]** — parallelizable with sibling [P] tasks (different files, no shared edit surface).
- **RED-first** — write/extend the failing test before the production edit (per repo TDD discipline).
- Each task lists the **FR/SC** it satisfies and its **exact edit surface** (file + anchor) so a fresh agent can execute it cold.

---

## Dependency order

```
T0 (setup/branch) ──▶ T2 (DTO) ──▶ T3 (service emit) ──▶ T4 (tests, RED→GREEN) ──▶ T5 (verify) ──▶ T6 (closeout)
                  └─▶ T1 [GATED] (contract) ───────────────────────────────────────────┘
                       (T1 independent of T2/T3; both must land before T5 verify)
```

T1 (contract) and T2→T3 (runtime) are independent and may proceed in parallel; T4 tests depend on T2/T3; T5 verify depends on T1+T4.

---

## Tasks

### T0 — Setup & guardrails *(no gated path)*

- **Do**: Confirm working tree is on the 033 planning branch off `origin/main`; confirm `apps/api/src/pos-operators/{dto.ts,pos-operators.service.ts}` and `packages/contracts/openapi/pos-operators.openapi.yaml` match the plan's anchors (L385/L498/L568 emit-sites; `PosOperatorSummaryBody`; `PosOperatorSummary` schema). Re-confirm **G10** once more (plan §G10) and that **no migration** is implied.
- **Satisfies**: pre-flight for SC-033-4 (no migration), G10 re-verify discipline.
- **Output**: a one-line confirmation in `wave-status.md`; no source change.

### T1 — Contract: add `user_id` to `PosOperatorSummary` schema · **[GATED]**

- **Edit surface**: `packages/contracts/openapi/pos-operators.openapi.yaml` → the `PosOperatorSummary` schema (≈L407, the response object whose runtime shape is `PosOperatorSummaryBody`).
- **Do**:
  1. Add property `user_id: { type: string, format: uuid, description: "Provider-neutral identity key = users.id (028 §16). Distinct from id (= clerk_user_id, v1 bridge)." }`.
  2. Add `user_id` to the schema's `required` list (plan OQ-033-2 decision).
  3. **Update the schema `description`** (≈L411–415) — it currently says the block "Carries only … id, display_name, role, tenant_id, and branch_id"; add `user_id` so the prose is not stale (review LOW finding).
  4. Leave `id`, `display_name`, `role`, `tenant_id`, `branch_id`, and `additionalProperties: false` unchanged.
- **Coordinated-pin note (analyze/review MEDIUM)**: `PosOperatorSummary` has `additionalProperties: false` (L410). A POS-Pulse consumer that validates **strictly** against the *old* pinned schema will reject a response carrying `user_id`. **This task is therefore a coordinated pair**: the DP-2 schema bump and the POS-Pulse contract-pin update must land together (unless POS-Pulse confirms lenient parsing). Confirm POS-Pulse's validation mode at dispatch; if strict, the implementation dispatch MUST include (or sequence ahead of itself) the POS-Pulse pin update. Do not ship the producer change ahead of a strict consumer's pin.
- **MUST NOT**: alter the envelope schema, any request body, any other operationId, or relax `additionalProperties`. Additive property only.
- **Satisfies**: FR-033-1, FR-033-5 (sibling field, not envelope), G2 (additive contract extension + cross-side coordination surfaced), SC-033-3 (application-additive; strict-consumer caveat handled by the pin pair).
- **Verify**: contract still lints/parses; `user_id` is the only added property; existing fields/requiredness unchanged; `additionalProperties` unchanged; description mentions `user_id`.

### T2 — DTO: add `user_id` to `PosOperatorSummaryBody` *(depends: T0)*

- **Edit surface**: `apps/api/src/pos-operators/dto.ts` → `PosOperatorSummaryBody` (the `id`/`display_name`/`role`/`tenant_id`/`branch_id` block, ≈L49–56).
- **Do**: Add `user_id: string;` with JSDoc: `/** Provider-neutral identity key = users.id (028 §16). Distinct from id (= users.clerk_user_id, v1 bridge, ADR D4). */`. Place it adjacent to `id` so the bridge↔neutral pairing reads clearly.
- **MUST NOT**: change `id`'s meaning or type; add any inbound/request field; touch `PosOperatorSessionSummaryBody.envelope`.
- **Satisfies**: FR-033-1, FR-033-4 (bridge retained), §XII (outbound-only field).
- **Verify**: `tsc` compiles; the field is required-on-type (matches T1 `required`).

### T3 — Service: populate `user_id` at the three `signed_in` emit-sites *(depends: T2)*

- **Edit surface**: `apps/api/src/pos-operators/pos-operators.service.ts` → the three operator-block literals currently `id: userRow.clerk_user_id ?? ""` at **L385** (sign-in success), **L498** (manager/admin path), **L568** (takeover-confirm incl. idempotent replay).
- **Do**: At each site add `user_id: userRow.id,` alongside the existing `id:`. `userRow.id` is already in scope at all three (E-3).
- **MUST NOT**: introduce a new query or resolution path (FR-033-2); change `userId`/`actor_user_id`/ownership usages of `userRow.id`; emit `user_id` on any non-`signed_in` branch (there is no operator block there — plan OQ-033-1).
- **Satisfies**: FR-033-1, FR-033-2 (no new resolution), FR-033-3 (present on all signed_in paths incl. replay), SC-033-1, SC-033-2.
- **Verify**: all three literals carry `user_id: userRow.id`; no fourth site introduced; no DB call added.

### T4 — Tests: four-path identity assertion + backward-compat + envelope-isolation *(depends: T3; RED-first)*

- **Edit surface**: `apps/api/test/pos-operators/**` (extend the existing operator sign-in / takeover suites).
- **Do** (RED → GREEN — write expectations first, confirm they fail against pre-T3 code, then they pass):
  1. **US1 / SC-033-1, SC-033-2** — seed an operator with known `users.id` U and `clerk_user_id` C; assert on each of the four `signed_in` paths the operator block has `user_id === U` (well-formed UUID) and `id === C`: (a) sign-in success, (b) manager/admin path, (c) takeover-confirm fresh, (d) takeover-confirm **idempotent replay** (envelope null) — `user_id` STILL present and non-null.
  2. **US2 / SC-033-3** — backward-compat must be tested against the *real* compatibility boundary, not a hand-rolled lenient pick (review MEDIUM):
     - **Lenient leg**: deserialize the response with a consumer that reads only `id`, `display_name`, `role`, `tenant_id`, `branch_id`; assert it parses and ignores `user_id` (no break).
     - **Strict leg (characterization)**: validate the new response against the *actual old `PosOperatorSummary` schema* (5 required fields, `additionalProperties: false`) and assert it **rejects** `user_id` — documenting the strict-mode boundary that makes T1 a coordinated pin pair. This leg's purpose is to prove the failure mode is understood and bounded, not to pass silently; it must exercise the real `additionalProperties: false` constraint.
  3. **FR-033-5 negative** — assert `user_id` does NOT appear inside the `envelope` string (the opaque bearer bytes are unchanged); assert `user_id` is a sibling of `id`, not nested in the session block.
- **MUST NOT**: assert anything about a migration or DB shape (there is none); add Testcontainers/DB dependency for the field check (value is on the already-loaded row).
- **Satisfies**: SC-033-1, SC-033-2, SC-033-3, SC-033-5 (delivery proven); FR-033-3, FR-033-5.
- **Verify**: the four-path + backward-compat + envelope-isolation cases pass; the rest of the `pos-operators` suite stays green.

### T5 — Verify (build + suite + invariants) *(depends: T1, T4)*

- **Do**: `pnpm -r run build` (tsc across the workspace) clean; the `pos-operators` jest suite green; confirm the three SC-033-4 invariants by inspection of the diff — **no migration file added**, **no envelope-content change**, **no resolution-path change** (no new query in `findUserByClerkSubject` or callers).
- **Satisfies**: SC-033-4; overall gate that FR-033-1..6 hold together.
- **Verify**: paste build + test output (not a summary) into `wave-status.md`; record the diffstat showing only `dto.ts`, `pos-operators.service.ts`, the test file, and the `[GATED]` YAML changed.

### T6 — Closeout

- **Do**: Update `spec.md` Status → IMPLEMENTED (or keep PLANNING and hand the dispatch to the Orchestrator DP-033 queue, per how the owner sequences it); update `wave-status.md` with final state; note POS-017 is now UNBLOCKED (SC-033-5). Confirm CLAUDE.md / memory index entry if the owner wants the active-feature block updated.
- **Satisfies**: SC-033-5 (consumer dependency satisfied); reporting discipline.
- **Verify**: spec + wave-status reflect terminal state; no scope crept beyond FR-033-1..6.

---

## Traceability matrix

| FR / SC | Task(s) |
|---|---|
| FR-033-1 (field exists, = users.id) | T1, T2, T3 |
| FR-033-2 (no new resolution/query) | T3, T5 |
| FR-033-3 (present on all signed_in incl. replay) | T3, T4 |
| FR-033-4 (id bridge retained) | T2, T4 |
| FR-033-5 (not in envelope) | T1, T2, T4 |
| FR-033-6 (no migration/resolution/envelope change) | T0, T5 |
| SC-033-1 (user_id == users.id ≠ clerk_user_id) | T4 |
| SC-033-2 (non-null on all 4 paths) | T3, T4 |
| SC-033-3 (additive, backward-compatible) | T1, T4 |
| SC-033-4 (no migration / envelope / resolution change) | T5 |
| SC-033-5 (POS-017 delivery satisfied) | T4, T6 |

All eleven requirements are covered; no task lacks a requirement and no requirement lacks a task.
