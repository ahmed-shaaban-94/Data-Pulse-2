<!--
  /speckit-tasks output for 008 Sales / Transaction Capture.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
-->

# Tasks: Sales / Transaction Capture

**Feature**: 008-sales-transaction-capture | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/README.md](./contracts/README.md) | **Research**: [research.md](./research.md)

---

## 0. TL;DR — 008 is a NEW sale-fact module built ALONGSIDE the shipped 005 ingestion seam

008 introduces the first sale fact (`sales` + `sale_lines` + void/refund terminal events). It **reuses unchanged** the 005/001 ingestion plumbing — the `Idempotency-Key` interceptor, `sourceSystem + externalId` dedup, tenant-context/RLS helpers, audit insert, outbox — and adds a new `apps/api/src/catalog/sales/` module mirroring the `reconciliation/` triad. The only genuinely new surface is the **`[GATED]`** sale schema (`0012` migration) and the **`[GATED]`** OpenAPI sale contract. The Money + Temporal Decision Gate is RESOLVED, so there are no open WHAT-level blockers. Test-first per Constitution §VI.

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [labels] Description (file path). Predecessors: …. Acceptance: ….`
- **Labels**: `[P]` parallelizable (different files, no incomplete dependency); `[US#]` user-story phase task; `[GATED]` requires explicit approval before running (forbidden path); `[TC]` Testcontainers/real-Postgres integration test (run via WSL per repo convention); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test task and made GREEN; RED before GREEN (Constitution §VI). Coverage ≥80%.
- **Money**: `numeric(19,4)` + ISO currency, string-backed value object (gate A.1/A.6). **Timestamps**: gate B nullability. **Hash**: SHA-256 over canonical JSON (gate C). **No tender** (gate A.5).
- **POS routes**: `@Post("api/pos/v1/...")` with no `@Controller` prefix arg (mirror `posCaptureItem`).

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T010 | `[GATED]` | New OpenAPI sale contract under `packages/contracts/openapi/**` — explicit approval, its own slice before any implementing GREEN (§IV/§VIII). |
| T013 | `[GATED]` | New `0012_sales` SQL migration + Drizzle schema (`packages/db/drizzle/`, `packages/db/src/schema/sales/`) — explicit approval, paired `*.down.sql`, lock-duration review (§VIII). |
| T001 | `[SIGN-OFF]` | Confirm money representation = string value object adds **no `package.json` dependency** (gate A.6). If `/speckit-tasks` execution finds the comparison-total math needs a big-decimal lib, that is a SEPARATE `[GATED]` `package.json` decision — STOP and request approval. |

The Money + Temporal gate (A.1–A.6, B, C, D.1–D.3) is already RESOLVED in [gate-money-temporal.md](./gate-money-temporal.md); no further `[SIGN-OFF]` is needed for those.

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) | Capture a completed sale as an immutable fact (snapshot, totals-fidelity, dedup, provenance) | T030–T036 |
| US2 (P1) | Delayed offline sync without rewriting time | T040–T043 |
| US3 (P2) | Void as a separate terminal event | T050–T053 |
| US4 (P2) | Refund as a separate terminal event | T055–T058 |
| US5 (P2) | Ingestion idempotent + provenance-preserving | T060–T063 |
| US6 (P2) | Tenant/store-isolated, object-safe, auditable | T070–T074 |
| (worker) | Off-request `processedAt` + mismatch computation | T080–T082 |

---

## 4. Phase 1 — Setup (shared infrastructure)

- [ ] T001 [SIGN-OFF] Confirm the 008 branch is off latest `origin/main`; the catalog modules compile clean (`apps/api/src/catalog/{unknown-items,reconciliation}/`); and the money representation (string value object → `numeric(19,4)`) requires **no** `package.json` change (gate A.6). Predecessors: none. Acceptance: `pnpm --filter api build` succeeds; decision recorded that no dependency is added (if one becomes necessary, raise a separate `[GATED]` request, do not add silently).
- [ ] T002 [P] Scaffold the new module directory `apps/api/src/catalog/sales/` (empty `sales.module.ts` registered in the catalog/app module wiring, mirroring `reconciliation.module.ts`). Predecessors: T001. Acceptance: module compiles and is registered; no routes yet.

