# Wave Status — `008-sales-transaction-capture`

| Field | Value |
| --- | --- |
| Spec | [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Execution map | [execution-map.yaml](./execution-map.yaml) |
| Gate | [gate-money-temporal.md](./gate-money-temporal.md) — **RESOLVED 2026-05-30** |
| Constitution | v3.0.1 |
| Owner | Ahmed Shaaban |
| Updated | 2026-05-30 — Phase 1 merged (#420); Phase 2 [GATED] slices in review (#421 SCHEMA / #422 CONTRACT) |

---

## TL;DR

008 introduces the **first sale fact** the SaaS owns (`sales` + `sale_lines` + void/refund terminal events), built **alongside** the shipped 005 POS ingestion seam (reuses Idempotency-Key interceptor, `sourceSystem+externalId` dedup, tenant-context/RLS, audit, outbox — no re-invention).

**Planning chain + Agent-OS coordination MERGED to `main`** (PRs #414/#418/#419). **Phase 1 SETUP MERGED** (#420, `6d01512` — empty `SalesModule`). **Both `[GATED]` Phase-2 slices USER-APPROVED + IN REVIEW**: `008-CONTRACT` (#422) and `008-SCHEMA` (#421), each rebased on `main` @ `6d01512`, all validation GREEN.

**Both gated PRs (#421 + #422) must merge before any implementing GREEN slice** dispatches (the hard serialization points). They are order-independent between themselves. The Money + Temporal gate is resolved, so there are **no open WHAT-level blockers** — only the two gated PRs awaiting merge.

**MVP** = `008-US1-CAPTURE` + its foundational prerequisites. That alone delivers a durable, isolated, idempotent, provenance-preserving sale fact — the keystone the rest of the ERP loop (009 inventory, 010 payments, 012 reporting) reads from.

---

## Dependency & parallel-safety graph

```text
                         008-SIGNOFF-MONEY-LIB  (T001, [SIGN-OFF] gate A.6 — no package.json dep)
                                   │
                                   ▼
                              008-SETUP  (T002 — new sales module skeleton)
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                     ▼
   008-CONTRACT [GATED]                     008-SCHEMA [GATED]
   (T010/T011 — OpenAPI sale contract)      (T012/T013 — 0012 migration + Drizzle schema)
   packages/contracts/openapi/**            packages/db/**
   approval_required: true                  approval_required: true (+ depends on money SIGN-OFF)
                 │                                     │
                 │                                     ▼
                 │                          008-ISOLATION-HARNESS (T014/T015 — seed + sweep RED)
                 │                                     │
                 └──────────────┬──────────────────────┘
                                ▼
            ┌──────────── 008-US1-CAPTURE (T030–T036) 🎯 MVP ────────────┐
            │   the FIRST GREEN; creates sales.controller/service         │
            └──────────────────────────┬──────────────────────────────────┘
                                        │  (US2–US6 below SHARE sales.controller/service → SERIALIZE)
        ┌───────────────┬───────────────┼───────────────┐        008-WORKER*  (T080–T082)
        ▼               ▼               ▼               ▼          apps/worker/** — PARALLEL-SAFE,
 008-US2-DELAYED   008-US3-VOID    008-US4-REFUND   (serialized    depends_on US1 only; runs
 (T040–T043)       (T050–T053)     (T055–T058)       through the    concurrently with US2–US6
        │               │               │           shared module)
        └───────────────┴───────┬───────┘
                                ▼
                      008-US5-IDEMPOTENCY (T060–T063)
                                │
                                ▼
                      008-US6-SAFETY (T070–T074)   ← per-table RLS-bypass probe (4 tables)
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
   008-LIFECYCLE* (T075)              008-POLISH (T090–T093)
   depends_on SCHEMA + US6-SAFETY;    depends_on US6-SAFETY + WORKER + LIFECYCLE
   test-only + doc — PARALLEL-SAFE             │
                 │                             ▼
                 └──────────────►       008-CLOSEOUT (T094)
```

### Parallel-safe groups (proposed, awaiting endorsement)

| Group | Members | Why safe |
| --- | --- | --- |
| **GATED-FOUNDATIONAL** | `008-CONTRACT`, `008-SCHEMA` | Distinct surfaces (OpenAPI YAML vs db schema). Both `[GATED]`, both block all GREEN, order-independent between themselves. (008-SCHEMA also waits on the money SIGN-OFF.) |
| **POST-CAPTURE-PARALLEL** | `008-WORKER`, `008-LIFECYCLE` | `apps/worker/**` is a distinct tree; lifecycle is test-only + a doc note. Neither overlaps the api `sales` module once US1 capture exists. |

### NOT parallel-safe (must serialize) — the load-bearing caution

`008-US1/US2/US3/US4/US5/US6` are **conceptually independent** capability paths but all write the **same two files** — `apps/api/src/catalog/sales/sales.controller.ts` and `sales.service.ts`. They are therefore **NOT file-parallel-safe** and MUST be serialized through the shared module:

1. **US1-CAPTURE first** (MVP — creates the module).
2. Then US2 / US3 / US4 (each extends the same controller/service).
3. Then US5 (idempotency/provenance hardening over capture+terminal).
4. Then US6 (final isolation/object-safety/audit hardening + 4-table RLS-bypass probe).

`008-WORKER` and `008-LIFECYCLE` can run **concurrently** with the US2–US6 chain (distinct trees). This is the one real parallelism win after the MVP.

---

## SIGN-OFF Decisions

### T001 — Money representation / library (gate A.6)

**Verdict: STRING-BACKED VALUE OBJECT — no `package.json` dependency.** Transaction money is a `{ amount: string, currency }` value object validated at the Zod boundary and round-tripped to DB `numeric(19,4)`. No float ever appears. Because gate A.2 chose single per-line **snapshot** tax (the SaaS does not recompute tax), the only money computation is the per-line/half-up comparison total (A.3/A.4) — a big-decimal library is unwarranted. **Consequence:** `008-SCHEMA` and the GREEN slices add **no** `package.json` dependency. If a future need for a big-decimal lib arises, that is a SEPARATE `[GATED]` `package.json` decision — stop and request approval (do not add silently). Full rationale: [gate-money-temporal.md §A.6](./gate-money-temporal.md) + [research.md §R5](./research.md).

> The full Money + Temporal gate (A.1–A.6, B, C, D.1–D.3) is RESOLVED in [gate-money-temporal.md §Decisions Recorded](./gate-money-temporal.md); only the A.6 no-dependency consequence carries a dispatch-time edge, so it is restated here.

---

## Active findings

None. Planning chain is internally consistent (`/speckit-analyze`: 0 CRITICAL, 0 constitution violations, 100% behavioral coverage after the T075/SI-012 remediation).

---

## Provenance

- **Planning chain MERGED to `main` via #418** (`f4b4688`) + Agent-OS coordination layer via **#419** (`cecdaac`): spec / plan / tasks / analyze + gate RESOLVED + `execution-map.yaml` + `wave-status.md`.
- **Phase 1 SETUP MERGED via #420** (`6d01512`): empty `SalesModule` skeleton (T002). `008-SIGNOFF-MONEY-LIB` (T001) resolved.
- **Phase 2 `[GATED]` slices USER-APPROVED + IN REVIEW** (both rebased on `main` @ `6d01512`; order-independent; both must merge before any GREEN):
  - **`008-CONTRACT` → PR #422** — POS sales OpenAPI contract (`pos-sales/sales.yaml`). Validation: `sales.contract.spec` 16/16 + umbrella conformance 89/89 GREEN.
  - **`008-SCHEMA` → PR #421** — `0012_sales` migration + Drizzle schema (4 tables: `sales` / `sale_lines` / `sale_voids` / `sale_refunds`). Validation: `0012-sales.spec` 12/12 round-trip (WSL Testcontainers) + `sales-schema-shape.spec` 12/12 GREEN. Notable: the migration's tenant RLS policies use the established empty-GUC `CASE` guard (the bare `::uuid` cast — fixed repo-wide in 0009/0010 — was caught by the round-trip probe).
- Remaining slices `proposed`; no runtime GREEN on `main` yet.

---

## Next recommended action

1. **Review + merge `008-SCHEMA` (#421) and `008-CONTRACT` (#422)** — order-independent between themselves; **both must merge before any implementing GREEN**.
2. Then dispatch **`008-ISOLATION-HARNESS`** (RED seed + sweep) → **`008-US1-CAPTURE`** 🎯 (the MVP first GREEN — creates `sales.controller.ts` + `sales.service.ts`).
3. After US1: serialize the remaining US slices through the shared `sales` module, while running `008-WORKER` (distinct `apps/worker/**` tree) and `008-LIFECYCLE` (test-only + doc) in parallel.
