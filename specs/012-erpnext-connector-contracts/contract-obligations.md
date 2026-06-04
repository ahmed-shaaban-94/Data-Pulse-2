# DP2 ↔ Connector — Contract Obligations

**Feature**: 012-erpnext-connector-contracts
**Status**: Draft — obligations only (the `[GATED]` OpenAPI YAML is a separate later slice)
**Date**: 2026-06-04

> This document enumerates the **obligations** the eventual `[GATED]` OpenAPI
> contract (`packages/contracts/openapi/erpnext-connector/…`, authored in a later
> 012-CONTRACT slice) MUST satisfy. It does **not** author the YAML. The contract
> realises the signed [posting decision](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md)
> over a **pull/feed bidirectional** transport (owner decision 2026-06-04).

---

## Transport shape (pull/feed, bidirectional)

The contract has two halves over a connector-initiated pull:

- **Work-items out** — DP2 exposes an authenticated feed of pending postings; the
  connector **pulls** (cursor/ack semantics mirroring the 010 read-down delta).
- **Outcomes back** — the connector **ACKs** each item with its outcome (ERPNext
  document reference, ETA status passthrough, success / failure / permanent
  rejection). DP2 owns the resulting DLQ + reconciliation state (017 surfaces it).

DP2 makes **no outbound HTTP calls**; it exposes endpoints the connector calls.

---

## The seven obligations

### O-1 — Work-item payload (sale → posting)
Each pending-posting work-item MUST carry enough to post a complete ERPNext Sales
Invoice **without** the connector reaching back into DP2 for more:
- the sale fact + `sale_lines` (008 projection — amounts, quantities, tax per line);
- **provenance**: `sourceSystem`, `externalId`, and the canonical **payload hash**;
- **`businessDate`** (drives ERPNext `posting_date`, per the posting decision §2);
- the tenant/store scope (mapped to the ERPNext company/warehouse downstream — 013/014);
- money as **exact-decimal string + ISO-4217 currency** (§III, no floats — the 010 wire-money precedent).

### O-2 — Outcome / status return payload (connector → DP2)
For every work-item, the connector MUST report back:
- the **ERPNext document reference** (the submitted Sales Invoice / Payment Entry id);
- the **ETA status / UUID passthrough** field (populated when 016 ETA is live; nullable until then);
- a discrete **outcome**: `posted` | `failed_transient` | `permanently_rejected`;
- on `permanently_rejected`, a structured reason (validation / closed-period / unmapped-item) so DP2's DLQ + reconciliation flag (017) is actionable.
The return path is **non-optional**; a work-item is not complete until DP2 records its outcome.

### O-3 — Wire idempotency (same input → same ERPNext document)
The contract MUST guarantee that re-pulling/re-posting the same work-item
(identified by `sourceSystem + externalId`) resolves to the **same** ERPNext
document — no duplicate invoice on retry (posting decision §3). The ACK echoes the
existing document reference on a duplicate, rather than creating a new one.

### O-4 — Reversal operations (void / refund)
The contract MUST model **reversal work-items**: a DP2 008 terminal event (void or
refund) is a work-item that posts a **new reversing document** (credit note /
return Sales Invoice) referencing the original — **never** an edit/cancel of the
original (posting decision §6). Reversals carry the original's provenance keys so
the connector can locate the document to reverse.

### O-5 — Connector lifecycle & auth (cross-ref)
The contract MUST define how the connector authenticates to DP2 and how the
pull/ACK loop is scoped and sequenced. Specified in
[connector-lifecycle.md](./connector-lifecycle.md). Key points it pins: connector
holds ERPNext creds; DP2 authenticates the connector as a dedicated principal
(reusing the 010 device/principal-auth machinery, not a human Clerk session);
cross-tenant isolation + non-disclosing errors hold on the feed (§II/§XII).

### O-6 — Version-independence (insulated from ERPNext churn)
The DP2 ↔ connector contract MUST be **insulated from ERPNext version churn**
(version-pin decision §6): an ERPNext upgrade changes the connector's *internal*
ERPNext-facing code, never the DP2-facing contract. The contract speaks in
DP2/Retail-Tower terms (sale, line, businessDate, outcome), **not** ERPNext
doctype field names. Specified in [connector-lifecycle.md](./connector-lifecycle.md).

### O-7 — The connector split ADR
The contract's existence presumes a connector repo, whose creation is gated by an
**ADR** proposed by this spec under `.specify/memory/decisions/` (spec §6). The
contract is versioned (§IV) so the connector repo and DP2 evolve against a stable
boundary.

---

## Explicitly out of these obligations

- The **OpenAPI YAML itself** (authored in the `[GATED]` 012-CONTRACT slice).
- **ERPNext-internal field mappings** (sale-line → Item, store → Warehouse, tax →
  Tax Template) — those are 013 / 014 / 016, behind the connector.
- The **posting business logic** (how the connector orchestrates submit, retry
  backoff, ERPNext API calls) — that is 015 + the connector repo.
- **Outbox event-type registration** — named in [follow-up-notes.md](./follow-up-notes.md),
  registered in its own approval PR.
