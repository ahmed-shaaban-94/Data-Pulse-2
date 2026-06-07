# Phase 1 Data Model: Sales-Posting Command Contract v1

**Feature**: 023-sales-posting-command-contract-v1 | **Date**: 2026-06-07 | **Constitution**: v3.0.1

> **No new persistent storage.** 023 is a contract spec. It introduces **NO new
> DB table, NO Drizzle schema, NO migration.** The persistent state it relies on
> (posting work-items, posting status, DLQ, reconciliation) is owned by 015 and
> 017 and is reused as-is. The "entities" below are **wire shapes** (OpenAPI
> schemas) the eventual `[GATED]` contract YAML will define — they are projections
> (§IV), not database rows.

---

## Wire entities (OpenAPI schemas — described, not authored here)

All shapes are reused **verbatim** from the 012 `posting-feed.yaml` unless noted.
They are copied self-contained per file (the 008/010/012 convention), not
cross-`$ref`'d across files.

### PostingCommandResult (the command fetch response) — reuses `PostingWorkItem`

The command operation returns the existing `PostingWorkItem` shape (no new
schema):

| Field | Type | Notes |
|---|---|---|
| `workItemRef` | string (uuid) | Stable, opaque, scope-bound. Echoed on the outcome ack. |
| `kind` | enum `sale_post` \| `reversal` | Distinguishes fresh post from reversal. |
| `sourceSystem` | string | Provenance + dedup key (008). |
| `externalId` | string | POS-side sale id; with `sourceSystem` forms the stable key (O-3). |
| `payloadHash` | string (sha256) | Canonical-payload provenance (gate C). |
| `businessDate` | string (date) | Drives ERPNext `posting_date` (§X). Never post-time. |
| `reversalOf` | `ReversalRef` \| null | Present only when `kind = reversal` (O-4). |
| `sale` | `Sale` | The 008 sale projection (below). |

> **Difference from 012**: the feed page carries an `itemCursor` per item; the
> command result does **not** (no cursor in a command transport). This is the one
> field the command response omits.

### Sale (wire projection of an 008 sale) — verbatim from 012

| Field | Type | Notes |
|---|---|---|
| `saleRef` | string (uuid) | = `sales.id`. |
| `storeId` | string (uuid) | Mapped to ERPNext company/warehouse by the connector (013/014), behind the contract. |
| `currencyCode` | `CurrencyCode` (ISO-4217) | Preserved as received. |
| `posTotal` | `DecimalAmount` | Sale total — NOT tender (gate A.5). |
| `occurredAt` | string (date-time) | Business-event time at the POS (008). |
| `businessDate` | string (date) | Derived from store timezone (008). |
| `sourceSystem` / `externalId` | string | Provenance. |
| `lines` | `SaleLine[]` (minItems 1) | Frozen line snapshots. |

### SaleLine — verbatim from 012

| Field | Type | Notes |
|---|---|---|
| `lineName` | string | Frozen snapshot name. |
| `unitPrice` / `lineAmount` | `DecimalAmount` | Exact-decimal string, never float. |
| `currencyCode` | `CurrencyCode` | Per-line currency. |
| `quantity` | string (decimal pattern) | Exact-decimal, never float. |
| `taxAmount` | `DecimalAmount` \| null | Per-line snapshot tax; null when not reported. |
| `unit` | string | Unit of measure. |
| `erpnextItemRef` | `ErpnextItemRef` (REQUIRED) | DP2-resolved (013) at projection; the connector applies it, never looks up (rider R2). |
| `tenantProductRef` | string (uuid) \| null | Lineage only (008 FR-004); not the posting identity. |

### OutcomeAckRequest (connector → DP2) — verbatim from 012

