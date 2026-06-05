<!--
  /speckit-plan Phase-1 data-model for 015 POS Sale Posting to ERPNext.
  PLANNING-ONLY artifact: defines entities, the work-item projection, the
  015-RESOLVE rules, and the posting-status state decision. It authorizes NO
  implementation. The new state table + its migration are a future [GATED]
  packages/db slice (Constitution §IV/§VIII, Standing Rules §3) — authoring this
  file does NOT approve that slice.
-->

# Data Model: POS Sale Posting to ERPNext

**Feature**: 015-pos-sale-posting-to-erpnext | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Contract (fixed, read-only input)**: [`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`](../../packages/contracts/openapi/erpnext-connector/posting-feed.yaml) (`1.0.0-draft`, on `main`)

---

## 0. TL;DR — one new `[GATED]` posting-status table; everything else is a read-projection

015 needs to **track, per DP2 sale (and per void/refund), the state of its ERPNext
posting** — pending → posted / dead-lettered — and to remember the ERPNext
`documentRef` for idempotency. The 008 sale fact (`0012`) carries **no** posting
columns and **must not** (the 012 contract: *"the sale fact is NEVER mutated by an
outcome — only its posting status is recorded"*). Therefore:

- **One NEW `[GATED]` state table — `erpnext_posting_status`** (provisional name) —
  records posting lifecycle + `documentRef` + DLQ/reconciliation state, tenant-scoped
  with fail-closed RLS. This is the **`015-SCHEMA` slice** ([§5](#5-gated-state-erpnext_posting_status)).
- **The `PostingWorkItem` feed is a read-projection** over the **processed** 008
  sale fact ⊕ this status table ⊕ the confirmed 013 `erpnext_item_map` ⊕ the 014
  `erpnext_warehouse_map` — **not** a stored wire row ([§3](#3-postingworkitem--read-projection-not-stored)).
- **`015-RESOLVE`** is the projection-time resolution of each line→ERPNext Item and
  the sale's store→ERPNext Warehouse; an unresolvable line/store **fails-to-DLQ in
  DP2 before the work-item is offered** ([§4](#4-015-resolve--posting-time-resolution)).

> **Central decision (recommended, pending owner sign-off): a new `[GATED]` state
> table, NOT derive-on-read.** Rationale + the rejected alternative in
> [§2](#2-the-load-bearing-decision--state-table-vs-derive-on-read). This decision
> determines that a **`015-SCHEMA` `[GATED]` slice exists**; it should be confirmed
> at dispatch (a `[SIGN-OFF]`, mirroring 010-SIGNOFF-READONLY) before the schema
> slice runs.

---

## 1. Source entities (read-only inputs — already on `main`)

015 **reads** these; it creates none of them. All are tenant-scoped (§II).

| Entity | Source | 015 uses it for |
|---|---|---|
| `sales` (header) | 008 `0012` | the sale to post: `id` (→ `saleRef`), `store_id`, `currency_code`, `pos_total`, `occurred_at`, `business_date`, `source_system`, `external_id`, **`processed_at`** (eligibility gate — must be non-NULL, 008-LIVELOOP) |
| `sale_lines` (frozen lines) | 008 `0012` | per-line projection: `line_name`, `unit_price`, `currency_code`, `quantity`, `line_amount`, `tax_amount`, `unit`, `tenant_product_id` (lineage) |
| `sale_voids` / `sale_refunds` | 008 `0012` | terminal events → `kind: reversal` work-items (`reversalOf` provenance) |
| `erpnext_item_map` | 013 `0017` | line→ERPNext Item resolution; **confirmed-only** (`state='confirmed' AND retired_at IS NULL`) |
| `erpnext_warehouse_map` | 014 `0018` | store→ERPNext Warehouse (the "Update Stock ON" target); v1 `purpose='stock'` |

> **Eligibility invariant (008-LIVELOOP).** Only a sale with **non-NULL
> `processed_at`** is projectable into a work-item. The live loop (#496/#497) sets
> `processed_at` off-request; until a sale is processed it is correctly **absent**
> from the feed (empty, not erroring). 015 does **not** define how `processed_at`
> is set (that is 008).

---

## 2. The load-bearing decision — state table vs derive-on-read

**Question.** Can the pending-posting feed + outcome status be **derived on read**
from existing tables (`0012`/`0017`/`0018`), or does 015 need a **new `[GATED]`
posting-status state table**?

**Recommendation: NEW `[GATED]` state table (`erpnext_posting_status`).** Three
converging reasons make derive-on-read infeasible, not merely less tidy:

1. **There is no source for posting status.** The 008 sale fact has **zero** posting
   columns (`0012` verified) and must stay immutable — the 012 contract is explicit:
   *"the sale fact is NEVER mutated by an outcome — only its posting status is
   recorded."* `posted` / `failed_transient` / `permanently_rejected`, the ERPNext
   `documentRef`, retry count, and the DLQ/reconciliation flag have **nowhere to
   live** without new state.
2. **Idempotency (§XI, O-3) requires remembering `documentRef`.** "Exactly-one
   ERPNext document per sale; the ack echoes the existing `documentRef` on a
   duplicate `posted`" is only enforceable if DP2 persists the `documentRef` keyed
   to `sourceSystem + externalId`. Derive-on-read cannot reconstruct an
   externally-assigned ERPNext id.
3. **Direct precedent rejected the derive/mirror alternative.** 010's analogous
   cursor feed added the **`[GATED]` `0015` change-log table** and **explicitly
   rejected the app-level outbox-mirror**; 015's need is stronger (it must store an
   external `documentRef`, which 010 did not).

**Rejected alternative — derive-on-read.** A feed computed as "sales with
`processed_at` non-NULL and no recorded outcome" has no way to record the outcome,
the `documentRef`, the retry budget, or the DLQ state — so the second pull would
re-offer an already-posted sale, breaking O-3. Rejected.

**Consequence.** A **`015-SCHEMA` `[GATED]` slice exists** (it is not optional). The
feed cursor + ordering are derived from this table (mirroring how 010's snapshot
cursor IS the `0015` sequence) — so `015-SCHEMA` is **foundational**, blocking the
feed (`015-FEED`) and the ack (`015-ACK`), not a US-local concern.

> **Owner sign-off (`[SIGN-OFF]`, recommended).** Because this decision *creates* a
> `[GATED]` `packages/db` surface, record it as a `015-SIGNOFF-STATE` decision
> (mirroring `010-SIGNOFF-READONLY`) before `015-SCHEMA` dispatches. The
> recommendation above is the proposed resolution; it is not self-approving.

---

## 3. `PostingWorkItem` — read-projection (not stored)

The work-item the connector pulls (`connectorPullPostings`) is a **projection**, not
a stored wire row (§IV — no raw DB entity crosses the wire). It is assembled at read
time from the source entities (§1) ⊕ the status table (§5) ⊕ `015-RESOLVE` (§4),
mapped 1:1 to the fixed 012 `PostingWorkItem` schema:

| 012 `PostingWorkItem` field | Derived from |
|---|---|
| `workItemRef` (uuid) | the `erpnext_posting_status` row id (stable, opaque, scope-bound) |
| `kind` (`sale_post`\|`reversal`) | sale → `sale_post`; void/refund terminal event → `reversal` |
| `sourceSystem` / `externalId` | `sales.source_system` / `sales.external_id` (the O-3 idempotency anchor) |
| `payloadHash` | `sales.payload_hash` (008 gate C; SHA-256 canonical) |
| `businessDate` | `sales.business_date` (→ ERPNext `posting_date`, §X) |
| `reversalOf` (`ReversalRef`) | present only for `kind=reversal`: the original sale's `sourceSystem`/`externalId` + `reversalKind` (`void`\|`refund`) |
| `sale` (`Sale` projection) | the 008 header + frozen lines (below) |
| `itemCursor` | the opaque advanced cursor (the status table's monotonic sequence; 010 precedent) |

**`Sale` / `SaleLine` projection** mirrors the 012 wire shape (which itself mirrors
`pos-sales/sales.yaml`): header (`saleRef`=`sales.id`, `storeId`, `currencyCode`,
`posTotal`, `occurredAt`, `businessDate`, `sourceSystem`, `externalId`) + `lines[]`.
Each `SaleLine` carries the **`erpnextItemRef` (REQUIRED)** — the DP2-resolved Item
identity from `015-RESOLVE` — plus `lineName`, `unitPrice`, `currencyCode`,
`quantity`, `lineAmount`, nullable `taxAmount`, `unit`, and optional
`tenantProductRef` (lineage only, null for ad-hoc lines).

**Money** is exact-decimal string + ISO-4217 currency end-to-end (`DecimalAmount` /
`CurrencyCode`), no float (§III). DP2 amounts are authoritative.

---

## 4. `015-RESOLVE` — posting-time resolution

Performed **DP2-side at work-item projection** (rider R2), BEFORE the work-item is
offered on the feed. Two resolutions, both fail-to-DLQ on a miss (never guess, never
substitute):

1. **Line → ERPNext Item.** Each `sale_lines.tenant_product_id` resolves to a
   **confirmed** `erpnext_item_map` row (`state='confirmed' AND retired_at IS NULL`).
   - A `suggested` (unconfirmed) mapping does **not** count → treated as unmapped.
   - **Unmapped line → fails-to-DLQ** (`unmapped_item`-class) — no "Misc"/substitute
     item (rider R3); the resolved row supplies the required `erpnextItemRef`.
   - **Ad-hoc line** (008 FR-004, null `tenant_product_id`) cannot map → same
     fails-to-DLQ posture (a reconciliation case, not a silent drop).
   - A **disabled / non-sales ERPNext Item** at posting time → fails-to-DLQ
     (`unmapped_item`/`validation`-class); **operational sellability stays
     DP2-authoritative** (rider R3 / OQ-5).
2. **Store → ERPNext Warehouse.** `sales.store_id` resolves to an
   `erpnext_warehouse_map` row (v1 `purpose='stock'`).
   - **No mapping → fails-to-DLQ** (`unmapped_store`-class) — never guess a default
     warehouse (rider R5 / OQ-8). *(Now the unhappy path only: the 014 map is on
     `main`.)*

A fails-to-DLQ outcome writes a `permanently_rejected`-class row in
`erpnext_posting_status` with the nearest 012 `RejectionReason.category`, raises a
reconciliation flag (017 surfaces it), and **never mutates the 008 sale fact**
(rider; §IX). It does **not** route into the inbound unknown-items queue (rider R4 /
OQ-6 — those are separate operational states).

---

## 5. `[GATED]` state — `erpnext_posting_status`

> **`[GATED]` `packages/db` — the `015-SCHEMA` slice.** Provisional shape for
> planning; the authoritative Drizzle schema + migration (`00NN_erpnext_posting_status.sql`
> + paired `*.down.sql`) are authored **only under that approved slice**, not here.
> Migration number assigned at dispatch (next free after `0018`).

**Grain:** one row per posting attempt target — a sale (`kind=sale_post`) or a
terminal event (`kind=reversal`). Append-or-update lifecycle (not append-only: the
outcome ack updates the row's status + `documentRef`).

> **Reversal cardinality (verified against 008 `0012`).** A sale can have **multiple
> terminal events** — `sale_voids` and `sale_refunds` are **append-only** and each
> carries its **own** `UNIQUE (tenant_id, source_system, external_id)` (distinct from
> the parent sale's). Retail allows **multiple partial refunds per sale**, and a sale
> can be both voided and refunded. So the posting-status idempotency key is keyed on
> the **originating row's own** `(source_system, external_id)` — a sale's for
> `sale_post`, the terminal event's for `reversal` — NOT the parent sale's. Keying on
> the sale would (wrongly) permit only one reversal per sale and block the 2nd
> partial refund forever. `source_ref_id` below pins the exact originating row.

| Column | Type (provisional) | Notes |
|---|---|---|
| `id` | uuid (UUIDv7, app-assigned) | = the wire `workItemRef`; B-tree locality |
| `tenant_id` | uuid | RLS axis (§II); FK → tenant |
| `store_id` | uuid | the sale's store (drives §4 warehouse resolution) |
| `sale_id` | uuid | FK → `sales.id` (the posted sale, or the reversed sale for a reversal) |
| `kind` | text enum | `sale_post` \| `reversal` |
| `source_ref_id` | uuid | the **originating row** id: `sales.id` (sale_post) or `sale_voids.id`/`sale_refunds.id` (reversal). Pins the exact target — disambiguates multiple terminal events per sale |
| `source_system` / `external_id` | text | the O-3 idempotency anchor — the **originating row's own** pair (the sale's, or the terminal event's), mirrors 008's per-table dedup |
| `payload_hash` | char(64) | gate-C provenance correlation |
| `status` | text enum | `pending` \| `posted` \| `failed_transient` \| `permanently_rejected` |
| `document_ref` | text, nullable | the ERPNext document id (set on `posted`; powers O-3 idempotent replay) |
| `rejection_category` | text, nullable | nearest 012 `RejectionReason.category` on a rejection (`unmapped_item`/`unmapped_store`/`validation`/…) |
| `retry_count` | int | transient-retry budget |
| `reversal_of_sale_id` | uuid, nullable | present for `kind=reversal` (the original sale; = `sale_id`) |
| `sequence` | bigint IDENTITY | monotonic feed-ordering / cursor source (010 precedent) |
| `created_at` / `updated_at` | timestamptz | server clocks (§X) |

**Constraints / RLS:**
- **Fail-closed RLS** on `tenant_id` (the empty-GUC `CASE` guard, 0009/0010/0012
  precedent); cross-tenant `workItemRef`/cursor is a non-disclosing 404 (§II/§XII).
- **Idempotency unique** on `(tenant_id, source_system, external_id)` — the
  originating row's own pair, mirroring 008's **per-table** dedup (`sales`,
  `sale_voids`, `sale_refunds` each have their own such unique). This naturally
  permits **multiple reversals per sale** (each terminal event has a distinct
  `external_id`) while still guaranteeing one posting target per originating row
  (O-3). `kind` is NOT part of the key (the per-row pair is already unique across
  the source tables); including it would be redundant. A composite
  `(tenant_id, source_ref_id, kind)` unique is an equivalent alternative — pick one
  in `015-SCHEMA`.
- **`document_ref`** is connector-assigned via the ack; DP2 never invents it.
- **No money columns** — amounts live on the 008 sale fact + are projected at read
  time; the status table tracks *posting state*, not the sale.

**Lifecycle (state transitions):**

```text
(sale processed_at set, eligible)
        │  projected into feed (015-RESOLVE OK)
        ▼
     pending ──ack posted──────────────▶ posted        (documentRef recorded; O-3 replay echoes it)
        │                                  
        ├──ack failed_transient──▶ pending (re-offered next pull, bounded by retry_count; NO new doc)
        │
        └──ack permanently_rejected──▶ permanently_rejected  (DLQ + reconciliation flag → 017)
                                            ▲
   (015-RESOLVE miss writes here directly, before offer)
```

The **DLQ drain + repair surface is 017** — 015 owns producing the
`permanently_rejected` state; 017 owns draining/repairing it. A repair re-post must
resolve to the **same** `document_ref` (idempotency holds across repair); never a
silent rewrite of a posted document (§IX).

---

## 6. Outcome ingestion (`connectorAckOutcome`)

The ack (`POST /…/{workItemRef}/outcome`) updates the `erpnext_posting_status` row,
never the sale fact:

- `outcome` ∈ `{posted, failed_transient, permanently_rejected}` → `status`.
- `documentRef` **required when `outcome=posted`** → `document_ref`.
- `reason` (structured) on `permanently_rejected` → `rejection_category` + the 017
  reconciliation flag.
- Reuses the existing **`Idempotency-Key` interceptor** (no new primitive): re-acking
  the *same* logical outcome replays deterministically (200, echoes `document_ref`);
  a *different* outcome for the same key is a 409 `idempotency_key_conflict` (012
  contract). §XII: body-supplied tenant/store/server-owned fields are rejected;
  scope resolves from the `connectorBearer` principal.

---

## 7. Outbox trigger — `erpnext.posting.requested` (`[GATED]`)

A processed sale (and each terminal event) becomes a **`pending`**
`erpnext_posting_status` row via the **`erpnext.posting.requested`** outbox event
type — **named** by 012/013, **not yet registered**. Registering it in
`OUTBOX_EVENT_TYPES` is a separate **`[GATED]` `packages/db`** slice (the 008-LIVELOOP
`sale.captured` registration, #496, is the precedent — emit in-transaction, consume
worker-side via a `posting-requested.consumer.ts` mirroring `SaleCapturedConsumer`).
The producer binding lives in the posting module; the event payload is IDs-only
(`sale_id` + provenance), the work-item is projected lazily on pull.

---

## 8. What this data-model does NOT define

- **No migration SQL / Drizzle schema authored** — `015-SCHEMA` `[GATED]` slice (§5).
- **No `erpnext.posting.requested` registration** — `[GATED]` (§7).
- **No edit to `posting-feed.yaml`** — consumed as fixed (read-only input).
- **No Payment Entry / tender state** — interim SI-only mode (rider R1); PE is a
  later, separately-gated arc (DP2 tender model → 012 payment extension → connector
  PE → payment repair).
- **No 017 reconciliation-run / DLQ-drain machinery** — 015 produces the
  `permanently_rejected` state; 017 drains + repairs + surfaces it.
- **No connector code** — the posting adapter lives in the connector repo (ADR 0008).
