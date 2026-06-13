# Implementation Plan: Surface Provider-Neutral `user_id` on the POS-Facing Operator Response

**Branch**: `feat/033-pos-facing-user-id-surface` | **Date**: 2026-06-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/033-pos-facing-user-id-surface/spec.md`

**Gate posture**: Owner cleared the Materialize Stop Gate 2026-06-13. **G10 re-verified at plan-start** against `origin/main` (see §G10 below). This plan is **docs-only** — it authors no code, contract YAML, or migration. The implementation dispatch (executing `tasks.md`) remains a separate step, still subject to the standing gates at execution.

---

## Summary

The POS-facing operator-identity block (`PosOperatorSummary`) today carries only the provider-coupled `id` (= `users.clerk_user_id`). This feature adds a single readable, additive field — `user_id` (= `users.id`, the 028 §16 provider-neutral identity key) — alongside the retained `id` bridge, on every `signed_in` response. The value is already loaded on the user row at every response-build site; the change is a field addition, not a new resolution path. It unblocks POS-017 (offline-PIN re-anchor), which needs a provider-independent key to anchor its local store.

**Technical approach**: extend the `PosOperatorSummaryBody` DTO with one optional-at-type/required-at-runtime `user_id: string` field; populate it from `userRow.id` at the three response-build sites that currently emit `id: userRow.clerk_user_id ?? ""`; extend the `pos-operators.openapi.yaml` `PosOperatorSummary` schema with the additive `user_id` property. No migration, no envelope change, no resolution-path change.

---

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20 LTS

**Primary Dependencies**: NestJS 11 (api), Zod (runtime validation), Drizzle (the user row read — unchanged)

**Storage**: PostgreSQL 16 — **no schema change**. `users.id` already exists and is already SELECTed by `findUserByClerkSubject`.

**Testing**: Jest + Supertest (api). Existing `pos-operators` suites extended; no Testcontainers/DB change required for the field assertion (the value is already on the loaded row).

**Target Platform**: Linux server (api service); consumer is the POS-Pulse terminal (separate repo) via the pinned OpenAPI contract.

**Project Type**: web-service (NestJS api) + contract package.

**Performance Goals**: N/A — no new query, no new I/O. The field is read off a row already in memory.

**Constraints**: additive + backward-compatible (FR-033-4, SC-033-3); `user_id` MUST NOT enter the opaque envelope (FR-033-5); no migration (FR-033-6, SC-033-4).

**Scale/Scope**: one DTO field, three service emit-sites, one OpenAPI schema property. Bounded, ~10–20 LOC of production change + tests.

---

## Constitution Check

*GATE: Must pass before Phase 0. Re-checked after design (no change — design is a field addition).*

| Principle | Relevance | Verdict |
|-----------|-----------|---------|
| §II Multi-tenant RLS | No new query; the existing read is already tenant-scoped. | PASS — untouched. |
| §III Backend authority | The value is derived server-side from the authoritative `users` row; the client receives, never sets, `user_id`. | PASS. |
| §IV Contract-first | The OpenAPI schema is extended *before/with* the runtime change; POS-017 is the cross-side consumer. | PASS — G2 additive extension. |
| §VIII Reproducible releases (`[GATED]`) | The contract YAML (`packages/contracts/openapi/**`) is a forbidden/gated path. The runtime DTO + service are not. | Gated — see Gate posture; contract edit is `[GATED]` at execution, not authored here. |
| §IX Authority boundaries (read-not-mutate) | Surfaces an existing value; does not mint, does not change the `clerk_user_id` join key (029) or envelope (031). | PASS — no authority handover. |
| §XII Object safety | One additive field on an existing response object; no mass-assignment, no inbound field. | PASS — outbound-only. |
| §XIV PII discipline | `user_id` is an internal UUID, already used server-side for audit/ownership. Not a secret, not new PII, not a credential. | PASS — identity data, BUSINESS-class at most. |
| §G10 Identity & Access Boundary | Re-verified at plan-start (§G10 below). | CONSUMED — PASS. |

**No violations.** Complexity Tracking table omitted (nothing to justify).

---

## G10 re-verify (performed at plan-start, against `origin/main` `a5158be`)

The spec claims G10 is CONSUMED. Re-verified against the actual code, not the spec's own assertions:

- **E-1 confirmed** — `apps/api/src/pos-operators/dto.ts` `PosOperatorSummaryBody`: `id` is documented "`users.clerk_user_id` (Clerk subject), NOT `users.id` (ADR D4)". Fields are `{ id, display_name, role, tenant_id, branch_id }`. **No `user_id` exists today.**
- **E-3 confirmed** — `apps/api/src/pos-operators/pos-operators.service.ts`: `findUserByClerkSubject` (≈L625) returns the user row; `userRow.id` is already consumed for `userId` (L378, L531), audit `actor_user_id` (L544/L547), and the ownership check (L711). The three `signed_in` response-build sites emit `id: userRow.clerk_user_id ?? ""` at **L385** (sign-in success), **L498** (manager/admin path), **L568** (takeover-confirm, incl. idempotent replay) — each with `userRow.id` in scope.
- **E-4 confirmed** — `dto.ts` `envelope: string | null` is the opaque bearer; it is nullable on idempotent replay. `user_id` must therefore live on the always-present operator block, not the session block (matches the spec's Clarification Q2).
- **Boundary verdict**: `user_id` is **identity data** (the §16 neutral key), not a credential and not a scope-bearing token. Surfacing it on a response the operator already receives introduces no scope-interchange and respects producer-exclusion (028 owns the boundary; this consumes it). **G10 CONSUMED — re-verify holds.** To be re-confirmed once more at the implementation dispatch per standing gate discipline.

---

## Carried Open Questions — resolved to plan-level decisions

The spec deferred two OQs to plan-phase. Resolved here:

### OQ-033-1 — field nullability under non-`signed_in` paths → **DECISION: `user_id` lives only on `PosOperatorSummary`, which is built only on `signed_in`; non-`signed_in` responses do not carry an operator block, so the question is vacuous.**

Verified against the response union: `user_id` is a property of the operator-identity block. That block is emitted only on the `kind: "signed_in"` branch (L382–L391 and the two sibling sites). Error/`needs_takeover`/refusal responses do not contain a `PosOperatorSummary` at all, so there is no path on which `user_id` would be present-but-null. **At runtime `user_id` is always a well-formed UUID when present.** No null-handling rule is needed.

### OQ-033-2 — contract field requiredness (`required` vs optional rollout window) → **DECISION: `user_id` is `required` in the `PosOperatorSummary` OpenAPI schema; the schema bump ships as a coordinated pair with the POS-Pulse contract-pin update.**

Rationale (requiredness): the server can *always* populate it (it is `users.id`, the table PK, present on every loaded row — independent of the 029 `external_identity_links` backfill, and non-null per `UserLookupRow.id: string`). Marking it `required` is the contract-honest choice: the producer guarantees it on every operator block it emits. (Had the value been backfill-dependent, optional-during-rollout would be correct — it is not.)

**Rollout-ordering hazard — present, dispositioned (analyze/review finding).** The earlier draft of this decision claimed "no rollout-ordering hazard." That was wrong: the `PosOperatorSummary` schema declares `additionalProperties: false` (contract L410; the contract comments note strictness is enforced on both sides). Consequences:

- For a **lenient** consumer (ignores unknown fields), `user_id` is purely additive — no coordination needed.
- For a **strict** consumer that validates against the *old pinned schema*, a response carrying `user_id` is rejected as a disallowed property — independent of whether the client reads it.

Therefore the safe sequence is a **coordinated pin pair**, not a one-sided producer change: the DP-2 schema bump (T1) and the POS-Pulse pinned-contract update land together (or POS-Pulse relaxes to lenient parsing first). This is a *minor coordinated release*, not a code-behavior break and not a blocker — but it must be sequenced, so it is scoped into T1 (contract task notes the pairing) and characterized by T4 (a test that validates against the real old schema, not a hand-rolled lenient pick). The cross-side requirement is exactly the kind G2 expects to surface. **Open input for the implementation dispatch:** confirm POS-Pulse's response-validation mode (strict vs lenient) — this determines whether the pin update is mandatory or merely tidy.

> Both decisions are recorded for the implementation dispatch; neither expands scope beyond the spec's FRs.

---

## Project Structure

### Documentation (this feature)

```text
specs/033-pos-facing-user-id-surface/
├── spec.md              # SPECIFY (merged via PR #564); Status updated to PLANNING
├── plan.md              # This file
├── tasks.md             # /speckit-tasks output
└── checklists/
    └── requirements.md  # /speckit-analyze input (spec-quality checklist)
```

No `research.md` / `data-model.md` / `quickstart.md` / `contracts/` scaffolding: there is nothing to research (the approach is fully determined by E-1..E-5), no data model beyond one existing field, and the contract change is a single additive property on an existing schema (described inline in tasks, authored `[GATED]` at execution).

### Source Code (repository root) — *touched by the future implementation dispatch, not by this plan*

```text
apps/api/src/pos-operators/
├── dto.ts                      # ADD: user_id: string to PosOperatorSummaryBody (+ JSDoc: = users.id, §16 neutral key)
└── pos-operators.service.ts    # ADD: user_id: userRow.id at the 3 signed_in emit-sites (L385, L498, L568)

apps/api/test/pos-operators/    # EXTEND: assert user_id == users.id (≠ clerk_user_id) on all 4 signed_in paths
                                #         + additive/backward-compat deserialization test (US2)

packages/contracts/openapi/
└── pos-operators.openapi.yaml  # [GATED] ADD: user_id (required, format: uuid) to the PosOperatorSummary schema
```

**Structure Decision**: No new files, no new module. The feature is a field addition within the existing `pos-operators` slice and its pinned contract. The only gated path is the OpenAPI YAML (§VIII); the DTO/service/test changes are ordinary api changes.

---

## Phase plan (for `/speckit-tasks` to expand)

1. **Contract** `[GATED]` — extend `PosOperatorSummary` schema with `user_id` (required, uuid). Authored only under the gated-path approval at execution.
2. **DTO** — add `user_id: string` to `PosOperatorSummaryBody` with JSDoc pointing to `users.id` / §16.
3. **Service** — populate `user_id: userRow.id` at the three `signed_in` emit-sites. RED-first: extend tests to expect `user_id`, watch them fail, then add the field.
4. **Tests** — the four-path assertion (sign-in / admin / takeover-fresh / takeover-replay) that `user_id == users.id` and `≠ clerk_user_id`; the US2 backward-compat deserialization assertion; the negative assertion that `user_id` never appears inside the `envelope` string.
5. **Verify** — `pnpm -r run build` (tsc) + the `pos-operators` jest suite green; confirm no migration, no envelope diff, no resolution-path diff (SC-033-4).

---

## Complexity Tracking

> Not applicable — Constitution Check has no violations. No table.
