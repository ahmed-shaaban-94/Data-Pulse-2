# Connector Lifecycle

**Feature**: 012-erpnext-connector-contracts
**Status**: Draft — lifecycle/auth specification (no connector code)
**Date**: 2026-06-04

> Defines the **lifecycle, authentication, credential ownership, pull/ACK loop,
> retry/DLQ ownership, and version-independence** of the DP2 ↔ connector seam.
> Realises the signed [posting](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md)
> + [version-pin](../011-erpnext-pos-reference-and-integration-foundation/decisions/version-pin-upgrade-policy.md)
> decisions. No connector code is written here.

---

## 1. Credential ownership (the security boundary)

| System | Holds | Egresses to |
|---|---|---|
| **DP2** | NO ERPNext credentials. A DP2-side principal record authenticating the connector. | Nothing — DP2 makes **no outbound HTTP calls**; it exposes endpoints. |
| **Connector** | **ALL** ERPNext credentials (the pinned, self-hosted ERPNext instance). Its DP2 pull credential. | DP2 (pull + ACK) and ERPNext (post). |
| **ERPNext** | Its own auth. | Nothing toward DP2 — reachable only behind the connector. |

This is the **security boundary** that justifies the connector repo split
(spec §6): ERPNext credentials live in exactly one place, with a blast radius a
DP2 module cannot provide.

---

## 2. Authentication of the connector to DP2

The connector authenticates to DP2 as a **dedicated machine principal** —
**reusing the 010 read-down device/principal-auth machinery**, not a human Clerk
session (which is for dashboard humans). The DP2 feed:

- scopes every response to the authenticated principal's tenant(s);
- rejects cross-tenant/cross-scope requests **non-disclosingly** (§II/§XII; the 010 posture);
- is **inbound to DP2** — the connector initiates every call.

The exact credential type (opaque revocable bearer token vs the device-principal
scheme) is fixed in the `[GATED]` 012-CONTRACT slice; the **principal model**
(dedicated machine principal, tenant-scoped, revocable) is fixed here.

---

## 3. The pull / ACK loop (transport mechanics)

Mirrors the 010 read-down **snapshot + delta + cursor** semantics, reused for an
outbound work feed:

1. **Pull pending postings** — the connector requests work-items after an opaque
   cursor (the 010 delta precedent). DP2 returns an ordered, idempotent,
   gap-detectable batch of pending postings (and reversal work-items).
2. **Post to ERPNext** — the connector posts each item to the pinned ERPNext
   (submit Sales Invoice / Payment Entry; reversing doc for void/refund).
3. **ACK with outcome** — the connector reports each outcome back (O-2):
   document ref + ETA status + `posted` | `failed_transient` | `permanently_rejected`.
4. **Advance** — DP2 advances the item's state on ACK; an un-ACK'd item is
   re-offered (at-least-once delivery → idempotency O-3 makes re-posting safe).

The cursor is **scope-bound** and opaque (010 precedent); the connector never
sees DP2 internals, only the contract.

---

## 4. Retry / DLQ ownership (DP2 owns the state)

Per the posting decision §5 and because **017-sync-ops/repair is a DP2 spec**:

- **Transient failures** (`failed_transient`) — the connector retries with backoff
  against ERPNext; if still failing, it ACKs `failed_transient` and DP2 re-offers
  on the next pull (bounded by a retry budget).
- **Permanent rejections** (`permanently_rejected`) — DP2 moves the item to a
  **dead-letter state** and raises a **reconciliation flag**. The DLQ + the flag
  live in **DP2** (017 surfaces and repairs them).
- The **DP2 sale fact is never mutated** by a posting failure — the sale is valid;
  only its posting needs repair (posting decision §5; no silent swallow).

The connector is **stateless about business truth** — it does not own a parallel
ledger of what posted; DP2's feed-state + DLQ is the authority for posting status.

---

## 5. Version-independence (insulated from ERPNext churn)

Per the version-pin decision §6 (O-6):

- The DP2 ↔ connector contract speaks in **Retail-Tower terms** (sale, line,
  `businessDate`, outcome, document-ref) — **never** ERPNext doctype field names.
  An ERPNext v15 → v16 change alters the connector's *internal* mapping code, not
  the DP2-facing contract.
- The connector **absorbs** breaking changes via a shim/version-branch in its own
  repo. The DP2-facing contract version advances only for **DP2-side** reasons,
  never merely because ERPNext upgraded.
- **ERPNext major-version confirmation** (deferred from version-pin to 012):
  v15 is the reference-lab baseline; the final major is confirmed by a
  **staging-install validation** of these obligations against the candidate major
  **before** the `[GATED]` OpenAPI slice is written. Production upgrades remain
  **staging-first and gate-controlled**.

---

## 6. What this lifecycle does NOT cover

- **ERPNext-internal orchestration** (how the connector calls ERPNext APIs, its
  internal retry to ERPNext) — connector repo + 015.
- **Field mappings** (sale-line → Item, store → Warehouse, tax category → Tax
  Template) — 013 / 014 / 016.
- **The OpenAPI YAML** — the `[GATED]` 012-CONTRACT slice.
- **Connector deployment / hosting** — the connector repo (self-hosted, pinned,
  per version-pin).
