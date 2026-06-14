# Tasks: Surface Provider-Neutral `user_id` on the POS Cashier Roster

**Feature**: `034-pos-roster-cashier-user-id` | **Branch**: `feat/034-roster-cashier-user-id` | **Date**: 2026-06-13

**Input**: [spec.md](spec.md) · [plan.md](plan.md)

**Status**: PLAN/TASKS authored docs-only. **No code, contract YAML, or migration is authored by this document.** Execution of T1–T6 is the separate implementation dispatch, subject to the standing gates (esp. the `[GATED]` contract path in T1).

**Scope reminder**: one additive roster field. Estimated production change ≈ 4–8 LOC + tests. No migration (FR-034-5), no membership change, no resolution-path change. Cashier-roster sibling of the shipped 033.

---

## Conventions

- **[GATED]** — touches a forbidden path (`packages/contracts/openapi/**`); requires explicit gated-path approval at execution.
- **[P]** — parallelizable with sibling [P] tasks (different files).
- **RED-first** — extend the failing test before the production edit (repo TDD discipline).
- Each task lists the **FR/SC** it satisfies and its **exact edit surface** (file + anchor).

---

## Dependency order

```
T0 (setup/branch) ──▶ T2 (DTO) ──▶ T3 (service map) ──▶ T4 (tests, RED→GREEN) ──▶ T5 (verify) ──▶ T6 (closeout)
                  └─▶ T1 [GATED] (contract) ─────────────────────────────────────────┘
                       (T1 independent of T2/T3; both must land before T5 verify)
```

---

## Tasks

### T0 — Setup & guardrails *(no gated path)*

- **Do**: Confirm the branch is off `origin/main` `88c8d3d`; confirm `apps/api/src/pos-operators/{dto.ts,pos-operators.service.ts}` and `packages/contracts/openapi/pos-operators.openapi.yaml` match the plan's anchors (`findCashiersByStore` ≈L798–832 with the `users` join @ ≈L809; `PosRosterCashierEntry` DTO ≈L138; `PosRosterCashierEntry` schema ≈L510). Re-confirm **G10** (plan §G10) and that **no migration** is implied.
- **Satisfies**: pre-flight for SC-034-4 (no migration), G10 re-verify discipline.
- **Output**: one-line confirmation in `wave-status.md`; no source change.

### T1 — Contract: add `user_id` to `PosRosterCashierEntry` schema · **[GATED]**

- **Edit surface**: `packages/contracts/openapi/pos-operators.openapi.yaml` → `PosRosterCashierEntry` (≈L510–537).
- **Do**:
  1. Add property `user_id: { type: string, format: uuid, description: "Provider-neutral identity key = users.id (028 §16). Distinct from id (= clerk_user_id, v1 bridge)." }`.
  2. Add `user_id` to the schema's `required` list (now `[id, user_id, display_name, role]`) — plan decision.
  3. **Update the schema `description`** if it enumerates the fields, so the prose isn't stale (it currently describes a minimum-disclosure `{ id, display_name, role }` record).
  4. Leave `id`, `display_name`, `role`, and `additionalProperties: false` unchanged.
- **Coordinated-pin note**: `PosRosterCashierEntry` has `additionalProperties: false`. A POS-Pulse consumer validating **strictly** against the *old* pinned schema would reject `user_id`. POS-Pulse's roster handler is a **lenient allowlist reader** (`roster-handler.ts` strips unknown fields) — so it is wire-safe today; it threads `user_id` only after widening its allowlist (POS-019 follow-up). Land this as the coordinated DP-2 half; POS widens its allowlist as the matching half. Do not assume strict-rejection breakage — confirmed lenient.
- **MUST NOT**: alter any other schema, request body, roster membership rule, or relax `additionalProperties`. Additive property only.
- **Satisfies**: FR-034-1, FR-034-6 (contract leg of the lockstep), G2 (additive extension + cross-side coordination surfaced), SC-034-3.
- **Verify**: contract lints/parses; `user_id` the only added property; existing fields unchanged; `additionalProperties` unchanged.

### T2 — DTO: add `user_id` to `PosRosterCashierEntry` *(depends: T0)*

- **Edit surface**: `apps/api/src/pos-operators/dto.ts` → `PosRosterCashierEntry` (≈L138, the `{ id, display_name, role }` block).
- **Do**: Add `user_id: string;` with JSDoc: `/** Provider-neutral identity key = users.id (028 §16). Distinct from id (= users.clerk_user_id, v1 bridge). */`. Place adjacent to `id`.
- **MUST NOT**: change `id`'s meaning/type; add any inbound/request field.
- **Satisfies**: FR-034-1, FR-034-4 (bridge retained), FR-034-6 (DTO leg), §XII (outbound-only).
- **Verify**: `tsc` compiles; field required-on-type (matches T1 `required`).

