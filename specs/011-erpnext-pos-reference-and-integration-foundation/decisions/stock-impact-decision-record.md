# Decision Record: ERPNext Stock Impact Model

**Decision ID**: 011-DR-STOCK-IMPACT
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **UNSIGNED — BLOCKS IMPLEMENTATION**
**Gates**: specs **014**, **015**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban (unsigned)
**Created**: 2026-06-03

> **PLACEHOLDER.** This record is a *gate*, not a decision. **No spec it gates may
> begin implementation until this record is signed** (`Status: SIGNED` + dated owner
> sign-off). An agent dispatched to a gated spec MUST verify this record is `SIGNED`
> and STOP-and-report otherwise.

---

## Question to be decided

**What is the relationship between the Data-Pulse-2 stock ledger (009: append-only `stock_movements`, compute-on-read on-hand) and ERPNext's stock ledger / valuation, and which is authoritative for on-hand vs valuation?**

Sub-questions the signed decision MUST answer:

1. **On-hand authority** — DP2 computes on-hand as a signed SUM (009). Does ERPNext mirror this, or does ERPNext become authoritative for on-hand in branches sourced from ERPNext (014)? Can both coexist without divergence?
2. **Valuation authority** — DP2 does **not** model valuation (FIFO/moving-average). Is inventory **valuation** owned solely by ERPNext (likely yes, as the accounting backbone)?
3. **Movement → Stock Entry mapping** — when a DP2 sale-linked outbound movement (009 US4) is posted (015), does it create an ERPNext Stock Ledger Entry, or does the ERPNext Sales Invoice's own stock update suffice? Avoid double-decrement.
4. **Direction for branch inventory (014)** — is branch/warehouse inventory **sourced from** ERPNext (read-down into DP2), or **pushed to** ERPNext? Which way is authoritative per field?
5. **Reconciliation** — how is DP2 on-hand vs ERPNext bin quantity reconciled, and what is the repair path (ties to 017)?
6. **Negative balance** — 009 allows-and-flags negative balances. How does that interact with ERPNext's stock validation (which may reject negative stock)?

## Constraints any decision MUST respect

- 009's ledger is **append-only**; history is never rewritten (009 US6 records corrections as new movements, not edits).
- The trust boundary holds: stock data crosses to/from ERPNext only via DP2 + the connector.
- No double-counting of a single physical movement across the two ledgers.

## Options under consideration (to be filled in when decided)

_(none recorded yet — this is a placeholder)_

## Decision

_(unsigned)_

## Sign-off

| Field | Value |
|---|---|
| Status | **UNSIGNED — BLOCKS IMPLEMENTATION** |
| Signer | _(pending)_ |
| Date | _(pending)_ |