| Field | Type | Notes |
|---|---|---|
| `outcome` | enum `posted` \| `failed_transient` \| `permanently_rejected` | Discrete outcome (O-2). |
| `documentRef` | `ErpnextDocumentRef` \| null | REQUIRED on `posted`; echoed on idempotent duplicate (O-3). |
| `etaStatus` | `EtaStatus` \| null | 016 passthrough; null until ETA is live. |
| `reason` | `RejectionReason` \| null | REQUIRED on `permanently_rejected` (drives 017 flag). |

Strict body (`additionalProperties: false`); scope NOT body-supplied (§XII).

### RecordedOutcome (DP2 → connector response) — verbatim from 012

| Field | Type | Notes |
|---|---|---|
| `workItemRef` | string (uuid) | |
| `outcome` | enum | The recorded outcome. |
| `documentRef` | `ErpnextDocumentRef` \| null | |
| `recordedAt` | string (date-time) | Server clock (the security clock, §X). |
| `dlqueued` | boolean | True when a `permanently_rejected` outcome dead-lettered + raised a 017 flag. |

### Shared value shapes — verbatim from 012

- `DecimalAmount` — exact-decimal string, pattern `^-?[0-9]{1,15}(\.[0-9]{1,4})?$`, `numeric(19,4)`. Never float (gate A.6).
- `CurrencyCode` — ISO-4217 `^[A-Z]{3}$`.
- `ReversalRef` — `{ sourceSystem, externalId, reversalKind: void|refund }` (O-4).
- `ErpnextDocumentRef` — `{ doctype, name }` generic addressing (O-6).
- `ErpnextItemRef` — `{ doctype: const "Item", name }` (O-6; the 013 `erpnext_item_ref`).
- `RejectionReason` — `{ category: validation|closed_period|unmapped_item|unmapped_account|other, message }`.
- `EtaStatus` — `{ state: submitted|accepted|rejected|pending, uuid? }` (016 passthrough).
- `Error` — canonical `{ error: { code, message, request_id } }`.

---

## Relationships

```text
Connector principal (connectorBearer, tenant-scoped machine)
   │  invokes
   ▼
connectorExecutePostingCommand(workItemRef)  ──returns──▶  PostingWorkItem { sale, lines[erpnextItemRef], reversalOf? }
   │
   │  connector posts to ERPNext (outside DP2)
   ▼
connectorAckPostingCommand(workItemRef, OutcomeAckRequest)  ──advances──▶  015 posting status
                                                            ──on perm-reject──▶  017 DLQ + reconciliation flag
                                                            ──never──▶  mutate 008 sale fact
```

- A `workItemRef` resolves only within the principal's tenant scope; otherwise
  non-disclosing `not_found` (§II/§XII).
- A `reversal` work-item references the original sale's provenance via
  `reversalOf` (O-4).
- The outcome ack reuses the 015 posting-status state machine and the 017
  reconciliation surface — no new state.

---

## RLS & isolation posture

- **No new table → no new RLS policy authored by 023.** The underlying 015
  posting-status / 017 reconciliation tables already carry fail-closed,
  tenant-scoped RLS (`current_setting('app.current_tenant', true)::uuid`).
- The command operations are tenant-scoped through the authenticated
  `connectorBearer` principal; the eventual handler sets tenant context before any
  DB read (§V worker/handler discipline) — an implementation concern, recorded
  here for the implementation spec.
- Cross-tenant `workItemRef` lookups MUST return zero rows / non-disclosing
  `not_found` (the standard cross-tenant sweep + RLS-bypass-probe tests apply to
  the eventual handler, §VI).

---

## Money, temporal, provenance discipline (carried, not redefined)

- **Money**: every monetary field is `DecimalAmount` (string) + `CurrencyCode`;
  no float (gate A.6) — identical to 012.
- **Temporal**: `businessDate` (date) drives ERPNext `posting_date`; `recordedAt`
  is the server clock; reversals are separate work-items, never edits (§X).
- **Provenance**: `sourceSystem` + `externalId` + `payloadHash` carried on the
  work-item (§XIII); `payloadHash` is NOT echoed in the outcome response (§IV no
  over-disclosure).
