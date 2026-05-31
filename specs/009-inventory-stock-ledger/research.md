# Phase 0 Research: Inventory & Stock Movement Ledger (009)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

With the five owner decisions resolved (spec §Clarifications, Session 2026-05-31) and the API-audience default fixed (plan §4.2), there are **no residual NEEDS CLARIFICATION**. Phase 0 records the settled decisions in Decision / Rationale / Alternatives form.

---

## R1 — On-hand derivation: compute-on-read SUM

- **Decision**: On-hand is the signed SUM of a `(tenant, store, product)`'s movements, computed on read. v1 does **not** maintain a materialized balance row.
- **Rationale**: Keeps the constitution's "caches reconstructible from Postgres" invariant trivially true (there is no cache); avoids creating a new *mutable* resource that would trigger §III's cache-invalidation-trigger + concurrency obligations. The query is a bounded single-key aggregate. Satisfies FR-003 / SC-001 ("on-hand always equals the signed sum").
- **Alternatives considered**: (a) Materialized `stock_balances` table updated per movement — rejected for v1 (new mutable surface, invalidation + concurrency burden); FR-003 *permits* it later purely as a perf optimization, reconstructible from the ledger. (b) Event-sourced snapshot+delta — over-engineered for a single-key SUM at v1 scale.

## R2 — Negative-stock policy: allow and flag (+ new signal)

- **Decision**: Outbound / transfer-out / sale-linked outbound are never rejected for driving on-hand below zero. The movement appends, on-hand may go negative, and a **negative-balance signal** is emitted: a per-`(tenant, store, product)` flag on the on-hand projection **and** a Prometheus counter of negative-balance occurrences.
- **Rationale**: A decoupled, backfill-friendly ledger routinely receives out-of-order or sale-linked outbound movements before the matching inbound. Rejecting them would force operators to fabricate inbound movements and break "on-hand is always explainable by movements." Consistent with 008's "preserve as received, flag mismatches, never rewrite" posture. **Side benefit (R7)**: dissolves the read-compute-write race.
- **Alternatives considered**: (a) Reject oversell — rejected: breaks backfills/out-of-order; (b) Per-tenant configurable — rejected for v1: adds config surface + conditional test paths with no demonstrated need.
- **Constitution note**: the signal is **not** in §VII's named list → consciously introduced as a new signal category (plan §3.3); §VII requires it be named/registered, which it is.

## R3 — Quantity representation: exact-decimal, single stocking unit

- **Decision**: Movement quantity is an exact-decimal `numeric(p,s)` value expressed in the referenced product's **single stocking unit**. Cross-unit movements are **rejected** (no silent coercion). No unit-conversion engine in v1.
- **Rationale**: Exact-decimal (no float) matches 008's `numeric` discipline and supports weight-based/dispensed/fractional retail without blocking integers. A single stocking unit keeps on-hand summable without a conversion layer. The same string-backed value-object pattern 008 used for money round-trips to `numeric(p,s)` — **no new dependency**.
- **Alternatives considered**: (a) Integer-only quantity — rejected: blocks weight/dispensed products and the future pharmacy use case; (b) Multi-unit with conversion engine — rejected: large surface, out of v1 scope, deferrable behind the rejection rule.

## R4 — Idempotency: dual dedup contract by origin

- **Decision**: Client-originated **manual** movements dedup on the `Idempotency-Key` header (reusing the 001/005 primitive). **Backfill / external-origin** movements dedup on `sourceSystem + externalId` (or the sale-reference / terminal-event-reference pair). Both converge to exactly-once; a replay with a divergent body is a conflict.
- **Rationale**: Manual API calls have no natural external id → the header is the right key. Backfills/external sources have a stable provenance pair → that is the right key. Reuses shipped primitives; no new mechanism.
- **Alternatives considered**: (a) Single universal key — rejected: manual movements lack a natural external id, forcing a synthetic one; (b) No idempotency, dedup downstream — rejected: violates FR-030/§XI, corrupts inventory on retry.

## R5 — Product identity + ad-hoc references