## 5. Phase 2 — Foundational (blocking prerequisites for all user stories)

### 5.1 `[GATED]` OpenAPI sale contract

- [ ] T010 [GATED] Request explicit approval, then author the new OpenAPI sale contract under `packages/contracts/openapi/` (e.g. `pos-sales/sales.yaml`) per [contracts/README.md](./contracts/README.md): operations **captureSale**, **recordVoid**, **recordRefund**, **readSale** (POS-namespace auth like `pos-operators.yaml`); stable `operationId`s; canonical `Error` envelope with the FR-101 category set (validation/not-found/idempotency-token-mismatch/already-applied/conflict/system-failure); `toBody` response projections (no raw DB entities, §IV); `Idempotency-Key` header on writes (FR-051). No tender fields (gate A.5). Predecessors: T001. Acceptance: YAML lints clean against the existing OpenAPI validator; registered for conformance tests.
- [ ] T011 [GATED] [P] Confirm the new contract is discovered by the conformance-test entrypoint (register in the YAML registry if one exists). Predecessors: T010. Acceptance: conformance harness picks up the new operationIds.

### 5.2 `[GATED]` sale-fact schema + migration

- [ ] T012 [P] [TC] RED test — `apps/api/test/catalog/sales/schema/sales-schema-shape.spec.ts`: assert (when the schema exists) `sales`/`sale_lines`/void/refund carry the [data-model.md](./data-model.md) field set, money as `numeric(19,4)`+`char(3)`, gate-B nullability, the `(tenant_id, source_system, external_id)` unique, and NOT-NULL `tenant_id`/`store_id`. Predecessors: T001. Acceptance: test runs, fails (no schema yet).
- [ ] T013 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/sales/{sales,sale-lines}.ts` incl. void/refund tables) and the paired `0012_sales.sql` / `0012_sales.down.sql` migration: money `numeric(19,4)`+ISO currency with paired-currency CHECK (mirror 003); gate-B timestamp nullability; provenance + `payload_hash` columns; SaaS-owned `processed_at`/`mismatch_flag`; **fail-closed RLS** `current_setting('app.current_tenant', true)::uuid` on every table; NO `version` column (gate D.1, **FR-070** — immutable fact, no optimistic-concurrency column); NO tender columns (gate A.5). Implements the `sales`/`sale_lines` entities (**FR-002** sale-line snapshot rows) with exact-decimal money + ISO currency (**FR-005**, §III). Predecessors: T012, T010-style approval. Acceptance: T012 GREEN; migration applies + rolls back clean under Testcontainers; lock-duration reviewed.

### 5.3 Isolation-harness extension (blocking — serves all stories)

- [ ] T014 [P] [TC] Extend the catalog test support with sale-fact fixtures (a captured sale + lines, a voided sale, a refunded sale) across tenants A/B and stores X/Y, in a new `apps/api/test/catalog/sales/__support__/seed-sales.ts`. MUST NOT modify the 003-owned `isolation-harness.ts`. Predecessors: T013. Acceptance: helper exports fixtures; existing isolation tests untouched and GREEN.
- [ ] T015 [TC] RED test — `apps/api/test/catalog/sales/isolation/sales-sweep.spec.ts`: cross-tenant/cross-store sweep for capture/void/refund/read per SI-001..005 — unauthenticated → 401; cross-tenant id → non-disclosing 404; out-of-scope store → 404; **raw-SQL RLS-bypass probe** (wrong `app.current_tenant` ⇒ zero rows) on each new table; malicious-override (body `tenant_id`/`store_id`/`created_by` ignored). Predecessors: T014. Acceptance: test runs, cases fail on missing operations (not on RLS).

---

## 6. Phase 3 — US1: Capture a completed sale as an immutable fact (P1) 🎯 MVP

**Goal**: a POS sale becomes an immutable `sales` + frozen `sale_lines` snapshot, totals preserved, deduped, provenance retained.
**Independent test**: capture a 2-line sale → records scoped to (T,S), POS totals verbatim, lines frozen against later catalog edits, duplicate replay returns same reference, cross-tenant invisible.

- [ ] T030 [P] [US1] [TC] RED — `apps/api/test/catalog/sales/capture/capture-happy.spec.ts`: capture → `sales` scoped to (T,S), `pos_total` verbatim, currency recorded, stable reference; two `sale_lines` with frozen price/name/tax/unit (FR-001/002/005, SC-001). Predecessors: T013, T015. Acceptance: runs, fails (no route).
- [ ] T031 [P] [US1] [TC] RED — `capture/snapshot-immutability.spec.ts`: after capture, edit the referenced tenant-product price/name → existing `sale_lines` unchanged (FR-003, SC-001). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T032 [P] [US1] [TC] RED — `capture/totals-fidelity.spec.ts`: POS total ≠ SaaS per-line/half-up comparison total → POS total preserved, advisory `mismatch_flag` set, reconciliation-mismatch signal may emit, never rewritten (FR-030/031/032, SC-002; gate A.3/A.4). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T033 [P] [US1] [TC] RED — `capture/dedup.spec.ts`: same `(tenant, sourceSystem, externalId)` ×N → exactly one `sales`, identical/**deterministic** response (**FR-100**), no double-apply; the `(sourceSystem, externalId)` pair resolves to the same record and is recorded provenance, never body-assignable authority (**FR-041**); cross-tenant `externalId` collision isolated (FR-050, SC-003; SI-001). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T034 [P] [US1] [TC] RED — `capture/ad-hoc-line.spec.ts`: a line with no resolvable tenant product still snapshots price/name/tax/unit; no tenant product auto-created (FR-004). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T035 [US1] GREEN — implement `captureSale` in `apps/api/src/catalog/sales/sales.service.ts` + the POS `@Post("api/pos/v1/...")` route in `sales.controller.ts` (mapped to the T010 `captureSale` operationId): strict `.strict()` Zod DTO (mass-assignment forbidden, FR-061/062); resolve tenant/store from the authenticated principal (never body); freeze line snapshot from the 003 catalog read; preserve POS totals; compute the per-line/half-up comparison total for the advisory flag only; dedup on `(tenant, sourceSystem, externalId)`; retain provenance + SHA-256-canonical `payload_hash`; emit audit (FR-090) + outbox; return the `toBody` projection. Reuse the idempotency interceptor + `with-tenant` helper. Predecessors: T030–T034, T010, T013. Acceptance: T030–T034 GREEN; OpenAPI conformance passes for `captureSale`.
- [ ] T036 [US1] [TC] GREEN-verify — extend the sweep (T015) for capture: cross-tenant read of the new sale → non-disclosing 404 with **no existence leak via any response/error/conflict shape** (**FR-102**); RLS-bypass probe on `sales`/`sale_lines` ⇒ zero rows (SC-004). Predecessors: T035. Acceptance: sweep cases GREEN.

---

## 7. Phase 4 — US2: Delayed offline sync without rewriting time (P1)

**Goal**: events with `occurredAt` far behind `receivedAt` are captured, time preserved, server clock used for security.
**Independent test**: submit a sale 2 weeks stale with skewed `sourceClockAt` → accepted; times preserved; `businessDate` from store tz; no security decision used the client clock.

- [ ] T040 [P] [US2] [TC] RED — `capture/delayed-sync.spec.ts`: `occurredAt` weeks behind `receivedAt` → captured, not rejected; `occurredAt`/`sourceClockAt` preserved; `receivedAt` = server clock (FR-020/024, SC-007). Predecessors: T035. Acceptance: runs, fails (or asserts current behavior gap).
- [ ] T041 [P] [US2] [TC] RED — `capture/business-date.spec.ts`: near a day boundary, `businessDate` derived from **store timezone**, not client clock (FR-023). Predecessors: T035. Acceptance: runs, fails.
- [ ] T042 [P] [US2] [TC] RED — `capture/server-clock-security.spec.ts`: skewed `sourceClockAt` never consulted for idempotency-TTL / rate-limit / expiry — server clock only (FR-022). Predecessors: T035. Acceptance: runs, fails.
- [ ] T043 [US2] GREEN — extend `sales.service.ts` capture path: store all timestamps UTC `TIMESTAMPTZ`; derive `businessDate` from store tz; never use `sourceClockAt` for any security/TTL decision; accept arbitrary `occurredAt` lag (FR-020..024). Predecessors: T040–T042. Acceptance: T040–T042 GREEN.

---

## 8. Phase 5 — US3: Void as a separate terminal event (P2)

**Goal**: a void is an append-only record referencing the sale; original never mutated; idempotent.

- [ ] T050 [P] [US3] [TC] RED — `terminal/void-happy.spec.ts`: record void → separate void record with `voidedAt`, original `sales`+`sale_lines` byte-identical, audited (FR-010/011, SC-006). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T051 [P] [US3] [TC] RED — `terminal/void-idempotent.spec.ts`: second void of same sale (same provenance) → deterministic already-voided outcome, no duplicate (FR-013). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T052 [P] [US3] [TC] RED — `terminal/void-safe404.spec.ts`: void referencing out-of-scope/non-existent sale → non-disclosing 404, no record (FR-014, SI-004). Predecessors: T015. Acceptance: runs, fails.
- [ ] T053 [US3] GREEN — implement `recordVoid` in `sales.service.ts` + the route (T010 `recordVoid` operationId): create the void terminal event, stamp `voidedAt` (server clock), never mutate the sale, object-level authz + safe-404, dedup on provenance, audit. Predecessors: T050–T052, T010, T013. Acceptance: T050–T052 GREEN; conformance passes.

---

## 9. Phase 6 — US4: Refund as a separate terminal event (P2)

**Goal**: a refund is an append-only record; POS refund amount preserved; workflow depth out of scope (FR-015).

- [ ] T055 [P] [US4] [TC] RED — `terminal/refund-happy.spec.ts`: record refund → separate record with `refundedAt`, POS `pos_refund_amount` preserved, original unchanged, audited (FR-010/012, SC-006). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T056 [P] [US4] [TC] RED — `terminal/refund-fidelity.spec.ts`: POS refund amount preserved verbatim; SaaS MAY flag a mismatch but never rewrites (FR-012/030/031). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T057 [P] [US4] [TC] RED — `terminal/refund-idempotent.spec.ts`: re-delivered refund (same provenance) → not double-applied (FR-013). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T058 [US4] GREEN — implement `recordRefund` in `sales.service.ts` + the route (T010 `recordRefund`): create the refund terminal event, stamp `refundedAt`, preserve POS refund amount, never mutate the sale, dedup, safe-404, audit. Predecessors: T055–T057, T010, T013. Acceptance: T055–T057 GREEN; conformance passes.

---

## 10. Phase 7 — US5: Ingestion idempotent + provenance-preserving (P2)

**Goal**: retries/re-deliveries never duplicate; provenance reconcilable.

- [ ] T060 [P] [US5] [TC] RED — `idempotency/replay.spec.ts`: same sale ×5 + same `Idempotency-Key` → exactly one record, identical response, **capture telemetry NOT incremented while duplicate-event-rate MAY increment** (**FR-052**), deterministic replay (FR-100) (FR-050, SC-003). Predecessors: T035. Acceptance: runs, fails.
- [ ] T061 [P] [US5] [TC] RED — `idempotency/token-mismatch.spec.ts`: same `Idempotency-Key` + different payload → deterministic mismatch-conflict, no side-effects (FR-051, 005 FR-021c). Predecessors: T035. Acceptance: runs, fails.
- [ ] T062 [P] [US5] [TC] RED — `provenance/reconcile.spec.ts`: every captured sale/void/refund retains `sourceSystem`/`externalId`/ingestion timestamps/`payload_hash` (SHA-256 canonical) sufficient to reconcile to the payload (FR-040, SC-008; gate C). Predecessors: T035, T053, T058. Acceptance: runs, fails.
- [ ] T063 [US5] GREEN — verify/finish the idempotency wiring (reuse the `Idempotency-Key` interceptor — no new primitive, FR-051) across capture/void/refund and the SHA-256-canonical `payload_hash` computation helper; ensure raw payloads are never logged (FR-042). Predecessors: T060–T062. Acceptance: T060–T062 GREEN.

---

## 11. Phase 8 — US6: Isolation, object-safety, audit (P2)

**Goal**: every path tenant/store-scoped, mass-assignment rejected, strict validation, safe-404, default-deny, audited.

- [ ] T070 [P] [US6] [TC] RED — `safety/mass-assignment.spec.ts`: body-supplied `tenant_id`/`store_id`/`created_by`/`processed_at`/`received_at`/`business_date`/`mismatch_flag` ignored or rejected, never honored (FR-061, SC-005). Predecessors: T035. Acceptance: runs, fails.
- [ ] T071 [P] [US6] [TC] RED — `safety/strict-validation.spec.ts`: unknown keys / malformed values → deterministic validation failure, no record; default-deny on unannotated path (FR-062). Predecessors: T035. Acceptance: runs, fails.
- [ ] T072 [P] [US6] [TC] RED — `safety/audit-linkage.spec.ts`: capture→void→refund each emits a canonical audit event (actor, tenant, store, action, target, correlation id, outcome, timestamp); insert-only; no raw payload/secret in metadata (FR-090/092, SC-009). Predecessors: T035, T053, T058. Acceptance: runs, fails.
- [ ] T073 [US6] GREEN — finalize object-level authz (FR-063), strict `.strict()` DTOs, default-deny, and audit emission across all sales routes; reuse `audit-insert.ts`. Predecessors: T070–T072. Acceptance: T070–T072 GREEN.
- [ ] T074 [US6] [TC] GREEN-verify — full cross-tenant/cross-store sweep (T015) GREEN across capture/void/refund/read; a raw-SQL **RLS-bypass probe (wrong `app.current_tenant` ⇒ zero rows) on EACH of the four sale-fact tables — `sales`, `sale_lines`, the void terminal-event table, and the refund terminal-event table** (SC-004, §VI; SI-001/002/005). Predecessors: T073. Acceptance: sweep fully GREEN; all four per-table probes return zero rows under the wrong tenant.
- [ ] T075 [US6] Data-lifecycle classification + retention (**SI-012 / gate D.3, §XIV**) — record and bind the sale-fact data class and retention posture: the four new entities are **business-class** (catalog references + quantities + POS-reported totals; no PII/payment in v1 since tender is deferred per gate A.5); retention **inherits the 001 long-horizon insert-only audit-retention posture** for the immutable fact; right-to-erasure **tombstones** any future PII field rather than deleting the fact. Capture this as a header comment in the `0012` migration (T013) + a one-line note in `data-model.md`, and add a guard test (`apps/api/test/catalog/sales/lifecycle/classification.spec.ts`) asserting no field classified PII/payment is persisted in v1. If a future slice admits customer-reference or tender data, this reclassifies (SI-012) and re-triggers. Predecessors: T013, T073. Acceptance: classification + retention recorded in the migration + data-model; guard test GREEN (no PII/payment-class field present in v1).

---

## 12. Phase 9 — Worker (off-request processing)

- [ ] T080 [P] [TC] RED — `apps/worker/test/sales/processing.spec.ts`: a worker sets `processed_at` and computes the advisory mismatch flag off-request, carrying `tenantId`/`storeId`/`correlationId` and establishing tenant context before DB access (FR-071/081, §V). Predecessors: T035. Acceptance: runs, fails.
- [ ] T081 [TC] RED — `worker/idempotent-processing.spec.ts`: re-run converges to the same state (processing is idempotent, FR-071). Predecessors: T035. Acceptance: runs, fails.
- [ ] T082 GREEN — implement the off-request sale-processing worker job, reusing the outbox producer + tenant-context helper; redact raw payloads in failed-job logs (FR-042/092). Predecessors: T080, T081. Acceptance: T080, T081 GREEN.

---

## 13. Phase 10 — Polish & cross-cutting

- [ ] T090 [P] Performance check — inline single-sale capture p95 ≤ 500 ms / p99 ≤ 1 s at the SaaS boundary (SC-010); confirm the exact budget with the owner. Predecessors: T035. Acceptance: load-test report recorded (report-only if no perf env, per repo 005 precedent).
- [ ] T091 [P] Per-tenant bulk-sync bound — enforce the 500-events/request ceiling on the bulk path; over-ceiling → deterministic rejection; layered on the inherited 001/004 rate-limit posture (FR-080, SI-011, gate D.2). Predecessors: T035. Acceptance: bulk-bound test GREEN; no unbounded path.
- [ ] T092 [P] Observability — confirm capture/void/refund emit into the already-named signals (POS sync lag, duplicate-event rate, reconciliation-mismatch rate); no new metric category (FR-091). Predecessors: T035. Acceptance: signals present; no parallel naming introduced.
- [ ] T093 Coverage + full suite — ≥80% on the new sales module; full catalog suite green. Predecessors: T074, T082. Acceptance: coverage gate met; suite GREEN under WSL Testcontainers.
- [ ] T094 Closeout — reconcile `execution-map.yaml` / `wave-status.md` to terminal status with provenance. Predecessors: T093. Acceptance: map reconciled.

---

## Dependencies & execution order

### Phase dependencies

- **Setup (Ph1)**: no dependencies.
- **Foundational (Ph2)**: depends on Setup; **BLOCKS all user stories**. Within it: T010 (`[GATED]` contract) and T013 (`[GATED]` schema/migration) are the hard gates; T014/T015 (isolation harness) depend on T013.
- **US1/US2 (P1)**: depend on Foundational. US2 builds on US1's capture path (T035).
- **US3/US4/US5/US6 (P2)**: depend on Foundational; US5/US6 audit/provenance tasks reference the void/refund routes (T053/T058).
- **Worker (Ph9)**: depends on US1 capture (T035).
- **Polish (Ph10)**: depends on the desired stories being complete.

### `[GATED]` ordering (hard)

T010 (OpenAPI) and T013 (migration/schema) each require explicit approval and land as their own slices **before** any GREEN implementing task. T001's `[SIGN-OFF]` (no `package.json` dependency) must hold; if a money library becomes necessary, STOP and raise a separate `[GATED]` request.

### Parallel opportunities

- Ph2: T010 ∥ T012 (contract vs schema-shape RED test) until T013 GREEN.
- Within each story: all `[P]`-marked RED tests run in parallel; the single GREEN task per story follows.
- US3 ∥ US4 (void vs refund) are independent terminal-event paths once Foundational is done.

---

## Implementation strategy

- **MVP = US1 (capture)** + its Foundational prerequisites (T010, T013, T014, T015). That alone delivers a durable, isolated, idempotent, provenance-preserving sale fact — the keystone the rest of the ERP loop (009 inventory, 010 payments, 012 reporting) reads from.
- **Increment**: add US2 (delayed sync) to make the MVP offline-correct, then US3/US4 (terminal events), then US5/US6 (hardening), then the worker and polish.
- **Test-first throughout** (Constitution §VI): RED → GREEN per task; cross-tenant/cross-store sweep + RLS-bypass probe are mandatory, not optional.
- **No `[GATED]` artifact runs without approval**: the OpenAPI contract and the `0012` migration are separate approval-gated slices.

---

## Task summary

- **Total**: 45 tasks (T001–T002 setup; T010–T015 foundational incl. 2 `[GATED]`; T030–T075 the six user stories; T080–T082 worker; T090–T094 polish).
- **Per story**: US1=7, US2=4, US3=4, US4=4, US5=4, US6=6 (incl. T075 SI-012 data-lifecycle).
- **`[GATED]`**: 2 (T010 OpenAPI, T013 migration/schema) + 1 `[SIGN-OFF]` (T001 no-dependency).
- **MVP scope**: US1 + Foundational.
- **Parallel**: all per-story RED tests `[P]`; US3 ∥ US4; contract ∥ schema-shape in Foundational.
