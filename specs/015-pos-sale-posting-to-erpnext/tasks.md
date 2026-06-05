<!--
  /speckit-tasks output for 015 POS Sale Posting to ERPNext.
  PLANNING-ONLY artifact: this is the ordered task list. It authorizes no implementation.
  [GATED] tasks require explicit per-slice approval before they run (Constitution §IV/§VIII, Standing Rules §3).
  [SIGN-OFF] tasks are owner decisions recorded before dependents run.
  Authoring this file (and execution-map.yaml) does NOT authorize the first dispatch — the first slice
  touching packages/db / packages/contracts/openapi / apps/api is a new threshold the owner crosses explicitly.
-->

# Tasks: POS Sale Posting to ERPNext

**Feature**: 015-pos-sale-posting-to-erpnext | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Data model**: [data-model.md](./data-model.md) | **Contract (fixed, read-only)**: [`erpnext-connector/posting-feed.yaml`](../../packages/contracts/openapi/erpnext-connector/posting-feed.yaml)

---

## 0. TL;DR — the DP2 side of the fixed 012 posting feed, in the interim SI-only mode

015 turns a **processed** 008 sale (and its void/refund terminal events) into ERPNext accounting truth by serving the **fixed 012 pull/feed contract**: DP2 exposes pending posting work-items (`connectorPullPostings`) and ingests outcomes (`connectorAckOutcome`). The connector (separate repo, ADR 0008) is the only ERPNext-calling component; **DP2 makes no outbound HTTP calls**. 015 adds a new `apps/api` posting module + a worker consumer + **one new `[GATED]` `erpnext_posting_status` table** ([data-model.md §5](./data-model.md#5-gated-state-erpnext_posting_status)). Posting-time item/warehouse resolution (`015-RESOLVE`) is **DP2-side**; an unresolvable line/store **fails-to-DLQ before offer**. The reconciliation run + DLQ drain + repair is **017**.

**Ratified decisions (owner rider 011-DR-POSTING-R1, 2026-06-05):**
- **OQ-7 (R1)** — first slice posts **submitted Sales Invoice only** (outstanding AR); **gated**, **not finance-complete**. Payment Entry is a later, separately-gated arc.
- **OQ-8-bis (R2)** — **DP2 resolves** line→Item at projection; connector never guesses. Gated on `SaleLine.erpnextItemRef` — **satisfied** (#494).
- **OQ-5 (R3)** — disabled/non-sales Item → fail-to-DLQ, no substitute; sellability stays DP2-authoritative.
- **OQ-6 (R4)** — unknown-items ≠ unmapped-for-posting; never route posting failures to the unknown-items queue.
- **OQ-8 (R5)** — no resolved warehouse → fail-to-DLQ (`unmapped_store`); never guess. *(014 map is on `main` — unhappy path only.)*

**Prerequisites satisfied on `main` (verified 2026-06-06):** 008-LIVELOOP (#496/#497 — `processed_at` set off-request), 014-CRUD (#495 — `erpnext_warehouse_map`/`0018`), 012 `erpnextItemRef` (#494).

## 1. Conventions

- **Checklist format**: `- [ ] [TaskID] [P?] [Story?] Description (file path).`
- **Labels**: `[P]` parallelizable; `[GATED]` requires explicit approval (forbidden path); `[TC]` Testcontainers/real-Postgres (run via WSL per `reference_007_test_env`); `[SIGN-OFF]` an owner decision recorded before dependents run.
- **TDD**: every implementing task is preceded by a RED test and made GREEN (Constitution §VI). Coverage ≥80%.
- **Auth (CONTRACT)**: the posting feed/ack is a **machine** surface → the **`connectorBearer`** scheme (the fixed 012 contract; opaque-revocable, tenant-scoped). **NOT** `clerkJwt`/`posDeviceAuth` (device) and **NOT** `cookieAuth` (human dashboard). 015 consumes this auth as fixed.
- **No outbound HTTP from DP2**: DP2 exposes the feed + ingests the ack; the connector posts to ERPNext. No ERPNext/Frappe client lands in DP2 (a connector-only, separately-`[GATED]` concern).
- **Money**: exact-decimal string + ISO-4217 end-to-end, no float (§III); DP2 amounts authoritative.
- **The 012 `posting-feed.yaml` is a READ-ONLY input** — never edited by 015 (any change is its own `[GATED]` 012 slice).

## 2. Approval-gated tasks (`[GATED]`) and decision-gated tasks (`[SIGN-OFF]`)

| Task | Type | Gate |
|---|---|---|
| T001 | `[SIGN-OFF]` | **`015-SIGNOFF-STATE`** — confirm the [data-model §2](./data-model.md#2-the-load-bearing-decision--state-table-vs-derive-on-read) decision: a **new `[GATED]` `erpnext_posting_status` table** (NOT derive-on-read — there is no source for `documentRef` / posting status; derive-on-read cannot satisfy O-3). Mirrors `010-SIGNOFF-READONLY`. Must be recorded before T012 dispatches. |
| T002 | `[SIGN-OFF]` | Confirm the **interim SI-only mode** (rider R1): the first slice posts a submitted Sales Invoice only (outstanding AR), **gated** + **not finance-complete**; **no Payment Entry / tender** state or payload. Deriving a PE from `posTotal` is STOP-and-raise. |
| T003 | `[SIGN-OFF]` | Confirm 015 produces the **`permanently_rejected` / DLQ state only**; the reconciliation **run + drain + repair** is **017** (not built in 015). |
| T010 | `[GATED]` | **`erpnext.posting.requested`** registered in `OUTBOX_EVENT_TYPES` (`packages/db/src/outbox/producer.ts`) — the 008-LIVELOOP `sale.captured` (#496) precedent. Explicit approval, its own slice. |
| T012 | `[GATED]` | New **`erpnext_posting_status`** Drizzle schema + migration (`packages/db/**`, next number after `0018` — **`0019`** indicative) incl. RLS + the O-3 idempotency unique. Paired `*.down.sql`, lock-duration review (§VIII). |

> **No 012 contract task.** The DP2-side feed/ack implements the **fixed** `posting-feed.yaml`; the rider-R2 `erpnextItemRef` correction it needed is already on `main` (#494). Any further contract change (future payment/tender extension, item-search auto-match) is a separate `[GATED]` 012 slice — out of 015.

## 3. User scenarios → task mapping

> **Derived stories.** The 015 spec is a narrative planning spec — it declares no `US#`/`P#` user stories. US1–US4 below are **derived** from the spec's design areas: US1 ← §6 transport feed (+ §5.1 1:1 SI), US2 ← §6 ack + §8 idempotency, US3 ← §5.4 void/refund reversal, US4 ← §7 015-RESOLVE failure posture. Priorities (P1 MVP → P3) reflect build order, not spec-stated priorities.

| Story | Scope | Tasks |
|---|---|---|
| US1 (P1) 🎯 MVP | **Serve the posting feed (happy path)**: a processed sale with all lines resolvable + store mapped → a `sale_post` `PostingWorkItem` on `connectorPullPostings`, cursor-ordered, self-sufficient (O-1), interim SI-only | T030–T034 |
| (cross-cutting P1) | **Isolation & non-disclosure**: tenant RLS on `erpnext_posting_status`, RLS-bypass probe, cross-tenant `workItemRef`/cursor → non-disclosing 404 | T020 |
| US2 (P2) | **Ingest outcomes** (`connectorAckOutcome`): record `posted`+`documentRef` / `failed_transient` / `permanently_rejected`; idempotent ack (O-3, reuses `Idempotency-Key`); never mutate the sale fact | T040–T043 |
| US3 (P3) | **Reversals**: void/refund terminal event → a `reversal` work-item (`reversalOf` provenance); multiple reversals per sale supported (data-model §5) | T050–T052 |
| US4 (P3) | **`015-RESOLVE` failure posture**: unmapped line / ad-hoc line / disabled Item / unmapped store → fails-to-DLQ before offer, `permanently_rejected` + reconciliation flag; sale fact never mutated; not routed to unknown-items | T060–T063 |
| (consumer, NOT 015) | **DLQ drain + reconciliation run + repair API** | — belongs to **017** |
| (later, gated) | **Payment Entry posting** | — separate arc (rider R1): tender model → 012 payment extension → connector PE → payment repair |
| (polish) | observability (§VII signals), coverage, closeout | T090–T092 |

---

## 4. Phase 1 — Setup

- [ ] T001 [SIGN-OFF] Record the **`015-SIGNOFF-STATE`** decision (a new `[GATED]` `erpnext_posting_status` table, NOT derive-on-read — [data-model §2](./data-model.md#2-the-load-bearing-decision--state-table-vs-derive-on-read)). Predecessors: none. Acceptance: decision recorded in [wave-status.md](./wave-status.md); the rejected derive-on-read alternative + the O-3/`documentRef` rationale captured; no implementing slice dispatches before it.
- [ ] T002 [SIGN-OFF] Confirm the **interim SI-only mode** (rider R1): no Payment Entry / tender state or payload in 015; PE is a later separately-gated arc; deriving a PE from `posTotal` is STOP-and-raise. Predecessors: T001. Acceptance: recorded in wave-status; no tender/payment column in any 015 allowed-files set.
- [ ] T003 [SIGN-OFF] Confirm 015 produces the **DLQ / `permanently_rejected` state only**; the reconciliation run + drain + repair is **017**. Predecessors: T002. Acceptance: recorded; no scheduled-job/repair-API file in any 015 allowed-files set.
- [ ] T004 [P] Scaffold the new `apps/api/src/catalog/erpnext-posting/` module (empty `erpnext-posting.module.ts` registered in `apps/api/src/app.module.ts`, mirroring `erpnext-item-map.module.ts`). Predecessors: T003. Acceptance: `pnpm --filter @data-pulse-2/api build` green; module registered; no routes yet; existing catalog modules still compile.

## 5. Phase 2 — Foundational (`[GATED]`; block all capability slices)

> Per [data-model.md](./data-model.md): the `[GATED]` `erpnext_posting_status` table (§5) and the `[GATED]` `erpnext.posting.requested` event-type (§7) are prerequisites. They touch **disjoint** surfaces within `packages/db/**` (a schema/migration vs the outbox event-type registry) and are dispatch-order-independent between themselves, but both block the feed/ack capability slices. The feed cursor IS the table's monotonic `sequence` — so the schema is **FOUNDATIONAL** (blocks US1 *and* US2), not US-local.

### 5.1 `[GATED]` `erpnext.posting.requested` outbox event-type

- [ ] T010 [GATED] Request explicit approval, then register `OUTBOX_EVENT_TYPES.ERPNEXT_POSTING_REQUESTED = "erpnext.posting.requested"` in `packages/db/src/outbox/producer.ts` (mirrors the 008-LIVELOOP `SALE_CAPTURED` registration, #496). Predecessors: T004. Acceptance: event-types registry spec updated (append to `EXPECTED_EVENT_TYPES`, the #447-class CI guard — see `reference_migration_test_gotchas`); `pnpm --filter @data-pulse-2/db build` green.

### 5.2 `[GATED]` `erpnext_posting_status` schema + migration

- [ ] T012a [P] [TC] RED — schema-shape spec asserting (when the schema exists) `erpnext_posting_status` carries the [data-model §5](./data-model.md#5-gated-state-erpnext_posting_status) field set: `tenant_id`/`store_id`/`sale_id`/`source_ref_id` NOT NULL, `kind` enum, `source_system`/`external_id`, `payload_hash char(64)`, `status` enum, nullable `document_ref`, nullable `rejection_category`, `retry_count`, nullable `reversal_of_sale_id`, `sequence bigint IDENTITY`; **fail-closed RLS** (empty-GUC CASE guard, mirror 0012/0017). Predecessors: T004. Acceptance: test runs, fails (no schema yet).
- [ ] T012 [GATED] GREEN — request explicit approval, then author the Drizzle schema (`packages/db/src/schema/catalog/erpnext-posting-status.ts`), the barrel re-export, and the paired `00NN_erpnext_posting_status.sql` / `.down.sql` migration (next free number after `0018` — **`0019`** indicative; confirm at authoring): the table per [data-model §5](./data-model.md#5-gated-state-erpnext_posting_status) — **O-3 idempotency unique `(tenant_id, source_system, external_id)`** (the originating row's own pair, supporting multiple reversals per sale — data-model §5 reversal-cardinality note); `status`/`kind` CHECK enums; fail-closed RLS (SELECT + INSERT + UPDATE policies on `app.current_tenant`, empty-GUC CASE guard); the `sequence` IDENTITY for cursor ordering; indexes for the pending-feed scan + the `(tenant, source, external)` dedup. **No money column.** Predecessors: T012a, T001 (state decision), T010-style approval, data-model.md. Acceptance: T012a GREEN; migration applies + rolls back clean (UP→DOWN→UP) under Testcontainers; the unique permits two reversals of the same sale (distinct `external_id`) but rejects a duplicate post of the same originating row; lock-duration reviewed; **two-allowlist regression handled** — append `0019_erpnext_posting_status` to `cli/migrate.spec EXPECTED_MIGRATIONS` AND `erpnext-posting-status` to the catalog barrel spec (the #487-class CI break — see `reference_migration_test_gotchas`).

### 5.3 Isolation-harness extension (blocking — serves the capability slices)

- [ ] T020 [P] [TC] RED→GREEN — `erpnext_posting_status` isolation: a raw-SQL **RLS-bypass probe** (wrong `app.current_tenant` → zero rows; unset GUC → fail-closed + INSERT denied), a **cross-tenant sweep** (tenant B cannot read/ack tenant A's posting row → non-disclosing 404 on `workItemRef`/cursor). Seed via a new `seed-posting-status.ts` (mirror `seed-item-map.ts`; do **NOT** touch the 003-owned `isolation-harness.ts`). DB-layer GREEN (characterises the shipped `0019` RLS — mirrors 013/014 ISOLATION-HARNESS). Predecessors: T012. Acceptance: GREEN under WSL Testcontainers; probe present.

## 6. Phase 3 — US1 (P1) 🎯 MVP: serve the posting feed (happy path)

- [ ] T030 [P] [TC] [US1] RED — `connectorPullPostings` projects a **processed** sale (all lines resolve to a confirmed `erpnext_item_map`; store maps via `erpnext_warehouse_map`) into a `sale_post` `PostingWorkItem` (012 schema): `workItemRef`=row id, full `Sale` projection with each line carrying `erpnextItemRef` (O-1 self-sufficiency); cursor-ordered by `sequence`; a sale with NULL `processed_at` is **absent** (not errored). Predecessors: T010, T012, T020. Acceptance: RED (no controller yet).
- [ ] T031 [US1] GREEN — `erpnext-posting.controller.ts` (`connectorPullPostings` GET) + `erpnext-posting.service.ts` feed projection + `posting-work-item.projection.ts`; `connectorBearer`-scoped, tenant context via `runWithTenantContext`; cursor-paginated/ordered/gap-detectable (mirrors 010 read-down delta); a bounded per-pull page ceiling (009/010 precedent). Predecessors: T030. Acceptance: T030 GREEN; re-pulling the same `since` cursor yields the same logical set (idempotent replay).
- [ ] T032 [P] [TC] [US1] RED→GREEN — the posting trigger: `erpnext.posting.requested` (T010) emitted in-transaction when a sale becomes processed → a `pending` `erpnext_posting_status` row; the worker consumer (`apps/worker/src/erpnext-posting/posting-requested.consumer.ts`) mirrors `SaleCapturedConsumer` (deterministic jobId dedupe). Predecessors: T031. Acceptance: a processed sale lands exactly one `pending` row; re-delivery does not double-insert (O-3).
- [ ] T033 [P] [TC] [US1] RED→GREEN — money + temporal fidelity in the projection: exact-decimal string money, no float (§III); DP2 amounts verbatim; `businessDate` carried (→ ERPNext `posting_date`, §X). Predecessors: T031. Acceptance: a delayed sale projects its original `businessDate`; no float anywhere.
- [ ] T034 [P] [TC] [US1] RED→GREEN — §XII object safety on the feed: cross-tenant/foreign-scope `workItemRef` or cursor → non-disclosing 404; stale/unservable cursor → `snapshot_required` (409); unauthenticated → 401. Predecessors: T031. Acceptance: GREEN per the 012 error envelope.

## 7. Phase 4 — US2 (P2): ingest outcomes (`connectorAckOutcome`)

- [ ] T040 [P] [TC] [US2] RED — the ack records the outcome on `erpnext_posting_status` (never the sale fact): `posted` requires + stores `documentRef`; `failed_transient` → back to `pending` (bumped `retry_count`, no new doc); `permanently_rejected` → `rejection_category` + reconciliation flag. Predecessors: T031. Acceptance: RED (no ack op yet).
- [ ] T041 [US2] GREEN — `connectorAckOutcome` (`POST /…/{workItemRef}/outcome`) on the controller/service; updates the status row under tenant context; `document_ref` set on `posted`; the 008 sale fact untouched (§IX). Predecessors: T040. Acceptance: T040 GREEN.
- [ ] T042 [P] [TC] [US2] RED→GREEN — idempotency (O-3, §XI): reuse the existing `Idempotency-Key` interceptor; re-acking the same logical outcome replays deterministically (200, echoes the existing `documentRef`); a different outcome for the same key → 409 `idempotency_key_conflict`; a re-pull after `posted` does NOT re-offer. Predecessors: T041. Acceptance: GREEN; exactly-one document per originating row across retries.
- [ ] T043 [P] [TC] [US2] RED→GREEN — §XII on the ack: body-supplied `tenant_id`/`store_id`/server-owned fields rejected (strict DTO); scope resolves from the `connectorBearer` principal; cross-tenant `workItemRef` → non-disclosing 404. Predecessors: T041. Acceptance: GREEN.

## 8. Phase 5 — US3 (P3): reversals (void / refund → reversing document)

- [ ] T050 [P] [TC] [US3] RED — a `sale_voids` / `sale_refunds` terminal event projects into a `reversal` `PostingWorkItem` carrying `reversalOf` (the original sale's provenance + `reversalKind` void|refund); the original `sale_post` row is untouched (§IX, append-only). Predecessors: T031. Acceptance: RED.
- [ ] T051 [US3] GREEN — the reversal projection path (the feed offers a `reversal` work-item per terminal event); the trigger creates a `pending` row per terminal event keyed by the **terminal event's own** `(source_system, external_id)` (data-model §5). Predecessors: T050. Acceptance: T050 GREEN.
- [ ] T052 [P] [TC] [US3] RED→GREEN — **multiple reversals per sale**: two partial refunds of one sale produce two distinct `reversal` rows (distinct `external_id`), both postable; a sale both voided and refunded produces two reversals — neither blocked by the O-3 unique. Predecessors: T051, T012. Acceptance: GREEN (the reversal-cardinality guarantee, data-model §5).

## 9. Phase 6 — US4 (P3): `015-RESOLVE` failure posture (fails-to-DLQ)

- [ ] T060 [P] [TC] [US4] RED — unmapped line → fails-to-DLQ **before offer**: a line whose `tenant_product_id` has no confirmed `erpnext_item_map` (or only a `suggested` one) → the sale is NOT offered; a `permanently_rejected` row with `rejection_category=unmapped_item` + reconciliation flag; the 008 sale fact untouched. Predecessors: T031, T012. Acceptance: RED.
- [ ] T061 [US4] GREEN — `015-RESOLVE` in `posting-work-item.projection.ts`: confirmed-only line resolution; unresolvable line → `permanently_rejected` (no offer, no substitute item — rider R3); ad-hoc line (null `tenant_product_id`) → same posture. Predecessors: T060. Acceptance: T060 GREEN.
- [ ] T062 [P] [TC] [US4] RED→GREEN — unmapped store → fails-to-DLQ (`rejection_category=unmapped_store`; never guess a warehouse — rider R5); disabled/non-sales ERPNext Item → fails-to-DLQ (`validation`/`unmapped_item`), operational sellability unaffected (rider R3). Predecessors: T061. Acceptance: GREEN.
- [ ] T063 [P] [TC] [US4] RED→GREEN — a posting failure is **NOT** routed into the inbound unknown-items queue (rider R4 / OQ-6 — separate operational states); it surfaces only as a reconciliation flag (017 consumes it). Predecessors: T061. Acceptance: GREEN; no write to the unknown-items surface from a posting failure.

## 10. Phase 7 — Polish

- [ ] T090 [P] Observability (§VII / G7): the posting feed/worker emit structured logs + the §VII signals (queue lag, failed-job rate, **reconciliation mismatch rate**, **DLQ depth**) carrying `correlationId`/`tenantId`; raw payloads never logged. The **surfacing seam is 017**; 015 emits the signals. Predecessors: T041, T061. Acceptance: signals registered (shared `api.metrics.ts`/`worker.metrics.ts`, not a per-feature file); no secrets/PII in logs.
- [ ] T091 [P] Perf (report-only, no perf env — 005/008/009/010 precedent): a k6 scenario for the pull feed under load; thresholds carried, not gating. Predecessors: T031. Acceptance: scenario authored; report-only.
- [ ] T092 Coverage ≥80% for the new module + worker; closeout (execution-map + wave-status terminal). Predecessors: T090, T091. Acceptance: coverage gate; map/wave-status reconciled.

---

## 11. Consumers / later arcs (NOT 015 slices)

- [ ] T100 [PROPOSED — 017] **DLQ drain + reconciliation run + repair API**: 017 reads 015's `permanently_rejected` rows + reconciliation flags, surfaces the mismatch reports, and exposes the repair re-post workflow (a repair must resolve to the same `document_ref` — idempotency holds across repair). **Not dispatchable in 015** — 017 has no spec yet. Traceability only.
- [ ] T101 [PROPOSED — later, separately gated] **Payment Entry posting** (completing the signed target, rider R1): requires a DP2 tender/payment fact model → a `[GATED]` 012 posting-feed payment/tender extension → connector idempotent PE creation → payment repair semantics. STOP-and-raise if attempted before these land. Traceability only.

---

## 12. Findings (carried into the execution map)

- **Reversal cardinality** (data-model §5) — the O-3 idempotency unique is keyed on the **originating row's own** `(tenant_id, source_system, external_id)` (a sale's for `sale_post`, the terminal event's for `reversal`), mirroring 008's per-table dedup. Keying on the parent sale would wrongly permit only one reversal per sale and **permanently block a 2nd partial refund** — verified against `0012` (`sale_voids`/`sale_refunds` are append-only with their own per-row unique). T052 guards this explicitly.
- **State decision is a `[SIGN-OFF]`, not pre-approved** (T001 / `015-SIGNOFF-STATE`) — derive-on-read is infeasible (no source for `documentRef` / posting status; cannot satisfy O-3), so a new `[GATED]` table exists; recorded as an owner decision before `015-SCHEMA` (T012) dispatches, mirroring `010-SIGNOFF-READONLY`.
- **Interim SI-only** (T002) — expect outstanding/unpaid ERPNext invoices until the Payment Entry arc ships; by design (rider R1), not a defect.
