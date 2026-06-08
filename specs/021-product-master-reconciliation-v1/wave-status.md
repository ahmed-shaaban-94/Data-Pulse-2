# Wave Status — `021-product-master-reconciliation-v1`

> Human-readable summary of where the spec stands. 021 is the **product-master
> reconciliation** surface — 017's **run → report → repair** shape applied to
> 013's product/item mapping (the inverse of 014's stock reconciliation). It
> reconciles the DP2 product master against ERPNext items over 013's
> `erpnext_item_map`.

**Last updated:** 2026-06-08 by Ahmed Shaaban — **FULL IMPLEMENTATION on `feat/wave-020-021-025-impl`** (US1 + US2 + US3 + foundation + polish). Planning chain previously MERGED to `main` via PR #525 (squash `75d9967`).
**Spec:** `021-product-master-reconciliation-v1` (`specs/021-product-master-reconciliation-v1/`)
**Base:** `main` (shared impl branch `feat/wave-020-021-025-impl`).
**Status:** **IMPLEMENTED — pending PR/merge.** `[GATED]` SCHEMA + migration `0023` + `[GATED]` contract authored; full api module (US1 backlog read-projection, US2 repair-via-013-lifecycle, US3 stub-tolerant two-sided run) + worker run processor/consumer shipped. Tests RED→GREEN (see below).

### Migration number — RESOLVED to `0023` (NOT the indicative `0022`)
The indicative `0022` collided with 020's `connector_health` (issue #520). In authoring/merge order the **020 agent took `0022`**, so 021 takes **`0023_erpnext_product_reconciliation`** — appended at the EXPECTED_MIGRATIONS tail (no #447-class mid-array insert). Collision resolved.

### Implementation summary (2026-06-08)
- **Foundation:** `[GATED]` Drizzle schema `packages/db/src/schema/catalog/erpnext-product-reconciliation.ts` (run + result + append-only repair_attempt) + migration `0023` (+down); RLS ENABLE+FORCE, empty-GUC CASE guard, SELECT/INSERT/UPDATE on run+result, INSERT+SELECT on repair_attempt, NO DELETE policy, all CHECKs. `[GATED]` `packages/contracts/openapi/catalog/product-reconciliation.yaml` (5 operationIds, cookieAuth, `/api/v1/catalog/erpnext-product-reconciliation`). Registries: EXPECTED_MIGRATIONS (+`0023`), EXPECTED_CATALOG_MODULES (+`erpnext-product-reconciliation`), schema barrel, `OUTBOX_EVENT_TYPES.ERPNEXT_PRODUCT_RECONCILIATION_REQUESTED`, the `erpnext_product_reconciliation_total` §VII signal (api.metrics.ts 3-place + shared ALLOWED_METRIC_LABELS), app.module.
- **US1:** live backlog read-projection (003 ⟕ 013 confirmed-only-and-active) — NO 021 table write.
- **US2:** repair drives 013's EXISTING lifecycle via new client-accepting `ErpnextItemMapService.{confirm,suggest,retire}OnClient` variants on 021's OWN transaction, composing the 013 transition + `repair_attempt` + an in-tx `INSERT INTO audit_events` ATOMICALLY (FR-015). A `conflict` outcome COMMITS its attempt (thrown AFTER the tx). 021 issues NO direct write to `erpnext_item_map`.
- **US3:** stub-tolerant two-sided run — connector item-view seam (port + EMPTY stub + recorded-view test adapter); worker processor + outbox consumer (registered in worker.module drainer seam over the EMPTY stub). Absent view → `erpnext_view_status='unavailable'`, DP2-side classes only, NO fabricated `unmapped_erpnext_item`.
- **Tests (RED→GREEN, WSL Testcontainers + Docker-free):** contract conformance 19/19; schema-shape 12/12; signals/§XIV data-class 9/9; worker-obs regression 161/161; `0023` migration round-trip 17/17; barrel + migrate-CLI drift guards 19/19; US1+US2 backlog-repair 6/6; **US2 atomicity (T023, DB-trigger-induced audit failure) PASS**; US3 run processor 4/4; **HTTP/controller 9/9** (triggerRun 201 + in-tx outbox emit, listRuns, getRunResults + foreign-404, repair 201/200/409/400 envelopes, result-repair wiring); 013 regression 46/46 (the `*OnClient` refactor is backward-compatible).

### In-scope deferrals / notes
- **`repairResult` (US3 result-repair) IS wired:** the `repairProductMapping` request takes optional `runId`+`resultId` (supplied together; XOR → 400); when present the repair targets a persisted US3 result and transitions `result_state open→repaired` on a `mapped` outcome. Contract + DTO + controller branch + HTTP test cover it.
- **`attribute_drift` class:** in the vocabulary / CHECK / contract enum but the v1 processor does not yet EMIT it (it needs ERPNext-side attribute values from the live item view). Deferred to `021-ITEM-VIEW-CONTRACT` (#524) — not a bug; the class exists so the persisted-report shape is forward-compatible.
- **`execution-map.yaml`:** intentionally not authored — the planning chain never produced one (wave-status is the slice ledger); the implementation tracks tasks T001–T041 against this wave-status instead.
- **`021-SCHEDULED-RUNS`:** scheduled-cadence runs over the same processor — a later wiring deferral (the 017 `017-SCHEDULED-RUNS` precedent).

### Artifacts on `main`
`spec.md` (3 US, 20 FR, 7 SC) · `plan.md` (Constitution Check §I–XIV) · `research.md` (R1–R10) · `data-model.md` (`[GATED]` run / result / append-only repair_attempt; prose-only) · `tasks.md` (41 tasks, `[GATED]` flags) · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 5 LOW) · `review.md`.

### Key resolved design decisions
- **READ-NOT-MUTATE / not an authority handover (§IX):** 021 reads + repairs over 013's existing `erpnext_item_map` lifecycle; owns **no new mapping primitive**.
- Mirrors 017's run→report→repair; cookieAuth/DashboardAuthGuard **human-only** (NOT connectorBearer).
- New `[GATED]` `0022_erpnext_product_reconciliation` table family (indicative number — **collides with 020's indicative `0022`**, see #520) + `[GATED]` `product-reconciliation.yaml`.
- **MVP (US1) is connector-free.** US3 (`unmapped_erpnext_item`, `attribute_drift`) is **stub-tolerant** — inert until the live ERPNext-item view ships.

### Deferrals / blockers
- **MED finding F3 (cross-system, BLOCKS US3):** the live ERPNext-item read is external/gated — `021-ITEM-VIEW-CONTRACT`, tracked under the **live-leg frontier epic, issue #524**. v1 ships the run skeleton + DP2-side classes only (honest 017-style split).
- **Migration-number collision** with 020 — tracked as **issue #520**.

### Next recommended action
Open the PR from `feat/wave-020-021-025-impl`; verify `db-integration` manually (main has no branch protection — CI advisory). Post-merge, the only remaining 021 frontier is the **live ERPNext-item read** (`021-ITEM-VIEW-CONTRACT`, gated under epic #524) — v1 ships stub-tolerant. `021-SCHEDULED-RUNS` (a scheduled sweep over the same processor) is a later wiring deferral.
