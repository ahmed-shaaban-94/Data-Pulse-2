# Decision Record: ERPNext Posting Model

**Decision ID**: 011-DR-POSTING
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **UNSIGNED — BLOCKS IMPLEMENTATION**
**Gates**: specs **012**, **013**, **015**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban (unsigned)
**Created**: 2026-06-03

> **PLACEHOLDER.** This record is a *gate*, not a decision. It is intentionally
> empty of a chosen option. **No spec it gates may begin implementation until
> this record is signed** (`Status: SIGNED` + dated owner sign-off). An agent
> dispatched to a gated spec MUST verify this record is `SIGNED` and STOP-and-report otherwise.

---

## Question to be decided

**How does a Data-Pulse-2 sale fact (008: `sales` + `sale_lines`) get posted into ERPNext, and what is the system of record for each posted artifact?**

Sub-questions the signed decision MUST answer:

1. **Posting target shape** — does a DP2 sale post as an ERPNext **Sales Invoice**, a **POS Invoice**, or a draft-then-submit pair? What ERPNext doctype(s) are written?
2. **Trigger & timing** — is posting synchronous on sale capture, or asynchronous via the connector (queue/outbox)? What is the posting `businessDate` vs `occurredAt` mapping (Constitution §X)?
3. **Idempotency & provenance** — how does a re-posted sale (retry) resolve to the same ERPNext document? (`sourceSystem + externalId`, payload hash — §XI/§IX.)
4. **System of record** — DP2 remains source of truth for the sale fact (§IX). What does ERPNext own that DP2 does not (GL entries)? Confirm DP2 never rewrites a posted ERPNext document silently.
5. **Failure posture** — what happens when ERPNext rejects a posting (validation, period closed)? Reconciliation/repair path (ties to 017).
6. **Void / refund** — how do 008 terminal events (void/refund) map to ERPNext credit notes / return invoices?

## Constraints any decision MUST respect

- DP2 stays the source of truth for the sale fact (§IX). ERPNext receives a posting; it is not the origin.
- Money is exact-decimal (§III, no floats). Posted amounts must reconcile to the DP2 sale totals; DP2 MUST NOT silently rewrite POS-received totals.
- The trust boundary holds: posting flows DP2 → connector → ERPNext only.

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
