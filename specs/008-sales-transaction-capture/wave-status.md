# Wave Status — `008-sales-transaction-capture`

| Field | Value |
| --- | --- |
| Spec | [spec.md](./spec.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Execution map | [execution-map.yaml](./execution-map.yaml) |
| Gate | [gate-money-temporal.md](./gate-money-temporal.md) — **RESOLVED 2026-05-30** |
| Constitution | v3.0.1 |
| Owner | Ahmed Shaaban |
| Updated | 2026-05-31 — **008 CLOSED.** POLISH (split, #433 `381b717`) + WIRING (#434 `e412e7a`) merged; every slice terminal. Three documented deferrals remain (Active findings): live capture→process loop is gated (producer binding + `sale.captured` event type + `main.ts` start), reconciliation-mismatch-rate emit (FR-031 MAY), SC-010 perf report-only. |

---

## TL;DR

008 introduces the **first sale fact** the SaaS owns (`sales` + `sale_lines` + void/refund terminal events), built **alongside** the shipped 005 POS ingestion seam (reuses Idempotency-Key interceptor, `sourceSystem+externalId` dedup, tenant-context/RLS, audit, outbox — no re-invention).

**Phase 1 + both `[GATED]` Phase-2 slices MERGED to `main`**: `008-SETUP` (#420, `6d01512`), `008-SCHEMA` (#421, `560d16c`), `008-CONTRACT` (#422, `7459ea5`); planning chain + coordination on main via #414/#418/#419. CodeRabbit review on all three addressed before merge.

**008 is CLOSED — every slice merged to `main`.** The full capture + terminal-event (void/refund) + idempotency + safety-hardening runtime is live, plus the off-request worker processor (`processedAt` + advisory mismatch flag), the SI-012 data-class/retention guard, the consumer-side BullMQ registration, the no-unbounded-path guard, and a report-only k6 perf scenario. The post-MVP tail was dispatched as isolated-worktree agents → separate PRs (WORKER #431, LIFECYCLE #430 in parallel; POLISH #433; WIRING #434), each validated GREEN before merge. **Three deferrals are documented (Active findings), none a blocker:** the live capture→process loop is gated (producer binding + `sale.captured` event type + `main.ts` start), the reconciliation-mismatch-rate emit is FR-031 *MAY*, and SC-010 perf is report-only. These are the natural scope of a future "008-followup / live-loop" slice (the producer half is `[GATED]`).

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

**008 is CLOSED. Three documented deferrals remain — none is a blocker; the merged work is correct and tested, but the live capture→process loop is not yet exercised end-to-end.**

> **Correction (2026-05-31):** an earlier version of this section claimed the unregistered worker followed an "`AuditFanoutProcessor` KNOWN-GAP precedent." **That was false** — `AuditFanoutProcessor` IS registered in `worker.module.ts` `providers:` and runs. So the sale processor being unregistered was a **real functional gap**, not a sanctioned pattern. `008-WIRING` (#434) closed the consumer-registration half of it.

1. **Live capture→process loop is GATED (not yet functional).** `008-WIRING` (#434) registered `SaleProcessingProcessor` + `SaleWorker` (consumer half), **registered-but-not-self-started** (review caught a self-start that would idle-poll an unfed queue in prod; `AuditRetentionWorker` is the correct precedent). The producer half is gated and unbuilt: `SalesService` emits `sale.captured` but `SALES_OUTBOX_PRODUCER` is unbound AND `sale.captured` is not in `OUTBOX_EVENT_TYPES` (gated `packages/db`, T541-style approval). The remaining slice = bind producer + add the event type + imperative `SaleWorker.start()` in `main.ts`. Until it ships, `processed_at` stays NULL on every sale (inert today — nothing reads it yet).
2. **reconciliation-mismatch-rate signal emit (T092)** — **FR-031 *MAY*** (optional). The §VII counter is not registered in `api.metrics.ts` / `worker.metrics.ts`; the request path emits a `sale.captured` outbox event but no mismatch-rate metric. Emitting into the existing signal is the remaining work — NOT a new event type (§6.9).
3. **SC-010 perf** — report-only (no perf env; 005 T560 precedent). `loadtests/k6/sales-capture.js` carries the thresholds, runs when a perf env + POS-auth seam exist.

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

**008 is closed.** No further 008 slice is in development. The remaining value is a **future "008-live-loop" follow-up** that makes the merged capture→process pipeline actually run end-to-end — it is partly `[GATED]`, so it should be scoped as its own slice (likely its own spec section), not silently folded:

1. **Live-loop wiring** — bind `SALES_OUTBOX_PRODUCER` in `SalesModule`; add `sale.captured` to `OUTBOX_EVENT_TYPES` (**`[GATED]` `packages/db`**, T541-style approval); route the outbox event onto the `sale-processing` queue; add the imperative `SaleWorker.start()` in `apps/worker/src/main.ts` (mirrors Email/Audit). After this, `processed_at` is actually set off-request.
2. **reconciliation-mismatch-rate signal (T092 completion)** — register the §VII counter in `api.metrics.ts` (+ worker equiv) and emit from the mismatch path. FR-031 *MAY*; do it when observability for the mismatch flag is wanted.
3. **SC-010 perf** — run `loadtests/k6/sales-capture.js` once a perf env + POS-device-auth seam exist; promote from report-only to a release gate then.

None blocks downstream features that only *read* the immutable sale fact (009 inventory, 012 reporting) — those depend on the capture rows, which are live.
