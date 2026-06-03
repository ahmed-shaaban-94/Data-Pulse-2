# Decision Record: Tax & Fiscal Model — Egypt v1

**Decision ID**: 011-DR-TAX-FISCAL-EG
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **UNSIGNED — BLOCKS IMPLEMENTATION**
**Gates**: spec **016** (per spec §9)
**Owner / signer**: Ahmed Shaaban (unsigned)
**Created**: 2026-06-03

> **PLACEHOLDER.** This record is a *gate*, not a decision. **No spec it gates may
> begin implementation until this record is signed** (`Status: SIGNED` + dated owner
> sign-off). An agent dispatched to a gated spec MUST verify this record is `SIGNED`
> and STOP-and-report otherwise.

---

## Question to be decided

**How is tax computed and how are fiscal/compliance obligations (Egypt v1) satisfied across the DP2 → ERPNext posting path?**

Sub-questions the signed decision MUST answer:

1. **Tax authority** — is tax **computed** by DP2, by ERPNext (tax templates), or by POS-Pulse at sale time and preserved as received (§III "POS totals preserved as received")? Where is the authoritative tax amount per sale line?
2. **Tax category mapping** — how does the DP2 catalog `tax_category` map to an ERPNext Item Tax / Tax Template? Inclusive vs exclusive tax handling.
3. **Egypt e-invoice / ETA** — what is the obligation surface (Egyptian Tax Authority e-invoice / e-receipt)? Does ERPNext (or a Frappe app) handle ETA submission, and what does DP2 / the connector pass through?
4. **Rounding policy** — invoice-vs-line rounding (the Constitution §III / ROADMAP-ERP §3 open gate). Must be pinned before any tax-bearing posting ships.
5. **Multi-tax composition** — how are multiple taxes (e.g. VAT + table service / other levies) composed and ordered?
6. **Fiscal document numbering** — naming series / fiscal sequence ownership (ERPNext vs DP2 vs ETA-assigned).
7. **Historical immutability** — posted tax/fiscal documents are immutable historical truth (§IX SaleLine snapshot); corrections are new documents (credit notes), never edits.

## Constraints any decision MUST respect

- Money is exact-decimal (§III, no floats); tax math must be lossless to the currency minor unit.
- §III: SaaS MAY reconcile and flag mismatches but MUST NOT silently rewrite historical POS totals.
- Fiscal/compliance documents, once submitted, are immutable; reversal is via new documents.
- PII / customer-identifying fiscal data follows §XIV data-class discipline.

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
