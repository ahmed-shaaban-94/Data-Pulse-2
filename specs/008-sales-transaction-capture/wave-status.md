# Wave Status — `008-sales-transaction-capture`

| Field | Value |
| --- | --- |
| Spec | [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Execution map | [execution-map.yaml](./execution-map.yaml) |
| Gate | [gate-money-temporal.md](./gate-money-temporal.md) — **RESOLVED 2026-05-30** |
| Constitution | v3.0.1 |
| Owner | Ahmed Shaaban |
| Updated | 2026-05-31 — **WORKER (#431, `8039a22`) + LIFECYCLE (#430, `ead7b5a`) MERGED** (parallel dispatch, isolated worktrees). All six user stories + worker + lifecycle now on `main`. Execution-map reconciled. Remaining `proposed`: **POLISH → CLOSEOUT** only. Deferred/tracked: WORKER BullMQ registration + reconciliation-mismatch-rate signal emit (KNOWN-GAP). |

---

## TL;DR

008 introduces the **first sale fact** the SaaS owns (`sales` + `sale_lines` + void/refund terminal events), built **alongside** the shipped 005 POS ingestion seam (reuses Idempotency-Key interceptor, `sourceSystem+externalId` dedup, tenant-context/RLS, audit, outbox — no re-invention).

**Phase 1 + both `[GATED]` Phase-2 slices MERGED to `main`**: `008-SETUP` (#420, `6d01512`), `008-SCHEMA` (#421, `560d16c`), `008-CONTRACT` (#422, `7459ea5`); planning chain + coordination on main via #414/#418/#419. CodeRabbit review on all three addressed before merge.

**All six user stories (US1–US6) + `008-WORKER` + `008-LIFECYCLE` are now MERGED to `main`** — the full capture + terminal-event (void/refund) + idempotency + safety-hardening runtime is live, plus off-request worker processing (`processedAt` + advisory mismatch flag) and the SI-012 data-class/retention guard. WORKER (#431) and LIFECYCLE (#430) were dispatched as two parallel agents in isolated worktrees → separate PRs, both validated GREEN before merge. Remaining 008 work: `008-POLISH` (≥80% coverage + full-suite + bulk-sync ceiling) → `008-CLOSEOUT`. Two WORKER follow-ups are deliberately deferred + tracked (see Active findings).

**MVP** = `008-US1-CAPTURE` + its foundational prerequisites — **DELIVERED**. It delivers a durable, isolated, idempotent, provenance-preserving sale fact — the keystone the rest of the ERP loop (009 inventory, 010 payments, 012 reporting) reads from.

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

**WORKER deferred wiring (KNOWN-GAP, 2 items)** — `008-WORKER` (#431) ships the off-request `SaleProcessingProcessor` + tests (GREEN), but two integration pieces are deliberately deferred, following the `AuditFanoutProcessor` KNOWN-GAP precedent. They must be wired before the worker actually runs in the live system — fold into `008-POLISH` or a dedicated wiring slice:

1. **BullMQ registration** — the processor is not registered in `worker.module.ts` / `queue.config.ts` (Layer-B bootstrap). The job class exists and is unit/integration-tested, but nothing enqueues/consumes it yet.
2. **Observability signal emit** — the worker computes the advisory mismatch flag but does **not** yet emit the **reconciliation-mismatch-rate** signal (FR-031 *MAY* / FR-091). This is the **existing** signal — NOT a new event type; adding an `OUTBOX_EVENT_TYPES` value would violate FR-091/§6.9 ("008 adds no new event/metric category"), so the agent correctly avoided it. Wiring the emit into the existing signal is the remaining work.

Planning chain otherwise internally consistent (`/speckit-analyze`: 0 CRITICAL, 0 constitution violations, 100% behavioral coverage after the T075/SI-012 remediation).

---

## Provenance

- **Planning chain MERGED to `main` via #418** (`f4b4688`) + Agent-OS coordination layer via **#419** (`cecdaac`): spec / plan / tasks / analyze + gate RESOLVED + `execution-map.yaml` + `wave-status.md`.
- **Phase 1 SETUP MERGED via #420** (`6d01512`): empty `SalesModule` skeleton (T002). `008-SIGNOFF-MONEY-LIB` (T001) resolved.
- **Phase 2 `[GATED]` slices MERGED to `main`** (CodeRabbit review addressed on each before merge):
  - **`008-SCHEMA` → PR #421 (`560d16c`)** — `0012_sales` migration + Drizzle schema (4 tables: `sales` / `sale_lines` / `sale_voids` / `sale_refunds`). Validation: `0012-sales.spec` **16/16** round-trip (WSL Testcontainers) + `sales-schema-shape.spec` 12/12 GREEN. RLS uses the empty-GUC `CASE` guard; append-only INSERT-only child policies + composite tenant/store FKs added per review.
  - **`008-CONTRACT` → PR #422 (`7459ea5`)** — POS sales OpenAPI contract (`pos-sales/sales.yaml`). Validation: `sales.contract.spec` **19/19** + umbrella conformance 89/89 GREEN. Documented 200 replay, verbatim Error envelope, nullable-money `anyOf`, terminal events carry no `occurredAt` (no such column) per review.
- **`008-ISOLATION-HARNESS` MERGED via #425** (`7a1885e`): `seed-sales.ts` + `sales-sweep.spec.ts`. Group-A RLS/isolation sweep GREEN with rows present (wrong/unset/cross-tenant GUC ⇒ zero rows on all 4 sale-fact tables); Group-B operation cases scaffolded RED on the unbuilt capture/void/refund/read ops.
- **`008-US1-CAPTURE` 🎯 IN REVIEW via PR #426** (branch `feat/008-us1-capture`, rebased on `db8f70d`) — the **first runtime GREEN**, T030–T036:
  - `SalesController` (captureSale POST + readSale GET) + `SalesService` (immutable `sales` header + frozen `sale_lines` under RLS; POS total verbatim FR-030; advisory `mismatch_flag` via PG-`numeric` half-up per-line compare, no JS float; dedup on `(tenant_id, source_system, external_id)` FR-050 + cross-tenant isolation SI-001; SHA-256-canonical `payload_hash`; no catalog mutation / no auto-create FR-004) + strict Zod DTO (FR-061/062) + root-wiring (`app.module.ts` + filled SETUP skeleton). Row ids via shared `newId()` UUIDv7 (matches `reconciliation`; B-tree locality on the high-write fact tables).
  - **T036** = sweep §B.1 capture object-safety (HTTP): cross-tenant read → non-disclosing 404 (FR-102/SC-004), out-of-scope ref → 404 (FR-063/SI-004), body authority fields ignored (FR-061), unauthenticated → 401. §B.2 void/refund left intended-RED for US3/US4.
  - **Validation (WSL Testcontainers):** capture gate `catalog/sales/capture` → **5 suites / 8 GREEN**; `catalog/sales/isolation` → 18 passed, only the 2 §B.2 placeholders intended-RED. `tsc --noEmit` clean.
  - **Fixed 2 RED-phase test-file bugs** (both `capture/**`, assertion intent preserved): `capture-happy` afterEach referenced a non-existent `source_system` column on `sale_lines` (→ parent subquery); T031 `UPDATE` set `default_price` without paired `default_currency_code` (→ set both, satisfies `tenant_products_currency_paired`).
  - **Scope note (flagged in PR #426):** `app.module.ts` / `sales.module.ts` / `isolation/sales-sweep.spec.ts` sit beyond the slice's literal `allowed_files` (`capture/**`), but SETUP's merged docstring defers root-wiring here and T036 is in this slice's `task_ids` (placeholders tagged `[T036]`) — documented intent, not a `[GATED]` path. Spec-authoring gap in the glob.
- Remaining slices `proposed`. Map: SETUP/SCHEMA/CONTRACT/ISOLATION-HARNESS `merged`; US1-CAPTURE `in_review` (#426).

---

## Next recommended action

All six user stories + WORKER + LIFECYCLE are merged. Only the polish/closeout tail remains:

1. **`008-POLISH`** (T090–T093) — ≥80% coverage on the new sales module, full catalog suite green, bulk-sync 500/req ceiling enforced (FR-080), signals reuse the existing POS-sync-lag / duplicate-event-rate / reconciliation-mismatch-rate (no new metric). `depends_on: [008-US6-SAFETY, 008-WORKER, 008-LIFECYCLE]` — **all now merged**, so POLISH is unblocked. Natural home to also land the two deferred WORKER wiring items (BullMQ registration + reconciliation-mismatch-rate emit — see Active findings).
2. **`008-CLOSEOUT`** (T094) — final terminal-status reconciliation with provenance.

Note: WORKER's two deferred wiring items (Active findings) are KNOWN-GAP, not blockers for the merged slice; decide whether POLISH absorbs them or a small dedicated wiring slice does.
