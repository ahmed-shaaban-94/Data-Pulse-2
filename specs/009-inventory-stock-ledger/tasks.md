<!--
  /speckit-tasks output for 009 Inventory & Stock Movement Ledger.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
-->

# Tasks: Inventory & Stock Movement Ledger

**Feature**: 009-inventory-stock-ledger | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/README.md](./contracts/README.md) | **Research**: [research.md](./research.md)

---

## 0. TL;DR — 009 is a NEW inventory module built ALONGSIDE the shipped 001/005/008 seams, DECOUPLED from the gated 008 live loop

009 introduces the **Inventory source-of-truth domain**: an append-only `stock_movements` ledger + a derived (compute-on-read) on-hand balance. It **reuses unchanged** the 001/005 idempotency interceptor, `sourceSystem + externalId` dedup, tenant-context/RLS helpers, audit insert, and the outbox/worker — and adds a new `apps/api/src/inventory/` module mirroring the `catalog/sales/` triad. The only genuinely new surfaces are the **`[GATED]`** movement-ledger schema (`0014` migration) and the **`[GATED]`** inventory OpenAPI contract, plus **ONE new observability signal** (the negative-balance signal). The five owner decisions are RESOLVED (spec §Clarifications), so there are no open WHAT-level blockers. **Critical**: v1 does NOT subscribe to `sale.captured`; the sale-linked backfill reads the **captured** 008 sale rows, never `processed_at`-stamped ones. Test-first per Constitution §VI.

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [labels] Description (file path). Predecessors: …. Acceptance: ….`
- **Labels**: `[P]` parallelizable (different files, no incomplete dependency); `[US#]` user-story phase task; `[GATED]` requires explicit approval before running (forbidden path); `[TC]` Testcontainers/real-Postgres integration test (run via WSL per repo convention); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test task and made GREEN; RED before GREEN (Constitution §VI). Coverage ≥80%.
- **Quantity**: exact-decimal `numeric(p,s)`, string-backed value object, single stocking unit (R3, no float, no dependency). **Timestamps**: `occurred_at`/`received_at` UTC `TIMESTAMPTZ`, server security clock (§X). **Idempotency**: `Idempotency-Key` (manual) / `sourceSystem+externalId`+sale-ref (backfill) (R4). **Negative stock**: allow-and-flag + new signal (R2). **No PII/payment** (§XIV).
- **Routes**: `cookieAuth` operator surface (`@Post("api/inventory/v1/...")`), NOT `/api/pos/v1/` device-token (plan §4.2). Sale-linked backfill = platform/admin worker path, not a public route.
- **Package name**: `@data-pulse-2/api`, `@data-pulse-2/db`.

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T010 | `[GATED]` | New inventory OpenAPI contract under `packages/contracts/openapi/inventory/**` — explicit approval, its own slice before any implementing GREEN (§IV/§VIII). |
| T013 | `[GATED]` | New `0014_inventory` SQL migration + Drizzle schema (`packages/db/drizzle/`, `packages/db/src/schema/inventory/`) — explicit approval, paired `*.down.sql`, lock-duration review (§VIII). |
| T001 | `[SIGN-OFF]` | Confirm quantity = string-backed exact-decimal value object adds **no `package.json` dependency** (R3, mirrors 008 gate A.6). If a big-decimal lib becomes necessary, that is a SEPARATE `[GATED]` `package.json` decision — STOP and request approval. |

The five owner decisions (negative-stock, quantity/unit, restock, product identity, idempotency) are already RESOLVED in [spec.md §Clarifications](./spec.md) (Session 2026-05-31); no further `[SIGN-OFF]` is needed for those.

## 3. User scenarios → task mapping

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) | Explain on-hand from the movement ledger (derived SUM + movement list) | T030–T034 |
| US2 (P1) | Record manual movements (inbound/outbound/adjustment, incl. write-off) | T040–T044 |
| US3 (P1) | Idempotent / replay-safe movement creation | T050–T053 |
| US4 (P2) | Sale-linked outbound via reference / backfill (decoupled, + worker tenant-context) | T060–T064 (incl. T063b) |
| US5 (P2) | Stock transfers between stores (linked movements) | T070–T073 |
| US6 (P2) | Stock count variance → correction movement | T080–T083 |
| (signal) | New negative-balance observability signal (flag + counter) | T045 |
| (restock) | Void/refund/return → manual/backfill restock | T090–T091 |
| (lifecycle) | §XIV data-class + retention guard | T095 |

