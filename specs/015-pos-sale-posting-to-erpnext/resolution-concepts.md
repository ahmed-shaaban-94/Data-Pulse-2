# 015-RESOLVE — Posting-Time Item Resolution & Deferred Open Questions

**Feature**: 015-pos-sale-posting-to-erpnext
**Status**: Draft — concept catalogue only (no schema, no YAML, no code)
**Date**: 2026-06-05

> This document defines **015-RESOLVE** — the posting-time item-resolution path
> that **013 explicitly deferred to 015** (013 wave-status: *"`013-RESOLVE`
> remains `proposed` — belongs to 015; OQ-5/6 lock there"*) — and records the
> **ratified resolutions** (owner rider, 2026-06-05) of the open questions 013
> locked to this spec. It
> **does not** author a `data-model.md`, schema, OpenAPI YAML, or any code.
> Every concept is expressed in **DP2/Retail-Tower terms** (012 O-6
> version-independence). The OQ-5 / OQ-6 / OQ-8-bis resolutions below are
> **RATIFIED** by the signed owner rider
> [011-DR-POSTING-R1, 2026-06-05](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md)
> (clauses R3 / R4 / R2 respectively) — they are settled owner decisions, no
> longer proposals.

---

## 1. What 015-RESOLVE is

`015-RESOLVE` is the **posting-time resolution** of each DP2 sale line to a real
ERPNext **Item**, using the **013 `erpnext_item_map`** that shipped as an MVP
(suggest-then-confirm; `0017` migration on `main`). It is the realisation of the
posting-decision §1 obligation that *"a submitted Sales Invoice line must
reference a real ERPNext Item; a posting fails-to-DLQ if not."*

It is **resolution (a read), not establishment (a write).** 015 does **not**
create or confirm mappings — that is 013's suggest/confirm flow (Tenant Admin).
015 **reads confirmed mappings** at posting time and routes a failure to the DLQ.

---

## 2. The confirmed-only resolution invariant (inherited from 013)

013's data-model §3 fixed a DB-level invariant that 015-RESOLVE consumes
verbatim:

- Resolution matches **only** rows where
  `state = 'confirmed' AND retired_at IS NULL`.
- A `suggested` (unconfirmed) mapping **does NOT count as mapped** — treated
  exactly as if no row existed.
- The `erpnext_item_map_confirmed_paired` CHECK constraint guarantees a
  `confirmed` row carries `confirmed_by` + `confirmed_at` provenance — so 015 can
  **never** post against an unconfirmed auto-match (013's "no silent auto-trust").

**Why 015 must not relax this:** relaxing it would post a Sales Invoice against an
ERPNext Item a Tenant Admin never confirmed — a silent trust escalation across
the §IV trust boundary. The invariant is non-negotiable.

---

## 3. Resolution outcomes (per sale line)

| Case | 015-RESOLVE outcome |
|---|---|
| Exactly one **confirmed** active map for the line's `tenantProductRef` | **Resolved** → the line posts against that ERPNext Item. |
| Only a **suggested** (unconfirmed) map exists | **Unmapped** → posting **fails-to-DLQ** (013 confirmed-only invariant). |
| **No** map row exists | **Unmapped** → posting **fails-to-DLQ** [posting §1/§5; 013 "fails-to-DLQ if not"]. |
| **Ad-hoc line** (008 FR-004: no `tenantProductRef`) | **Unmapped** → fails-to-DLQ (no tenant product to map). A reconciliation case, not a silent drop. |
| Confirmed map points at a **disabled / non-sales** ERPNext Item | **OQ-5** (below) — **RATIFIED (rider R3)**: not resolvable → fails-to-DLQ; no silent fallback, no substitute item. |

A failed resolution surfaces a reconciliation flag (017) with the nearest 012
`RejectionReason.category` (`unmapped_item`). The **DP2 sale fact is never
mutated** on a resolution/posting failure [posting §5]. The sale is valid; only
its posting needs repair (establish/confirm the mapping, then re-post — §8 of the
spec, idempotent).

---

## 4. v1 is manual-only (the `AUTO_MATCH_NO_SOURCE` finding)

013 shipped **manual-only** suggestion (`suggestion_source = 'manual'`). The
`suggestion_source` enum keeps `barcode` / `item_code`, but there is **no
ERPNext item-search operation** in the 012 `posting-feed.yaml` (DP2 → ERPNext),
and 013 OQ-8 forbids an import worker — so auto-match has **no source** in v1.

**015-RESOLVE consequence:** v1 resolution reads whatever a Tenant Admin manually
confirmed. **Auto-match (barcode/item-code suggestion) is deferred to a future
`[GATED]` 012 item-search extension** — **named, not authored** (see
[follow-up-notes.md](./follow-up-notes.md)). 015 does **not** author the
item-search op, the import worker, or the auto-match logic.

---

## 5. OQ-5 — sellable-state divergence (RATIFIED — rider R3, 2026-06-05)

> **Question (from 013 §11 / data-model §7):** A disabled ERPNext Item cannot
> receive a posting. DP2 operational sellability (003 resolved catalog) and
> ERPNext Item enabled-state can diverge. Which governs **posting
> resolvability**, and how is divergence handled?

**Ratified resolution (no silent fallback, no substitute item):**

- **Two states, two questions** (mirrors the operational-vs-accounting split of
  the stock-impact decision and 013 mapping-concepts §5):
  - **Operational sellability stays DP2-authoritative** [§IX; 013
    mapping-concepts §5]. A disabled ERPNext **accounting** Item does **NOT**
    make the product unsellable at POS — POS/Console sellability is the 003
    resolved store catalog, full stop.
  - **Posting resolvability is governed by the ERPNext Item state.** A confirmed
    map whose ERPNext Item is **`disabled`** (or not `is_sales_item`) is **not
    resolvable for posting** — that line **fails-to-DLQ**, nearest 012
    `RejectionReason.category = unmapped_item` (no closer category exists in the
    fixed contract's closed set; a future contract revision MAY add a
    `disabled_item` category — named, not authored).
- **Divergence is a reconciliation case, never a silent override** [stock-impact
  §5; 013 mapping-concepts §5]: a DP2-sellable product whose ERPNext Item is
  disabled is surfaced (017) and repaired (re-enable the Item, or re-point the
  map), **never** auto-resolved by mutating either side.
- **Detection point:** the connector (the only ERPNext-aware component) learns
  the Item is disabled at post time and returns `permanently_rejected` — DP2
  dead-letters + flags. (DP2 does not pre-check ERPNext Item state — it holds no
  ERPNext credentials; O-6/§IV.)

This keeps §IX intact: ERPNext disabled-state never silently suppresses a DP2
sale or its operational catalog; it only blocks the **accounting posting**, which
is exactly what a disabled accounting Item should do.

---

## 6. OQ-6 — relationship to the inbound unknown-items queue (RATIFIED — rider R4, 2026-06-05)

> **Question (from 013 §8/§11):** How does resolving a 003 unknown-item relate to
> establishing a 013 ERPNext mapping? Do the two mechanisms collide?

**Ratified resolution: they are separate operational states — keep them strictly
distinct (they answer opposite directions).**

| Dimension | 003/006/007 `unknown-items` (inbound) | 015 unmapped-for-posting (outbound) |
|---|---|---|
| Direction | POS scan / import → DP2 | DP2 product → ERPNext posting |
| Trigger | Scanned identifier resolves to **no `tenant_product`** | A `tenant_product` (or its sale line) has **no confirmed `erpnext_item_map`** |
| Actor | POS Operator / import flow | 015-RESOLVE (posting) / Tenant Admin (mapping review) |
| Remedy | Review queue → link / create / dismiss a tenant product | Establish + **confirm** a `tenant_products ↔ ERPNext Item` map; posting fails-to-DLQ until then |

**Sequencing rule (ratified):** resolving an unknown item **creates a
`tenant_product`** — but that product **still needs a confirmed 013 mapping
before it can post**. The two steps are sequential and independent; clearing the
inbound queue does **not** auto-create an outbound mapping.

**Hard rule:** 015 **MUST NOT** route a posting/resolution failure into the
inbound `unknown-items` queue, and **MUST NOT** invent a parallel "unresolved"
mechanism that silently collides with it [013 §8]. The outbound unmapped case is
surfaced through the **DLQ + reconciliation** path (017), which is a distinct
surface from the unknown-items review queue.

---

## 7. OQ-8-bis — where line→Item resolution happens (RATIFIED — rider R2, 2026-06-05)

> **Question (a 015 design choice, not a 013 question):** Does DP2 resolve the
> sale line to an ERPNext Item **at work-item projection** (and embed the
> resolved ref), or does the **connector** resolve it from `tenantProductRef`?

**RATIFIED: DP2 resolves at projection**
([rider R2](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-rider-2026-06-05.md)).

- DP2 resolves each line's `tenantProductRef` to a confirmed `erpnext_item_map`
  row **when building the work-item**. A line that fails to resolve prevents the
  work-item from being offered on the feed and is **dead-lettered in DP2** with a
  reconciliation flag — so the connector never receives an unresolvable
  work-item.
- **Why (as ratified):** it keeps the connector free of DP2 mapping lookups, which
  is exactly the **O-1 work-item self-sufficiency** obligation (*"post WITHOUT
  reaching back into DP2"*). The connector resolves only the **ERPNext-internal**
  doctype from the DP2-terms reference (O-6), not the DP2 mapping.
- **The Connector MUST NOT** (rider R2): guess ERPNext Item identity; reach back
  into DP2 for item lookup; or maintain a second copy of DP2 mapping truth.
- **The former crux tension — RESOLVED by owner decision.** The fixed 012
  contract's `SaleLine.tenantProductRef` description states connector-side
  resolution (*"the connector maps it to an ERPNext Item (013) behind this
  contract"*) — but the 013 `erpnext_item_map` lives in DP2's database, and O-1
  forbids the connector reaching back. **Rider R2 selects DP2-side resolution and
  supersedes the contract's stated connector-side intent — on the record, not as
  a silent override.** Consequence: **015 implementation is GATED on a `[GATED]`
  012 contract correction/extension** — `SaleLine.erpnextItemRef` (or an
  equivalent resolved-ERPNext-Item payload) **plus** the correction of the stale
  connector-side wording in the `tenantProductRef` description — **required
  before 015's posting-feed implementation** (the work-item cannot carry the
  resolved Item identity without it). Named in
  [follow-up-notes.md](./follow-up-notes.md); never authored here.

---

## 8. What 015-RESOLVE explicitly does NOT do

- **Does not establish or confirm mappings** — that is 013's suggest/confirm flow
  (Tenant Admin). 015 reads confirmed rows only.
- **Does not author** the `data-model.md`, any schema/migration, or any OpenAPI
  YAML (including the `SaleLine.erpnextItemRef` field discussed in §7) — those
  are `[GATED]` follow-ups.
- **Does not author** an ERPNext item-search op, an import worker, or auto-match
  logic — v1 is manual-only (§4).
- **Does not mutate** the DP2 sale fact on a resolution failure [posting §5].
- **Does not pre-check** ERPNext Item enabled-state from DP2 (DP2 holds no
  ERPNext credentials; the connector surfaces it via `permanently_rejected`, §5).