- **Decision**: A movement's product reference resolves to a **Tenant Catalog product** (§IX). An unresolved/ad-hoc reference (e.g., a sale-linked outbound for an 008 ad-hoc line) is recorded as **nullable provenance only**; the movement still persists and affects on-hand. 009 **never auto-creates** a Tenant Catalog product from a movement.
- **Rationale**: Mirrors 008's `tenant_product_ref` nullable-lineage rule exactly. The inventory ledger is a fact recorder, not a catalog editor; auto-creating products would blur the source-of-truth boundary (§IX) and let ingestion mutate the catalog.
- **Alternatives considered**: (a) Require a resolved product on every movement — rejected: breaks sale-linked outbound for ad-hoc 008 lines; (b) Auto-create catalog product on unresolved reference — rejected: §IX cross-layer-write violation, matches the explicitly-forbidden 008 behavior.

## R6 — Void/refund/return → restock: manual/backfill, provenance-linked

- **Decision**: A restock is an **inbound** movement referencing the originating 008 void/refund terminal event (or a customer return) as **provenance**, idempotent on that provenance (R4). **Automatic** restock-on-void is deferred to the same future follow-up as auto-decrement.
- **Rationale**: Consistent with the decoupling premise and with how sale-linked outbound already works (US4) — restock is just an inbound movement with terminal-event provenance. Automatic restock would react to processed terminal events, which depends on the gated 008 loop.
- **Alternatives considered**: (a) Automatic restock-on-void in v1 — rejected: depends on the gated loop, violates decoupling; (b) No restock path in v1 — rejected: leaves a real operator need unmet when a manual/backfill inbound covers it cheaply.

## R7 — Concurrency: append-only fact, no version column

- **Decision**: No optimistic-concurrency `version` column. Movements are append-only; on-hand is compute-on-read.
- **Rationale**: With **allow-and-flag** (R2) and compute-on-read (R1), two concurrent outbound movements simply both append and both flag — there is no read-compute-write window to lose, no row to overwrite, no TOCTOU. §III's "last-write-wins must be justified" is satisfied because there is **no** write-over.
- **Alternatives considered**: (a) `version` column + `If-Match` — rejected: meaningless on an append-only fact; (b) Row lock on a balance row during decrement — rejected: there is no balance row (R1), and allow-and-flag removes the need to serialize.

## R8 — Decoupling mechanism: backfill reads captured rows

- **Decision**: The sale-linked backfill reads the **captured** (immutable) 008 `sales`/`sale_lines` rows directly. It does not read `processed_at`-stamped rows and requires nothing from the gated 008 live loop. Automatic decrement (which *would* react to processing) is the deferred follow-up.
- **Rationale**: Makes SC-002 ("zero dependency on live sale-event subscription") concrete and testable: every v1 flow passes with the 008 loop unwired because the backfill consumes the captured fact, not a processing signal.
- **Alternatives considered**: (a) Subscribe to `sale.captured` now — rejected: the event type, producer binding, and worker start are all gated/unbuilt (008 deferral); (b) Poll `processed_at` — rejected: it stays NULL while gated, so nothing would ever be consumed.

## R9 — API audience + auth (the one resolved-by-default parameter)

- **Decision**: Operator movement + on-hand endpoints are a **dashboard/back-office (`cookieAuth`) surface**, object-level-authorized per store. The **sale-linked backfill** is a separate **platform/admin-invoked** worker path, not a public POS route.
- **Rationale**: 009's manual inbound/adjustment/count/transfer are back-office operator actions, not POS-device actions — they do not fit 008's `/api/pos/v1/` device-token model. The dashboard is deferred, but the auth posture for the contract's `security` section must be pinned now (it is load-bearing for the `[GATED]` contract).
- **Alternatives considered**: (a) POS-device-token surface like 008 — rejected: wrong actor model for back-office inventory ops; (b) Leave unstated — rejected: silently defaulting the contract `security` section is a §IV/§XII risk. A POS-device inventory surface, if ever needed, is an additive contract version, not v1.

---

## Settled — no open research

All Technical Context unknowns are resolved. Implementation parameters left to `data-model.md` / `tasks.md` are HOW-level (column precision/scale, index choices, exact transfer-linkage representation), not unresolved WHAT.