---

## 4. Phase 1 — Setup (shared infrastructure)

- [ ] T001 [SIGN-OFF] Confirm the 009 branch is off latest `origin/main`; the `apps/api/src/catalog/{sales,reconciliation,unknown-items}/` modules compile clean; and the quantity representation (string-backed exact-decimal value object → `numeric(p,s)`) requires **no** `package.json` change (R3, mirrors 008 gate A.6). Predecessors: none. Acceptance: `pnpm --filter @data-pulse-2/api build` succeeds; decision recorded in wave-status that no dependency is added (if a big-decimal lib becomes necessary, raise a separate `[GATED]` request, do not add silently).
- [ ] T002 [P] Scaffold the new module directory `apps/api/src/inventory/` (empty `inventory.module.ts` registered in the app module wiring, mirroring `catalog/sales/sales.module.ts`). Predecessors: T001. Acceptance: module compiles and is registered; no routes yet.

## 5. Phase 2 — Foundational (blocking prerequisites for all user stories)

### 5.1 `[GATED]` inventory OpenAPI contract

- [ ] T010 [GATED] Request explicit approval, then author the new inventory OpenAPI contract under `packages/contracts/openapi/inventory/` (e.g. `inventory.yaml`) per [contracts/README.md](./contracts/README.md): operations **createStockMovement**, **getOnHand**, **listStockMovements**, **createStockTransfer**, **recordStockCount** (`cookieAuth` operator surface — NOT `/api/pos/v1/`); a separate platform/admin **backfillSaleLinkedMovements** path; stable `operationId`s; canonical `Error` envelope with the 009 category set (validation incl. cross-unit + zero/same-store transfer, not-found/safe-404, idempotency-conflict, rate-limited); `toBody` response projections (no raw DB entities, §IV) — the on-hand projection includes the `negative_balance` flag (FR-024); `Idempotency-Key` header on writes (FR-030). **Negative stock is NOT an error** (no 409/422 for going negative). Predecessors: T001. Acceptance: a `contract.spec` (mirroring 005/007/008 `sales.contract.spec.ts`) is GREEN — operations present + unique vs shipped, `cookieAuth` on operator ops, backfill on the admin path, `Idempotency-Key` on writes, Error envelope, strict schemas, no PII/payment field names; umbrella conformance GREEN (no operationId collision).
- [ ] T011 [GATED] [P] Confirm the new contract is discovered by the conformance-test entrypoint (register in the YAML registry if one exists). Predecessors: T010. Acceptance: conformance harness picks up the new operationIds.

### 5.2 `[GATED]` movement-ledger schema + migration

