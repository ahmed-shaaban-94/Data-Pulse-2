# Decision Record: ERPNext Stock Impact Model

**Decision ID**: 011-DR-STOCK-IMPACT
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **SIGNED**
**Gates**: specs **014**, **015**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban
**Created**: 2026-06-03
**Signed**: 2026-06-03

> **SIGNED.** A decision has been recorded below. The specs this record gates
> (014/015/017) may proceed through their own Spec-Kit planning chains and Agent
> OS gates, consistent with this decision. Any deviation from it is a
> STOP-and-raise condition, not a silent override.

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

## Decision

### Core principle — operational-vs-accounting authority split

Adopt an explicit **operational-vs-accounting** authority split. The two stock
ledgers are **distinct systems answering distinct questions**; they MUST NOT be
merged or summed.

- **Data-Pulse-2 remains the operational stock authority** for Retail Tower OS.
  It owns the append-only `stock_movements` ledger introduced in **009** and
  computes the **operational on-hand / available-to-sell** quantities used by
  POS-Pulse, Retail-Tower-Console, and Retail Tower APIs.
- **ERPNext remains the accounting inventory authority.** It owns submitted ERP
  inventory documents, **stock valuation, COGS, accounting (GL) ledger impact,
  and financial inventory reporting**.
- The two ledgers **must not be merged or summed.** They are **reconciled**
  through explicit reconciliation jobs, mismatch reports, **correlation IDs**,
  and repair workflows.

This is the authoritative resolution of the record's sub-questions 1 and 2:
on-hand authority = DP2 (operational); valuation authority = ERPNext.

### Sub-question resolutions

3. **Movement → Stock Ledger mapping; no double-count.** The submitted ERPNext
   **Sales Invoice posts with "Update Stock" ON** so ERPNext can derive
   **valuation / COGS / GL** from it. This is **ERPNext's own accounting ledger**
   — it is **not** a second operational count. DP2's 009 ledger independently
   records the operational outbound movement (009 US4 sale-linked outbound).
   There is **no double-decrement** because the two ledgers answer different
   questions (operational available-to-sell vs accounting valuation) and are
   **never added together**; they are correlated by a shared correlation ID
   (the DP2 sale's `sourceSystem + externalId`, per the
   [posting decision](./posting-decision-record.md)) and reconciled, not summed.
   *(A separate Stock Entry per sale — "Update Stock" OFF — was considered and
   rejected for v1: it doubles ERPNext document count and decouples valuation
   timing from the invoice for no operational benefit.)*

4. **Branch-inventory direction (014) — DP2 operational, ERPNext mapped for
   valuation.** DP2's per-store/branch 009 movements stay the **operational
   truth**. ERPNext **Warehouses are mapped (1:1) to DP2 stores/branches** purely
   so ERPNext can **value** the same physical stock. **014 maps the
   warehouse ↔ store relationship and the reconciliation**, and it does **NOT**
   make ERPNext the operational on-hand source. (Read-down of branch inventory
   *from* ERPNext as the on-hand master is **rejected** — it contradicts the
   operational-authority split.)

   > **Explicit scope note (owner-directed).** **014 MUST be treated as warehouse
   > mapping and reconciliation, NOT as an ERPNext stock read-down replacing DP2
   > operational availability.** ERPNext Bin/Warehouse quantities MAY be mirrored
   > **for reconciliation and mismatch detection only**; **POS/Console sellability
   > remains driven by DP2 operational stock**. To make this unambiguous in the
   > spec arc, 014's working title is **`014-branch-inventory-reconciliation-and-warehouse-mapping`**
   > (the [follow-up map](../follow-up-spec-map.md) carries the same intent; the
   > final slug is fixed when 014 is created).

5. **Reconciliation (ties to 017).** DP2 operational on-hand and ERPNext bin
   quantity / valuation are reconciled by **explicit reconciliation jobs** that
   match on the correlation ID, emit **mismatch reports**, and feed the **017
   repair workflows**. Divergence is **surfaced and repaired**, never silently
   reconciled away by overwriting either ledger.

6. **Negative balance.** DP2's 009 ledger **allows-and-flags** negative balances
   (operational reality: stock can be sold before a restock is recorded). ERPNext
   stock validation may **reject** negative stock. This mismatch is **expected**
   and is handled by the failure posture of the
   [posting decision](./posting-decision-record.md) (retry → DLQ + reconciliation
   flag); a DP2 negative-balance flag is an operational signal, and the ERPNext
   posting that cannot value it lands in the repair queue (017). DP2's flagged
   operational reality is **never** overwritten to satisfy ERPNext.

### Invariants preserved

- 009's ledger stays **append-only**; history is never rewritten (corrections
  are new movements, 009 US6).
- Stock data crosses to/from ERPNext only via DP2 + the connector (§IV).
- A single physical movement is **never counted twice**: the two ledgers are
  reconciled by correlation ID, not summed.

### Downstream obligations this decision imposes

- **014** (branch inventory): maps ERPNext Warehouse ↔ DP2 store/branch (for
  valuation) + the reconciliation; does **not** make ERPNext the on-hand source.
- **015** (sale posting): posts the Sales Invoice with "Update Stock" ON, tagged
  with the correlation ID; emits the operational movement via 009 independently.
- **017** (sync-ops/repair): owns the reconciliation jobs, mismatch reports, and
  repair workflows over the correlation IDs.

## Sign-off

| Field | Value |
|---|---|
| Status | **SIGNED** |
| Signer | Ahmed Shaaban |
| Date | 2026-06-03 |
