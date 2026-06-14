# Implementation Plan: Surface Provider-Neutral `user_id` on the POS Cashier Roster

**Branch**: `feat/034-roster-cashier-user-id` | **Date**: 2026-06-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/034-pos-roster-cashier-user-id/spec.md`

**Gate posture**: This plan is **docs-only** — it authors no code, contract YAML, or migration. **G10 re-verified at plan-start** against `origin/main` `88c8d3d` (see §G10). The implementation dispatch (executing `tasks.md`) remains a separate step under the standing gates.

---

## Summary

The POS cashier roster entry (`PosRosterCashierEntry`) today carries only the provider-coupled `id` (= `users.clerk_user_id`). This feature adds a single readable, additive field — `user_id` (= `users.id`, the 028 §16 provider-neutral identity key) — alongside the retained `id` bridge, on every roster entry. The value is already loaded via the `users` join at the roster build site; the change is a field addition, not a new resolution path. It satisfies POS-019's cashier-`user_id`-delivery dependency (born-neutral provisioning; already merged and refusing `not_ready` until this lands) and is Step 1 of POS-017's unblock sequence.

**Technical approach**: extend `findCashiersByStore` to `SELECT u.id` and map `user_id: row.id`; add `user_id: string` to the `PosRosterCashierEntry` DTO; extend the `pos-operators.openapi.yaml` `PosRosterCashierEntry` schema with the additive `user_id` (required, uuid) property. No migration, no membership change, no resolution-path change. This is the cashier-roster sibling of the shipped 033 (which did the identical surfacing for `PosOperatorSummary`).

---

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 20 LTS

**Primary Dependencies**: NestJS 11 (api), Drizzle/pg (the roster read — unchanged shape, one added column)

**Storage**: PostgreSQL 16 — **no schema change**. `users.id` already exists and is already the `u.id` joined by `findCashiersByStore`.

**Testing**: Jest + Supertest (api). The existing `pos-operators` Wave-3 roster suites are extended; the roster query already touches `users`, so the seeded-cashier assertion needs no new table.

**Target Platform**: Linux server (api service); consumer is the POS-Pulse terminal (separate repo) via the pinned OpenAPI contract.

**Project Type**: web-service (NestJS api) + contract package.

**Performance Goals**: N/A — one added projected column (`u.id`) on a query that already joins `users`. No new join, no new round-trip.

**Constraints**: additive + backward-compatible (FR-034-4, SC-034-3); no migration (FR-034-5, SC-034-4); applied in lockstep across contract + DTO + mapper (FR-034-6).

**Scale/Scope**: one DTO field, one SELECT-column + one map-field in `findCashiersByStore`, one OpenAPI schema property. Bounded, ~4–8 LOC of production change + tests.

---

## Constitution Check

*GATE: Must pass before Phase 0. Re-checked after design (no change — design is a field addition). Constitution v3.0.1.*

| Principle | Relevance | Verdict |
|-----------|-----------|---------|
| §II Multi-tenant RLS | No new query; `findCashiersByStore` is already tenant+store scoped (the `WHERE m.tenant_id` + store-access filters are untouched). | PASS — untouched. |
| §III Backend authority | `user_id` is derived server-side from the authoritative `users` row; the client receives, never sets it. | PASS. |
| §IV Contract-first | The OpenAPI `PosRosterCashierEntry` schema is extended *with* the runtime change; POS-019 (merged) is the cross-side consumer. | PASS — G2 additive extension. |
| §VIII Reproducible releases (`[GATED]`) | The contract YAML (`packages/contracts/openapi/**`) is a gated path. The runtime DTO + service are not. | Gated — contract edit is `[GATED]` at execution, not authored here. |
| §IX Authority boundaries (read-not-mutate) | Surfaces an existing value; does not mint, does not change the `clerk_user_id` resolution key (029) or roster membership. | PASS — no authority handover. |
| §XII Object safety | One additive outbound field on an existing response object; no mass-assignment, no inbound field. | PASS — outbound-only. |
| §XIV PII discipline | `user_id` is an internal UUID, already used server-side for ownership/audit. Not a secret, not new PII, not a credential. | PASS — identity data, BUSINESS-class at most. |
| §G10 Identity & Access Boundary | Re-verified at plan-start (§G10 below). | CONSUMED — PASS. |

**No violations.** Complexity Tracking omitted (nothing to justify).

---

## G10 re-verify (performed at plan-start, against `origin/main` `88c8d3d`)

The spec claims G10 is CONSUMED. Re-verified against the actual code:

- **E-1 confirmed** — `packages/contracts/openapi/pos-operators.openapi.yaml` `PosRosterCashierEntry` (≈L510–537): `required: [id, display_name, role]`, `additionalProperties: false`, `id` documented as the Clerk subject (`users.clerk_user_id`). **No `user_id` today.** DTO mirror `apps/api/src/pos-operators/dto.ts` `PosRosterCashierEntry` (≈L138): `{ id, display_name, role }`.
- **E-2 confirmed** — `apps/api/src/pos-operators/pos-operators.service.ts` `findCashiersByStore` (≈L798–832): `JOIN users u ON u.id = m.user_id` (≈L809); SELECTs `u.clerk_user_id, u.display_name` (≈L806); maps `{ id: row.clerk_user_id, display_name, role }` (≈L827–831). `u.id` is the join key — already available; surfacing it is `SELECT u.id` + `user_id: row.id`.
- **E-3 confirmed** — the roster resolves cashiers via `memberships` + `users` (the `store_staff` role + store-access filters), **not** via `external_identity_links`. So `user_id` (= `users.id`) is available independent of the deferred 029 link provisioning (`linkExternalIdentity` still has no live caller). Same posture as 033.
- **Boundary verdict**: `user_id` is **identity data** (the §16 neutral key), not a credential and not a scope-bearing token. Surfacing it on the roster the terminal already receives introduces no scope-interchange and respects producer-exclusion (028 owns the boundary; this consumes it). **G10 CONSUMED — re-verify holds.** Re-confirm once more at the implementation dispatch.

---

## Carried plan-level decision (mirrors 033 OQ-033-2)

### Contract field requiredness + rollout ordering → **DECISION: `user_id` is `required` on `PosRosterCashierEntry`; the schema bump ships coordinated with the POS-Pulse roster-allowlist update.**

Rationale (requiredness): every rostered cashier resolves to a `users` row (the query JOINs on `u.id`), so `u.id` is always present and non-null. `required` is the contract-honest choice — the producer guarantees it on every roster entry.

**Rollout-ordering hazard — present, dispositioned.** `PosRosterCashierEntry` declares `additionalProperties: false`. For a **lenient** consumer the field is purely additive; for a **strict** consumer pinned to the old schema, a response carrying `user_id` is rejected. POS-Pulse's roster handler is an **allowlist reader** (`roster-handler.ts` strips unknown fields by construction) — so it is wire-safe today and will thread `user_id` only after it widens its allowlist (POS-019 follow-up). The safe sequence is therefore a coordinated pair: this DP-2 schema bump + the POS-Pulse roster-allowlist widening. Not a code-behavior break; a minor sequenced release. **Confirmed cross-side need:** POS-019 is already merged and refuses `not_ready` until this field is live — so the consumer is real and waiting.

---

## Project Structure

### Documentation (this feature)

```text
specs/034-pos-roster-cashier-user-id/
├── spec.md              # SPECIFY + CLARIFY (merged in this chain)
├── plan.md              # This file
├── tasks.md             # /speckit-tasks output
└── checklists/
    └── requirements.md  # spec-quality checklist
```

No `research.md` / `data-model.md` / `quickstart.md` / `contracts/` scaffolding: the approach is fully determined by E-1..E-5, there is no data model beyond one existing column, and the contract change is one additive property (described inline in tasks, authored `[GATED]` at execution). Same minimal posture as 033.

### Source Code (repository root) — *touched by the future implementation dispatch, not by this plan*

```text
apps/api/src/pos-operators/
├── dto.ts                      # ADD: user_id: string to PosRosterCashierEntry (+ JSDoc: = users.id, §16 neutral key)
└── pos-operators.service.ts    # findCashiersByStore: SELECT u.id (≈L806) + map user_id: row.id (≈L827)

apps/api/test/pos-operators/    # EXTEND: roster test asserts each entry carries user_id == users.id (≠ clerk_user_id);
                                #         + additive/backward-compat deserialization (US2)

packages/contracts/openapi/
└── pos-operators.openapi.yaml  # [GATED] ADD: user_id (required, format: uuid) to PosRosterCashierEntry (≈L510)
```

**Structure Decision**: No new files, no new module. A field addition within the existing `pos-operators` Wave-3 roster slice and its pinned contract. The only gated path is the OpenAPI YAML (§VIII); the DTO/service/test changes are ordinary api changes.

---

## Phase plan (for `/speckit-tasks` to expand)

1. **Contract** `[GATED]` — extend `PosRosterCashierEntry` schema with `user_id` (required, uuid). Authored only under gated-path approval at execution.
2. **DTO** — add `user_id: string` to `PosRosterCashierEntry` with JSDoc pointing to `users.id` / §16.
3. **Service** — `findCashiersByStore`: add `u.id` to the SELECT and `user_id: row.id` to the row map. RED-first: extend the roster test to expect `user_id`, watch it fail, then add it.
4. **Tests** — seeded-cashier roster assertion that each entry's `user_id == users.id` and `≠ clerk_user_id`; multi-cashier non-null assertion (SC-034-2); US2 backward-compat deserialization (lenient ignores the field; strict-against-old-schema characterization).
5. **Verify** — api build (tsc) + the `pos-operators` roster jest suite green; confirm no migration, no membership-rule diff, no resolution-path diff (SC-034-4).

---

## Complexity Tracking

> Not applicable — Constitution Check has no violations. No table.