### T3 — Service: project + map `user_id` in `findCashiersByStore` *(depends: T2)*

- **Edit surface**: `apps/api/src/pos-operators/pos-operators.service.ts` → `findCashiersByStore` (≈L798–832): the SELECT list (`u.clerk_user_id, u.display_name`, ≈L806) and the row map (`{ id: row.clerk_user_id, display_name, role }`, ≈L827–831). The query type `{ clerk_user_id, display_name }` (≈L802–805) gains `id`.
- **Do**: Add `u.id` to the SELECT; add `id: string` to the row result type; add `user_id: row.id` to the mapped object. `u.id` is already the JOIN key (≈L809) — no new join, no new query.
- **MUST NOT**: change the `store_staff` role filter, store-access scoping, ordering, or any membership rule (FR-034-5); add a new query or `external_identity_links` lookup (FR-034-2).
- **Satisfies**: FR-034-1, FR-034-2 (no new resolution), FR-034-3 (every entry), FR-034-6 (service leg), SC-034-1, SC-034-2.
- **Verify**: the SELECT carries `u.id`; the map carries `user_id: row.id`; no membership/scope clause changed; no new query added.

### T4 — Tests: roster identity assertion + backward-compat *(depends: T3; RED-first)*

- **Edit surface**: `apps/api/test/pos-operators/**` (extend the existing Wave-3 roster suite).
- **Do** (RED → GREEN):
  1. **US1 / SC-034-1, SC-034-2** — seed cashiers in a store with known `users.id`/`clerk_user_id` pairs; fetch the roster; assert each entry has `user_id === users.id` (well-formed UUID) and `id === clerk_user_id`, and that a multi-cashier roster has a non-null `user_id` on every entry.
  2. **US2 / SC-034-3** — backward-compat against the real boundary:
     - **Lenient leg**: a consumer reading only `{ id, display_name, role }` parses and ignores `user_id`.
     - **Strict leg (characterization)**: validate the new entry against the *old* `PosRosterCashierEntry` schema (`additionalProperties: false`) and assert it rejects `user_id` — documenting why T1 + the POS allowlist-widening are a coordinated pair.
  3. **Membership-unchanged** — assert the roster's included-cashier set is identical pre/post (this feature only adds a field, not members).
- **MUST NOT**: assert any migration/DB-shape change (there is none beyond the projected column).
- **Satisfies**: SC-034-1, SC-034-2, SC-034-3, SC-034-5 (delivery proven); FR-034-3.
- **Verify**: identity + backward-compat + membership cases pass; the rest of the `pos-operators` suite stays green.

### T5 — Verify (build + suite + invariants) *(depends: T1, T4)*

- **Do**: api build (tsc) clean; the `pos-operators` roster jest suite green; confirm the SC-034-4 invariants by diff inspection — **no migration file**, **no membership-rule change**, **no resolution-path change** (no new query). Diffstat should show only `dto.ts`, `pos-operators.service.ts`, the test file, and the `[GATED]` YAML.
- **Satisfies**: SC-034-4; overall gate that FR-034-1..6 hold together.
- **Verify**: paste build + test output into `wave-status.md`; record the diffstat.

### T6 — Closeout

- **Do**: Update `spec.md` Status → IMPLEMENTED (or hand the dispatch to the Orchestrator queue per owner sequencing); update `wave-status.md`. Note POS-019's `not_ready` provisioning is now satisfiable once POS widens its roster allowlist, and POS-017 Step 1 is done (SC-034-5). File the cross-repo note back to POS-Pulse (the OUTBOX answer).
- **Satisfies**: SC-034-5 (consumer dependency satisfied); reporting discipline.
- **Verify**: spec + wave-status reflect terminal state; no scope crept beyond FR-034-1..6.

---

## Traceability matrix

| FR / SC | Task(s) |
|---|---|
| FR-034-1 (field exists, = users.id) | T1, T2, T3 |
| FR-034-2 (no new resolution/query) | T3, T5 |
| FR-034-3 (present on every entry) | T3, T4 |
| FR-034-4 (id bridge retained) | T2, T4 |
| FR-034-5 (no migration / membership change) | T0, T3, T5 |
| FR-034-6 (lockstep contract+DTO+mapper) | T1, T2, T3 |
| SC-034-1 (user_id == users.id ≠ clerk_user_id) | T4 |
| SC-034-2 (non-null every entry) | T3, T4 |
| SC-034-3 (additive, backward-compatible) | T1, T4 |
| SC-034-4 (no migration / membership / resolution change) | T5 |
| SC-034-5 (POS-019/017 delivery satisfied) | T4, T6 |

All eleven requirements are covered; no task lacks a requirement and no requirement lacks a task.