- [ ] T012 [P] [TC] RED test — `apps/api/test/inventory/schema/stock-movements-schema-shape.spec.ts`: assert (when the schema exists) `stock_movements` carries the [data-model.md](./data-model.md) Entity-1 field set — `movement_type` enum, `quantity numeric(p,s)`, `stocking_unit`, nullable `tenant_product_ref`, nullable provenance (`idempotency_key` lineage-only / `source_system`/`external_id`/`sale_id`/`sale_line_id`/`terminal_event_ref`), nullable `transfer_group_id`, nullable `stock_count_id`, `occurred_at`/`received_at` NOT NULL, NOT-NULL `tenant_id`/`store_id`, **exactly ONE movement-level dedup index** — the backfill partial-unique `(tenant_id, source_system, external_id)` where both NOT NULL (R4/FR-031); assert there is **NO** `(tenant_id, store_id, idempotency_key)` unique index (manual dedup lives in the 001/005 interceptor, NOT a movement index — FR-030 "no new primitive"); **NO `version` column** (R7); **no batch/expiry/serial column on the base movement** (FR-041); plus `stock_counts` Entity-4 fields. Predecessors: T001. Acceptance: test runs, fails (no schema yet).
- [ ] T013 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/inventory/stock-movements.ts`, incl. `stock_counts`) and the paired `0014_inventory.sql` / `0014_inventory.down.sql` migration: `quantity numeric(p,s)` exact-decimal (no float); `movement_type` enum (FR-002); **exactly ONE movement-level dedup index** — the backfill partial-unique `(tenant_id, source_system, external_id)` where both NOT NULL (FR-031); `idempotency_key` is a **lineage-only nullable column with NO unique index** (manual dedup is the reused 001/005 interceptor, FR-030); nullable `tenant_product_ref` FK→tenant_products (FR-023, R5 — no auto-create); nullable sale/terminal-event provenance refs (FR-032 — the 008 composite key keeps sale-linked refs tenant-scoped); **fail-closed RLS** `current_setting('app.current_tenant', true)::uuid` on every table; **NO `version` column** (R7); **NO batch/expiry/serial columns** on the base movement (FR-041 — the lot/serial seam is a future nullable FK only); migration header records the §XIV business-class + retention posture (the authoritative place this is written — see T095). Predecessors: T012, T010-style approval. Acceptance: T012 GREEN; migration applies + rolls back clean under Testcontainers; lock-duration reviewed.

### 5.3 Isolation-harness extension (blocking — serves all stories)

- [ ] T014 [P] [TC] Add inventory fixtures (movements across tenants A/B and stores X/Y; a sale-linked movement referencing an 008 captured sale; an ad-hoc NULL-product movement) in a new `apps/api/test/inventory/__support__/seed-inventory.ts`. MUST NOT modify the 003/008-owned isolation harness. Predecessors: T013. Acceptance: helper exports fixtures; existing isolation tests untouched and GREEN.
- [ ] T015 [TC] RED test — `apps/api/test/inventory/isolation/inventory-sweep.spec.ts`: cross-tenant/cross-store sweep for movement-create/on-hand-read/list/transfer/count per FR-050/051 — unauthenticated → 401; cross-tenant id → non-disclosing 404; out-of-scope store → 404; **raw-SQL RLS-bypass probe** (wrong `app.current_tenant` ⇒ zero rows) on `stock_movements` + `stock_counts`; malicious-override (body `tenant_id`/`store_id`/`created_by`/derived balance ignored, FR-052). Predecessors: T014. Acceptance: test runs, cases fail on missing operations (not on RLS).

---

## 6. Phase 3 — US1: Explain on-hand from the movement ledger (P1) 🎯 MVP

**Goal**: on-hand for a `(tenant, store, product)` is the compute-on-read signed SUM of its movements, and the movement list explains it.
**Independent test**: create inbound +10 then outbound −3 → on-hand = 7; list movements → stable order, sums to 7; store B independent of store A; empty key → deterministic zero.

- [ ] T030 [P] [US1] [TC] RED — `apps/api/test/inventory/on-hand/on-hand-derivation.spec.ts`: inbound +10 then outbound −3 for one `(T,S,product)` → on-hand = 7; the SUM is computed-on-read, not a stored mutable value (FR-003, SC-001). Predecessors: T013, T015. Acceptance: runs, fails (no route).
- [ ] T031 [P] [US1] [TC] RED — `on-hand/empty-and-isolation.spec.ts`: empty key → deterministic zero/"no record", not an error (FR-005); movements at store A do not affect store B's on-hand (US1 scenario 4). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T032 [P] [US1] [TC] RED — `on-hand/movement-list.spec.ts`: list movements for a key in **stable order** (e.g. `occurred_at`, `id` tiebreak), each showing type/signed-qty/timestamps/actor/reason/provenance refs; the listed movements sum to the reported on-hand (FR-004, SC-001). Predecessors: T013, T015. Acceptance: runs, fails.
- [ ] T033 [US1] GREEN — implement `getOnHand` (compute-on-read SUM) + `listStockMovements` in `apps/api/src/inventory/inventory.service.ts` + the `cookieAuth` routes in `inventory.controller.ts` (mapped to the T010 operationIds): resolve tenant/store from the authenticated principal; object-level store authz; `toBody` projection incl. the `negative_balance` flag; stable-order listing; reuse `with-tenant` helper. Predecessors: T030–T032, T010, T013. Acceptance: T030–T032 GREEN; OpenAPI conformance passes for `getOnHand`/`listStockMovements`.
- [ ] T034 [US1] [TC] GREEN-verify — extend the sweep (T015) for read paths: cross-tenant on-hand/list → non-disclosing 404 with no existence leak; RLS-bypass probe on `stock_movements` ⇒ zero rows (SC-006). Predecessors: T033. Acceptance: sweep read cases GREEN.

**Checkpoint**: on-hand + movement list are functional, isolated, and explainable — the MVP keystone.

---

## 7. Phase 4 — US2: Record manual movements (inbound / outbound / adjustment) (P1)

**Goal**: operators create inbound/outbound/adjustment movements (write-off = reason-coded outbound), append-only and audited.
**Independent test**: POST inbound, adjustment, outbound, write-off (reason-coded outbound) → each appended, carries the actor, writes an audit event, no prior movement mutated.

- [ ] T040 [P] [US2] [TC] RED — `apps/api/test/inventory/movements/inbound-outbound-adjust.spec.ts`: inbound (+, reason), outbound (−), adjustment (signed, mandatory reason) each appended; on-hand reflects each; an audit event per action (FR-010/011/012/013, SC-007). Predecessors: T033. Acceptance: runs, fails.
- [ ] T041 [P] [US2] [TC] RED — `movements/write-off.spec.ts`: a **reason-coded outbound** (damaged/expired/shrinkage) is recorded as an outbound distinguished by `reason` — not a new enum member (FR-002, spec §FR-002 write-off clause). Predecessors: T033. Acceptance: runs, fails.
- [ ] T042 [P] [US2] [TC] RED — `movements/append-only.spec.ts`: an adjustment is a **new** movement; no UPDATE/DELETE path exists for a historical movement (FR-001/012). Predecessors: T033. Acceptance: runs, fails.
- [ ] T043 [P] [US2] [TC] RED — `movements/cross-unit-reject.spec.ts`: a movement whose `stocking_unit` ≠ the product's stocking unit → 400, no record, no coercion (FR-022). Predecessors: T033. Acceptance: runs, fails.
- [ ] T044 [US2] GREEN — implement `createStockMovement` in `inventory.service.ts` + the `cookieAuth` route: strict `.strict()` Zod DTO (mass-assignment forbidden — `tenant_id`/`store_id`/`created_by`/derived balance, FR-052); resolve tenant/store/actor server-side; exact-decimal quantity in the product's stocking unit (cross-unit → 400, FR-022); resolve `tenant_product_ref` (nullable for ad-hoc, never auto-create, FR-023/R5); append-only insert; mandatory reason for adjustment; emit audit (FR-013) + outbox; return `toBody`. Predecessors: T040–T043, T010, T013. Acceptance: T040–T043 GREEN; conformance passes for `createStockMovement`.

---

## 8. Phase 5 — US3: Idempotent / replay-safe movement creation (P1)

**Goal**: a retried movement creation never double-applies; on-hand converges to single application.

- [ ] T050 [P] [US3] [TC] RED — `apps/api/test/inventory/idempotency/manual-replay.spec.ts`: same `Idempotency-Key` + same body ×N → exactly one movement, identical response, on-hand applied once (FR-030, SC-003). Predecessors: T044. Acceptance: runs, fails.
- [ ] T051 [P] [US3] [TC] RED — `idempotency/divergent-body.spec.ts`: same `Idempotency-Key` + different body → deterministic conflict (409), no side-effect (FR-030). Predecessors: T044. Acceptance: runs, fails.
- [ ] T052 [P] [US3] [TC] RED — `idempotency/provenance-dedup.spec.ts`: backfill/external movement with the same `(sourceSystem, externalId)` ×N → one movement, not double-applied (FR-031). Predecessors: T044. Acceptance: runs, fails.
- [ ] T053 [US3] GREEN — wire the dual dedup contract, two surfaces: **manual** = reuse the `Idempotency-Key` interceptor UNCHANGED (no new primitive, no movement-table index — `client_id` resolves to the operator `userId` via the interceptor's `clientId()`, FR-030); **backfill** = the movement-level partial-unique on `(tenant_id, source_system, external_id)` (FR-031); divergent-body manual replay → conflict (interceptor body-fingerprint). Predecessors: T050–T052. Acceptance: T050–T052 GREEN.

---

## 9. Phase 6 — US4: Sale-linked outbound via reference / backfill (P2) — DECOUPLED

**Goal**: an outbound movement references an 008 sale as provenance via explicit action or backfill, with NO dependency on the gated 008 live loop.
**Independent test**: with an 008 captured sale present (008 loop UNWIRED, `processed_at` NULL), create an outbound referencing `sale_id`/`sale_line_id` → provenance recorded, on-hand decremented, idempotent on the provenance pair, no event subscription needed.

- [ ] T060 [P] [US4] [TC] RED — `apps/api/test/inventory/sale-linked/outbound-reference.spec.ts`: outbound referencing a captured `sale_id`/`sale_line_id` → movement carries the provenance ref, on-hand decreases; the ref is visible on the movement list (FR-032, US4 scenarios 1/3). Predecessors: T044. Acceptance: runs, fails.
- [ ] T061 [P] [US4] [TC] RED — `sale-linked/decoupling.spec.ts`: with the 008 live loop **unwired** (`sale.captured` not an event type, `processed_at` NULL), every US1–US4 flow succeeds; the backfill reads the **captured** sale rows, never `processed_at`-stamped ones (FR-032/060, SC-002, R8). Predecessors: T044. Acceptance: runs, fails.
- [ ] T062 [P] [US4] [TC] RED — `sale-linked/backfill-idempotent.spec.ts`: re-running the sale-linked backfill converges to the same ledger state — no double-apply on the sale-ref provenance (FR-033). Predecessors: T044. Acceptance: runs, fails.
- [ ] T063 [P] [US4] [TC] RED — `sale-linked/ad-hoc-nullproduct.spec.ts`: a sale-linked outbound for an 008 ad-hoc line (no resolvable tenant product) → recorded with nullable `tenant_product_ref` as provenance; no catalog product auto-created; the movement rolls up to no product on-hand (FR-023, R5, data-model Entity-2 NULL-product note). Predecessors: T044. Acceptance: runs, fails.
- [ ] T063b [P] [US4] [TC] RED — `apps/api/test/inventory/sale-linked/backfill-worker-context.spec.ts`: the backfill worker MUST establish tenant context (`SET LOCAL app.current_tenant` inside the transaction) **before** any `stock_movements` read/write, and MUST carry `tenantId`/`storeId`/`correlationId` (§V); a raw-SQL **RLS-bypass probe** on a worker-written movement (wrong `app.current_tenant` ⇒ zero rows) (§VI worker tenant-context test). Predecessors: T044. Acceptance: runs, fails.
- [ ] T064 [US4] GREEN — implement the sale-linked outbound path (reference, on the `createStockMovement` route) + the platform/admin **backfill** worker path in `apps/worker/src/inventory/backfill.processor.ts` (reuse the outbox/worker + tenant-context helper; **establish tenant context before DB access** per §V; carry `tenantId`/`storeId`/`correlationId`; reads captured 008 `sales`/`sale_lines`; dedups on `(sourceSystem, externalId)`/sale-ref; never mutates the sale fact; never auto-creates a product; redact raw payloads in failed-job logs, §VII/§XIV). Predecessors: T060–T063, T063b, T013. Acceptance: T060–T063, T063b GREEN; conformance passes for the backfill path.

---

## 10. Phase 7 — US5: Stock transfers between stores (P2)

**Goal**: an intra-tenant transfer is linked outbound (source) + inbound (destination) movements, mutually discoverable.

- [ ] T070 [P] [US5] [TC] RED — `apps/api/test/inventory/transfer/transfer-happy.spec.ts`: transfer N from store A to B → outbound at A + inbound at B sharing a `transfer_group_id`; A on-hand −N, B +N; counterpart discoverable from either store (FR-020, SC-004). Predecessors: T044. Acceptance: runs, fails.
- [ ] T071 [P] [US5] [TC] RED — `transfer/cross-tenant-safe404.spec.ts`: transfer to a store in another tenant → non-disclosing 404, no movement created (FR-051). Predecessors: T044. Acceptance: runs, fails.
- [ ] T072 [P] [US5] [TC] RED — `transfer/negative-and-validation.spec.ts`: transfer-out driving source on-hand below zero → still recorded + negative-balance flag, never rejected (FR-024, US5 scenario 4); same-store or zero-quantity transfer → 400 (spec Edge Cases). Predecessors: T044. Acceptance: runs, fails.
- [ ] T073 [US5] GREEN — implement `createStockTransfer` in `inventory.service.ts` + the `cookieAuth` route: append linked `transfer_out`/`transfer_in` movements with a shared `transfer_group_id` in one transaction; same-tenant only (cross-tenant destination → safe-404); reject same-store/zero-quantity; allow-and-flag negative source; audit both legs. Predecessors: T070–T072, T010, T013. Acceptance: T070–T072 GREEN; conformance passes for `createStockTransfer`.

---

## 11. Phase 8 — US6: Stock count variance → correction movement (P2)

**Goal**: a physical count yields an append-only correction movement for any variance; history never rewritten.

- [ ] T080 [P] [US6] [TC] RED — `apps/api/test/inventory/count/count-variance.spec.ts`: derived on-hand 7, physical count 5 → a `count_correction` movement of −2 linked via `stock_count_id`; on-hand becomes 5; no prior movement altered (FR-021, SC-005). Predecessors: T044. Acceptance: runs, fails.
- [ ] T081 [P] [US6] [TC] RED — `count/zero-variance.spec.ts`: count == derived on-hand → deterministic documented behavior (no correction or explicit zero-variance record); history unchanged (US6 scenario 2). Predecessors: T044. Acceptance: runs, fails.
- [ ] T082 [P] [US6] [TC] RED — `count/correction-traceable.spec.ts`: the correction movement is identifiable as count-variance-sourced (`stock_count_id` set, reason/context) on the movement list (US6 scenario 3). Predecessors: T044. Acceptance: runs, fails.
- [ ] T083 [US6] GREEN — implement `recordStockCount` in `inventory.service.ts` + the `cookieAuth` route: capture `counted_quantity` + `derived_on_hand_at_count`; append a `count_correction` movement = signed variance linked via `stock_count_id`; document the zero-variance behavior; never rewrite history; audit. Predecessors: T080–T082, T010, T013. Acceptance: T080–T082 GREEN; conformance passes for `recordStockCount`.

---

## 12. Phase 9 — Negative-balance signal + restock + lifecycle (cross-cutting)

### 12.1 New observability signal (lands with the first outbound-below-zero path)

- [ ] T045 [P] [TC] RED→GREEN — `apps/api/test/inventory/signal/negative-balance.spec.ts`: an outbound driving on-hand below zero → the on-hand projection carries the `negative_balance` flag **and** a **new OpenTelemetry counter** (`meter.createCounter`) of negative-balance occurrences increments; never an error (FR-024, R2, plan §3.3). Then register the counter in `apps/api/src/observability/metrics/api.metrics.ts` alongside the existing registrars (follow the `meter.createCounter` + `assertMetricLabels` pattern; labels must be a CLOSED low-cardinality PII-free set — e.g. a `reason`-style label — **NOT** `tenant_id`/`store_id`, which the allowlist forbids). Predecessors: T044. Acceptance: flag present on the projection; counter registered (passes `assertMetricLabels`) + incremented; no parallel naming.

### 12.2 Void/refund/return → restock (manual/backfill)

- [ ] T090 [P] [restock] [TC] RED — `apps/api/test/inventory/restock/terminal-event-restock.spec.ts`: an inbound movement referencing an 008 void/refund terminal event (or a customer return) as provenance → recorded, on-hand increases, idempotent on the terminal-event provenance (FR-025, R6). Predecessors: T044, T064. Acceptance: runs, fails.
- [ ] T091 [restock] GREEN — implement the restock path as an inbound movement carrying `terminal_event_ref` (manual or via the backfill worker); idempotent on the provenance; **automatic** restock-on-void is NOT implemented (deferred with FR-060). Predecessors: T090. Acceptance: T090 GREEN; the deferral is recorded (no auto-restock route exists).

### 12.3 Data-lifecycle classification + retention (§XIV)

- [ ] T095 [lifecycle] [TC] Data-class + retention guard (§XIV) — `stock_movements` + `stock_counts` are **business-class** (catalog refs, quantities, provenance ids, reason text; **no PII/payment** in v1); retention **inherits the 001 long-horizon insert-only posture** for the immutable ledger; right-to-erasure **tombstones** any future PII field. The classification + retention header comment is **authored in the `0014` migration by T013** (009-SCHEMA owns that file) and the note already lives in `data-model.md`; T095 **verifies** the header is present (read-only — does NOT edit the landed migration) and adds the guard test `apps/api/test/inventory/lifecycle/classification.spec.ts` asserting no PII/payment-class field is persisted in v1. If a later slice admits a customer-reference field, this reclassifies and re-triggers. Predecessors: T013, T044. Acceptance: migration header verified present (not authored here); guard test GREEN.

---

## 13. Phase 10 — Polish & cross-cutting

- [ ] T100 [P] Performance check — on-hand read p95 ≤ 300 ms, movement creation p95 ≤ 400 ms at the SaaS boundary (plan §1.4); **report-only** if no perf env (005/008 precedent). Predecessors: T033, T044. Acceptance: load-test report recorded (`loadtests/k6/inventory-*.js`); no hard gate in v1.
- [ ] T101 [P] Per-tenant backfill bound — enforce the 500-movements/request ceiling on the sale-linked backfill path; over-ceiling → deterministic rejection; layered on the inherited 001/004 rate-limit posture (plan §1.5). Predecessors: T064. Acceptance: bound test GREEN; no unbounded backfill path.
- [ ] T102 [P] Seam design reviews — record SC-008 (auto-decrement addable without altering the v1 movement/on-hand schema) + SC-009 (lot/serial dimension addable without rewriting generic movements) verdicts in `wave-status.md`. Predecessors: T044. Acceptance: both design-review verdicts recorded; no schema change required to satisfy either.
- [ ] T103 Coverage + full suite — ≥80% on the new inventory module; full api suite green. Predecessors: T034, T053, T064, T073, T083, T045, T091, T095. Acceptance: coverage gate met; suite GREEN under WSL Testcontainers.
- [ ] T104 Closeout — reconcile `execution-map.yaml` / `wave-status.md` to terminal status with provenance. Predecessors: T103. Acceptance: map reconciled.

---

## Dependencies & execution order

### Phase dependencies

- **Setup (Ph1)**: no dependencies.
- **Foundational (Ph2)**: depends on Setup; **BLOCKS all user stories**. Within it: T010 (`[GATED]` contract) and T013 (`[GATED]` schema/migration) are the hard gates; T014/T015 (isolation harness) depend on T013.
- **US1 (P1)**: depends on Foundational; the MVP keystone (on-hand + list).
- **US2/US3 (P1)**: depend on US1's read path (T033) — US2 creates movements, US3 hardens idempotency on the create path (T044).
- **US4/US5/US6 (P2)**: depend on US2's create path (T044). US4 (sale-linked/backfill) also gates the restock path (T090/T091).
- **Signal (T045)**: depends on US2's create path (T044).
- **Restock (T090/T091)**: depends on US2 (T044) + US4 (T064 backfill worker).
- **Lifecycle (T095)**: depends on T013 + T044.
- **Polish (Ph10)**: depends on the desired stories being complete.

### `[GATED]` ordering (hard)

T010 (OpenAPI) and T013 (migration/schema) each require explicit approval and land as their own slices **before** any GREEN implementing task. T001's `[SIGN-OFF]` (no `package.json` dependency) must hold; if a big-decimal library becomes necessary, STOP and raise a separate `[GATED]` request.

### Parallel opportunities

- Ph2: T010 ∥ T012 (contract vs schema-shape RED test) until T013 GREEN.
- Within each story: all `[P]`-marked RED tests run in parallel; the single GREEN task per story follows.
- US4/US5/US6 are **dependency-independent** (each needs only T044) but their GREEN tasks all write the shared `apps/api/src/inventory/inventory.service.ts`, so they are **NOT safely parallel in a shared worktree** (parallel agents share git worktree state even with disjoint file scopes — see project memory `feedback_parallel_agent_git_worktree`). Dispatch them **serially**, or use `git worktree add` for true isolation. The execution-map marks each `parallel_safety: serialize` for this reason.

---

## Implementation strategy

- **MVP = US1 (on-hand + movement list)** + its Foundational prerequisites (T010, T013, T014, T015). That alone delivers a durable, isolated, explainable inventory read — the keystone the rest of the domain builds on.
- **Increment**: add US2 (manual movements) to make the ledger writable, US3 (idempotency) to make it retry-safe, then US4 (sale-linked/backfill — the decoupling proof), US5 (transfers), US6 (counts), then the negative-balance signal, restock, lifecycle guard, and polish.
- **Test-first throughout** (Constitution §VI): RED → GREEN per task; cross-tenant/cross-store sweep + RLS-bypass probe are mandatory, not optional.
- **Decoupling is load-bearing**: every flow must pass with the 008 live loop unwired (T061). The sale-linked backfill reads **captured** sale rows.
- **No `[GATED]` artifact runs without approval**: the OpenAPI contract and the `0014` migration are separate approval-gated slices.

---

## Task summary

- **Total**: 45 tasks (T001–T002 setup; T010–T015 foundational incl. 2 `[GATED]`; T030–T083 + T063b the six user stories; T045 signal; T090–T091 restock; T095 lifecycle; T100–T104 polish).
- **Per story**: US1=5 (T030–T034), US2=5 (T040–T044), US3=4 (T050–T053), US4=6 (T060–T064 incl. T063b worker tenant-context), US5=4 (T070–T073), US6=4 (T080–T083).
- **`[GATED]`**: 2 (T010 OpenAPI, T013 migration/schema) + 1 `[SIGN-OFF]` (T001 no-dependency).
- **New observability signal**: 1 (negative-balance flag + a new OpenTelemetry `meter.createCounter` in `api.metrics.ts`, T045).
- **MVP scope**: US1 + Foundational.
- **Parallel**: all per-story RED tests `[P]`; US4 ∥ US5 ∥ US6; contract ∥ schema-shape in Foundational.
