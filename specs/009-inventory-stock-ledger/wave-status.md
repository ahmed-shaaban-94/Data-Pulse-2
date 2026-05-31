# 009 Inventory & Stock Movement Ledger — Wave Status

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Tasks**: [tasks.md](./tasks.md) | **Execution map**: [execution-map.yaml](./execution-map.yaml)

**Status**: **IN PROGRESS** — 7 of 15 slices merged through PR #444 (`8d3e6d9`, 2026-05-31): SIGNOFF, SETUP, CONTRACT `[GATED]`, SCHEMA `[GATED]`, ISOLATION-HARNESS, US1-ONHAND 🎯, US2-MANUAL. Both `[GATED]` slices were approved in-session and merged. The MVP read path (US1: compute-on-read on-hand + movement list) and the manual write path (US2: createStockMovement) are live on `main`. Created 2026-05-31.

---

## Next recommended action

Dispatch **`009-US3-IDEMPOTENCY`** (T050–T053; depends only on US2's create path T044):

- `Idempotency-Key` replay — same key + same body ×N → exactly one movement, identical response, on-hand applied once (FR-030, SC-003);
- divergent body under the same key → deterministic 409, no side-effect (FR-030);
- backfill/external provenance `(sourceSystem, externalId)` dedup ×N → one movement, not double-applied (FR-031).

US4/US5/US6 each depend only on US2 (T044) but all write the shared `inventory.service.ts`, so they are **NOT safely parallel in a shared worktree** (parallel agents share git worktree state) — dispatch serially, or `git worktree add` for true isolation.

**Carried [GATED] deferrals for 009-POLISH / closeout** (both touch `packages/db/**`, outside any per-slice allowed_files — see Active findings #6/#7):
- movement **outbox emit** (new `INVENTORY_MOVEMENT_*` type in `OUTBOX_EVENT_TYPES`);
- **established-unit concurrency guard** (DB UNIQUE trigger/constraint or per-key advisory lock).

---

## SIGN-OFF Decisions

- **T001 — owner DECISION: v1 WILL NOT add a `package.json` dependency for Quantity.** Quantity is a string-backed exact-decimal value object round-tripped to `numeric(p,s)` (R3, mirrors 008 gate A.6); v1 sums quantities in a single stocking unit with no cross-unit conversion (FR-022), so no big-decimal library is needed. **VERIFICATION step (when T001 dispatches):** `pnpm --filter @data-pulse-2/api build` must succeed with no dependency added — this merely confirms compliance with the decision; it does not re-open it. If a big-decimal lib ever becomes necessary, that is a SEPARATE `[GATED]` `package.json` decision — STOP and request approval.

---

## Owner decisions (resolved at /speckit-clarify, Session 2026-05-31)

1. Negative stock = **allow and flag** (+ new negative-balance signal). Never reject outbound for going negative.
2. Quantity = **exact-decimal in the product's single stocking unit**; cross-unit **rejected**; no conversion engine.
3. Void/refund → restock = **manual/backfill provenance-linked inbound**; automatic deferred.
4. Product identity = **Tenant Catalog product**; ad-hoc = **nullable provenance**; **no auto-create**.
5. Idempotency = **`Idempotency-Key`** (manual) / **`sourceSystem+externalId`+sale-ref** (backfill).

---

## Active findings / deferrals (modeled, NOT v1)

These are **scope decisions, not blockers** — the planned v1 work is complete and correct as specified.

1. **Automatic sale-event decrement (FR-060)** — deferred to a future **008-live-loop / 009-sale-consumer** slice. Depends on the producer binding + `sale.captured` added to `OUTBOX_EVENT_TYPES` + `SaleWorker.start()` (the 008 documented deferral). v1 ships only the **manual/backfill** sale-linked outbound (US4). Because that 008 loop is unwired, captured sale rows have **`processed_at = NULL`**; the backfill therefore reads rows in the **`captured`** state (`processed_at IS NULL`) and **intentionally does NOT read or wait for any row with a non-NULL `processed_at`** (R8). This is why 009 needs nothing from the gated loop. Addable without redesigning the ledger (SC-008).
2. **Automatic restock-on-void (FR-025)** — deferred with #1; v1 ships only the **manual/backfill** restock (T090/T091).
3. **Pharmacy lot/batch/serial/expiry/FEFO (FR-040..042)** — designed-for seam (a future nullable `stock_lot_id` / `stock_serial_id` FK), **gated future decision**; v1 implements none of it. Generic-retail movements never populate it. Addable without rewriting existing movements (SC-009).
4. **On-hand materialization (FR-003)** — v1 is **compute-on-read SUM**; a materialized `stock_balances` table is permitted later purely as a perf optimization (reconstructible from the ledger), not built in v1 (plan §10).
5. **SC-010-style perf** — on-hand/movement perf assertions are **report-only** in v1 (no perf env; 005/008 precedent).
6. **Movement outbox emit (US2/T044)** — `createStockMovement` emits **audit-in-transaction only** (mirrors the shipped 005 catalog write). An async outbox event for inventory movements needs a new `INVENTORY_MOVEMENT_*` type registered in `OUTBOX_EVENT_TYPES` (`packages/db/src/outbox/producer.ts`) — a forbidden `packages/db/**` path outside US2's allowed_files; same shape as the 008 `sale.captured` deferral. **`[GATED]` follow-up for closeout.** (PR #444)
7. **Established-unit concurrency guard (US2/T044)** — `assertUnitMatchesEstablished` is a best-effort read-before-insert under READ COMMITTED: two concurrent FIRST movements for the same `(store, product)` in different units could both commit, leaving divergent units FR-022 forbids (rare for manual entry). A hard guarantee belongs at the data layer — a UNIQUE `(store_id, tenant_product_ref, stocking_unit)`-style trigger/constraint or a per-key advisory lock — `packages/db/**`, **`[GATED]` follow-up for closeout.** The failure window + remedy are captured in the method docstring. (PR #444)

---

## Slice ledger

| Slice | Tasks | Status | Gate |
|---|---|---|---|
| 009-SIGNOFF-QTY-LIB | T001 | **merged** (#437 `581708a`) | `[SIGN-OFF]` |
| 009-SETUP | T002 | **merged** (#438 `9f18621`) | — |
| 009-CONTRACT | T010, T011 | **merged** (#439 `1aee57f`) | **`[GATED]`** OpenAPI ✅ |
| 009-SCHEMA | T012, T013 | **merged** (#440 `4d5f1e7`) | **`[GATED]`** schema/migration ✅ |
| 009-ISOLATION-HARNESS | T014, T015 | **merged** (#442 `c863216`) | — |
| 009-US1-ONHAND 🎯 | T030–T034 | **merged** (#443 `4449f13`) | — (MVP) |
| 009-US2-MANUAL | T040–T044 | **merged** (#444 `8d3e6d9`) | — |
| 009-US3-IDEMPOTENCY | T050–T053 | pending | — (next) |
| 009-US4-SALELINKED | T060–T064 | pending | — (decoupling proof) |
| 009-US5-TRANSFER | T070–T073 | pending | — |
| 009-US6-COUNT | T080–T083 | pending | — |
| 009-SIGNAL-NEGBAL | T045 | pending | — (new §VII signal) |
| 009-RESTOCK | T090, T091 | pending | — |
| 009-LIFECYCLE | T095 | pending | — |
| 009-POLISH | T100–T104 | pending | — |

**15 slices · 45 tasks · 2 `[GATED]` + 1 `[SIGN-OFF]` · 1 new observability signal.**
**Progress: 7/15 slices merged** (both `[GATED]` approved + merged); MVP read path (US1) + manual write path (US2) live on `main`. Next: US3-IDEMPOTENCY.
