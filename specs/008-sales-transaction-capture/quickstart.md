# Quickstart: Sales / Transaction Capture (008)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

> **This is a planning/validation workflow, not a runtime runbook.** 008 implementation is gated (no schema/migration/OpenAPI/code exists yet). This quickstart tells a reviewer or implementing agent how to validate the planning artifacts and what gates must clear before any GREEN code lands.

---

## Planning artifact set (this slice)

| Artifact | Purpose | State |
|---|---|---|
| `spec.md` | WHAT — behavioral contract (+ Clarifications, gate resolutions) | complete |
| `gate-money-temporal.md` | Owner decisions A.1–A.6/B/C/D.1–D.3 | **RESOLVED** |
| `checklists/requirements.md` | spec-quality checklist | all pass |
| `plan.md` | HOW-plan (Constitution Check, Architecture Impact Map, dependency map) | this slice |
| `research.md` | settled decisions + rationale | this slice |
| `data-model.md` | entities/fields/nullability (design, not DDL) | this slice |
| `contracts/README.md` | operation/contract DESIGN (YAML deferred) | this slice |
| `tasks.md` | ordered slices | **next** (`/speckit-tasks`) |

## How to validate this plan (reviewer checklist)

1. **Gated-path discipline** — confirm NO artifact creates a `[GATED]` file: no `.yaml` under `packages/contracts/openapi/**`, no `0012*.sql` migration, no `package.json`/lockfile edit, no app code. (Design/reference only.)
2. **Constitution Check** — `plan.md` §2 maps every principle to a real spec FR/SI; §VI names the RLS-bypass probe + cross-tenant/cross-store sweep + malicious-override.
3. **Gate consistency** — `data-model.md` matches the RESOLVED gate: `numeric(19,4)`; single per-line `tax_amount` snapshot; SHA-256 over canonical JSON; `occurred_at`/`received_at`/`business_date` NOT NULL, `processed_at`/`source_clock_at` nullable, lines inherit; no tender fields.
4. **Architecture Impact Map** — `plan.md` §3 lists the triggered gates (GATED OpenAPI, GATED migration, isolation-harness extension) and "new observability signals: NONE."
5. **Additive-only structure** — §5.2 proposes only new paths (`apps/api/src/catalog/sales/`, new `sales/` schema, `0012` migration, new OpenAPI contract); it touches no shipped file or other feature.
6. **No agent-context drift** — root `CLAUDE.md` has no `<!-- SPECKIT -->` markers, so it is deliberately left unmodified (plan §7).

## Gates that must clear before any implementation GREEN

Per Constitution §VIII + Standing Rules §3, each `[GATED]` artifact is its own approval-gated slice, in this order (advisory; authoritative order is `tasks.md`):

1. **`[GATED]` OpenAPI sale contract** approved + merged (capture/void/refund/read operations, FR-101 error set, `toBody` projections).
2. **`[GATED]` `0012` migration + Drizzle schema** approved + merged (sales/sale_lines/void/refund + fail-closed RLS + paired `*.down.sql`).
3. **Isolation harness** extended (cross-tenant/cross-store sweep + RLS-bypass probe) — RED first.
4. Then the per-user-story implementing slices (US1 capture → US2 delayed sync → US3/US4 terminal events → US5/US6 hardening → worker), each RED→GREEN.

## Test posture to lock in (from spec §8 + Constitution §VI)

- Snapshot-immutability (SC-001): capture → edit catalog → re-read lines unchanged.
- Totals-fidelity (SC-002): mismatched payload → POS total preserved, advisory flag set, never rewritten.
- Idempotency-replay (SC-003): same `(tenant, sourceSystem, externalId)` ×N → exactly one record, identical response.
- Cross-tenant/out-of-scope safe-404 (SC-004) + **raw-SQL RLS-bypass probe** (wrong-tenant GUC ⇒ zero rows) per new table.
- Malicious-override (SC-005): body-supplied `tenant_id`/`store_id`/`created_by`/server-owned fields ignored/rejected.
- Terminal-event immutability (SC-006); delayed-sync (SC-007); provenance reconciliation (SC-008); audit linkage (SC-009); latency (SC-010).

## Next command

`/speckit-tasks` — generate the ordered, dependency-aware `tasks.md` / `execution-map.yaml` for the slices above. (Implementation remains gated on the `[GATED]` contract + migration slices clearing first.)
