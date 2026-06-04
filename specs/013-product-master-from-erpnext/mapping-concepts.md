# Mapping Concepts — 013 Product Master from ERPNext

**Feature**: 013-product-master-from-erpnext
**Status**: Draft — concept catalogue only (no schema, no YAML)
**Date**: 2026-06-04

> This document expands the seven mapping concepts from [spec.md §7](./spec.md)
> into a concept catalogue: what each concept links, which side is
> authoritative, and what stays an open question. It **does not** author a
> `data-model.md` or any schema — concepts are named and bounded, not
> structured. All concepts are expressed in **DP2/Retail-Tower terms**, not
> ERPNext doctype field names (012 O-6 version-independence).

---

## The mapping link, at a glance

```
   003 Tenant Catalog                         ERPNext (via connector only)
   ─────────────────                          ────────────────────────────
   tenant_products  ◀───── 013 mapping ─────▶  Item            (accounting identity)
   product_aliases  ····· (alias relates to) ·  Item Barcode
   (sale line unit) ····· (UOM maps to) ······  Item UOM / conversion
   (DP2 amounts)    ····· (price-list ref) ····  Price List      (doc validity, not repricing)
   003 retire/avail ····· (sellable state) ····  Item disabled / is_sales_item

   §IX authority STAYS in DP2 (left)   |   accounting Item identity in ERPNext (right)
   reconciled by the mapping — never merged, never one silently overriding the other
```

The mapping is the **only** new authority 013 introduces: the link itself
(which DP2 product corresponds to which ERPNext Item), owned by DP2. Everything
on the left stays §IX-authoritative in DP2; everything on the right stays
ERPNext's accounting concern, reached only through the connector.

---

## 1. ERPNext Item ↔ `tenant_products`

| Aspect | Position |
|---|---|
| **Links** | A DP2 `tenant_products` row ↔ an ERPNext Item (referenced by a DP2-side identifier, e.g. the Item code). |
| **Authoritative side** | DP2 owns the **link record** and the retail product (§IX). ERPNext owns the **accounting Item identity**. |
| **Why** | Posting decision §1 requires a submitted Sales Invoice line to reference a real ERPNext Item; resolvability (not ownership) is the obligation. |
| **Open** | Cardinality (OQ-2), lifecycle/establishment (OQ-7), import direction (OQ-8). |

The DP2 side stores a **reference** (DP2 terms); the connector resolves it to
the live ERPNext doctype. An ERPNext version change alters the connector's
internal resolution, not this link (A-2).

## 2. Barcode ↔ `product_aliases`

| Aspect | Position |
|---|---|
| **Links** | A 003 `product_aliases` entry (barcode/SKU/PLU/external POS id) ↔ an ERPNext Item Barcode. |
| **Authoritative side** | 003 catalog keeps alias authority — its uniqueness/conflict rules stand. The mapping only relates an alias to the ERPNext Item for posting resolution. |
| **Must not** | Move alias authority out of the 003 catalog, or let an ERPNext barcode silently create/alter a 003 alias. |

## 3. UOM ↔ sale-line unit

| Aspect | Position |
|---|---|
| **Links** | A DP2 sale line's unit ↔ the ERPNext Item's stock/selling UOM. |
| **Authoritative side** | Open (OQ-3). The exactness rule (§III: no silent rounding of quantities) is non-negotiable regardless. |
| **Risk** | A wrong/implicit UOM conversion posts the wrong quantity to ERPNext — a §III integrity defect, surfaced as a reconciliation mismatch, never silently rounded. |

## 4. Price List reference ↔ DP2 amounts

| Aspect | Position |
|---|---|
| **Links** | A tenant/store ↔ the relevant ERPNext Price List, referenced for ERPNext document validity. |
| **Authoritative side** | **DP2 amounts are authoritative for the posted invoice** (posting decision §4; POS totals preserved as received, §III/§IX). The Price List reference exists for ERPNext document validity, **not** to reprice a DP2 sale. |
| **Open** | Whether posting sends explicit per-line amounts vs relies on the Price List (OQ-4). The §IX-safe default is explicit DP2 amounts. |

## 5. Active / sellable state

| Aspect | Position |
|---|---|
| **Links** | 003 retire/availability ↔ ERPNext Item `disabled` / `is_sales_item`. |
| **Authoritative side** | **Operational sellability is DP2-authoritative** (§IX — what POS sells is the 003 resolved catalog). ERPNext's enabled state governs **posting resolvability** only (a disabled Item cannot receive a posting). |
| **Open** | Divergence detection + reconciliation, and which state governs at posting time (OQ-5). Divergence is a reconciliation case, never a silent override. |

## 6. Tenant / store / catalog provenance

| Aspect | Position |
|---|---|
| **Carries** | tenant scope (RLS-isolated, §II); store scope where store-specific; the source 003 layer (tenant vs store-override); when/by-whom established or last reconciled (§XIII). |
| **Why** | A posting failure (unmapped item, posting decision §5) must be traceable to the exact DP2 product + tenant; provenance is the §XIII/§IX requirement that makes the mapping auditable and reconcilable. |
| **Aligns with** | 012 O-1 work-item provenance (`sourceSystem`, `externalId`, payload hash) — the mapping provenance is the product-identity complement to the sale provenance. |

## 7. Unresolved / unmapped ERPNext item case

| Aspect | Position |
|---|---|
| **Is** | A DP2 `tenant_products` row (or a sale line referencing it) with **no current ERPNext Item mapping**. |
| **Triggered by** | Posting-time resolution (015) finding no mapping → posting **fails-to-DLQ** (posting decision §5), and/or a mapping-review surface flagging the gap. |
| **Remedy** | Establish/repair the `tenant_products ↔ ERPNext Item` mapping; the DP2 sale fact is **never** mutated on a posting failure (posting decision §5). |
| **Distinct from** | The 003/006/007 **unknown-items** queue (inbound POS-scan direction). See [spec.md §8](./spec.md#8-relationship-to-the-shipped-unknown-items-workflow). The two MUST stay separate (OQ-6). |

---

## What is explicitly NOT in these concepts

- **The schema / `data-model.md`** — a later `[GATED]` slice once OQ-1/2/7/8 lock.
- **ERPNext doctype field-level mapping** — the connector's internal concern,
  pinned only when the version-pin staging validation completes (A-1).
- **The posting logic** (how 015 resolves + posts) — 015 + the connector repo.
- **Warehouse / branch mapping** (014) and **tax/fiscal** mapping (016).
- **Any outbox event** — `erpnext.posting.requested` stays NAMED only (012
  follow-up-notes); registered in its own approval PR when 015 needs it.
