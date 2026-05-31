# 009 Inventory & Stock Movement Ledger — Wave Status

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Tasks**: [tasks.md](./tasks.md) | **Execution map**: [execution-map.yaml](./execution-map.yaml)

**Status**: **NOT STARTED** — planning chain complete (specify → clarify → plan → tasks). No slice dispatched. Created 2026-05-31.

---

## Next recommended action

Dispatch the **MVP path** once the two `[GATED]` slices are approved:

1. **`009-SIGNOFF-QTY-LIB`** (T001) — record the no-`package.json`-dependency quantity decision (SIGN-OFF below). No code.
2. **`009-SETUP`** (T002) — scaffold the empty `apps/api/src/inventory/` module.
3. **`009-CONTRACT`** (T010/T011) — **`[GATED]`**, needs explicit in-session approval (`packages/contracts/openapi/inventory/**`).
4. **`009-SCHEMA`** (T012/T013) — **`[GATED]`**, needs explicit in-session approval (`packages/db/**`, `0014_inventory`).
5. **`009-ISOLATION-HARNESS`** (T014/T015) → **`009-US1-ONHAND`** (the MVP keystone).

Neither `[GATED]` slice dispatches without approval; no GREEN implementing slice dispatches until both merge.

---

## SIGN-OFF Decisions

- **T001 — quantity value object adds NO `package.json` dependency.** Quantity is a string-backed exact-decimal value object round-tripped to `numeric(p,s)` (R3, mirrors 008 gate A.6). v1 sums quantities in a single stocking unit (no cross-unit conversion, FR-022), so no big-decimal library is needed. **Anticipated verdict: no dependency added** — *to be CONFIRMED by T001's `pnpm --filter @data-pulse-2/api build` verification before 009-SCHEMA dispatches (this is the expected outcome, not yet a confirmed result).* If a big-decimal lib ever becomes necessary, that is a SEPARATE `[GATED]` `package.json` decision — STOP and request approval.

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

1. **Automatic sale-event decrement (FR-060)** — deferred to a future **008-live-loop / 009-sale-consumer** slice. Depends on the producer binding + `sale.captured` added to `OUTBOX_EVENT_TYPES` + `SaleWorker.start()` (the 008 documented deferral). v1 ships only the **manual/backfill** sale-linked outbound (US4), which reads **captured** 008 sale rows — never `processed_at`-stamped (R8). Addable without redesigning the ledger (SC-008).
2. **Automatic restock-on-void (FR-025)** — deferred with #1; v1 ships only the **manual/backfill** restock (T090/T091).
3. **Pharmacy lot/batch/serial/expiry/FEFO (FR-040..042)** — designed-for seam (a future nullable `stock_lot_id` / `stock_serial_id` FK), **gated future decision**; v1 implements none of it. Generic-retail movements never populate it. Addable without rewriting existing movements (SC-009).
4. **On-hand materialization (FR-003)** — v1 is **compute-on-read SUM**; a materialized `stock_balances` table is permitted later purely as a perf optimization (reconstructible from the ledger), not built in v1 (plan §10).
5. **SC-010-style perf** — on-hand/movement perf assertions are **report-only** in v1 (no perf env; 005/008 precedent).

---

## Slice ledger

| Slice | Tasks | Status | Gate |
|---|---|---|---|
| 009-SIGNOFF-QTY-LIB | T001 | pending | `[SIGN-OFF]` |
| 009-SETUP | T002 | pending | — |
| 009-CONTRACT | T010, T011 | pending | **`[GATED]`** OpenAPI |
| 009-SCHEMA | T012, T013 | pending | **`[GATED]`** schema/migration |
| 009-ISOLATION-HARNESS | T014, T015 | pending | — |
| 009-US1-ONHAND 🎯 | T030–T034 | pending | — (MVP) |
| 009-US2-MANUAL | T040–T044 | pending | — |
| 009-US3-IDEMPOTENCY | T050–T053 | pending | — |
| 009-US4-SALELINKED | T060–T064 | pending | — (decoupling proof) |
| 009-US5-TRANSFER | T070–T073 | pending | — |
| 009-US6-COUNT | T080–T083 | pending | — |
| 009-SIGNAL-NEGBAL | T045 | pending | — (new §VII signal) |
| 009-RESTOCK | T090, T091 | pending | — |
| 009-LIFECYCLE | T095 | pending | — |
| 009-POLISH | T100–T104 | pending | — |

**15 slices · 45 tasks · 2 `[GATED]` + 1 `[SIGN-OFF]` · 1 new observability signal.**
