# Phase 1 Data Model: Console Sync-Ops Read-Model v1

**Branch**: `025-console-sync-ops-read-model-v1` | **Date**: 2026-06-07

> **No new persistence.** 025 introduces **no table, no migration, no Drizzle schema
> change**. Everything below is a **read-only projection (wire shape)** computed on read
> from existing source tables. The "Source" column names the existing table/column the
> projection reads; the read-model never writes to any of them. RLS posture is inherited
> from the source tables and enforced via `runWithTenantContext`.

## Source tables read (existing — unchanged)

| Source | Owner spec | Read posture | RLS |
|---|---|---|---|
| `erpnext_posting_status` | 015 | SELECT only (status counts + `permanently_rejected` rows) | tenant-scoped, fail-closed |
| `erpnext_reconciliation_run` | 017 | SELECT only (latest + history) | tenant-scoped, fail-closed |
| `erpnext_reconciliation_result` | 017 | SELECT only (open-mismatch counts, per-class summary) | tenant-scoped, fail-closed |

> The exact column names belong to the 015/017 schemas already on `main`; v1 reads them
> through those modules' existing read helpers / Drizzle selects. No column is added.

## Projection entities (wire shapes — not persisted)

### SyncOpsSummary
The single aggregated per-tenant (store-filterable) health view.

| Field | Type | Source / derivation | Notes |
|---|---|---|---|
| `tenant_id` | uuid (echo) | resolved server-side context | never from body |
| `store_id` | uuid \| null | optional store filter | null = all in-scope stores |
| `domains` | DomainSummary[] | one per sync-ops domain | always includes all 4 domains |
| `generated_at` | timestamptz | server clock | recompute marker |

**Relationships**: composes exactly one `DomainSummary` per domain
(posting, reconciliation, connector_health, product_master).

### DomainSummary
Per-domain operational state; forward-compatible so deferred domains render cleanly.

| Field | Type | Source / derivation | Notes |
|---|---|---|---|
| `domain` | enum(`posting`,`reconciliation`,`connector_health`,`product_master`) | fixed | |
| `status` | enum(`ok`,`attention`,`not_available`) | derived | `not_available` for 020/021 in v1 |
| `counts` | object \| null | domain-specific | null when `not_available` |

Domain-specific `counts` (when available):
- **posting**: `{ posted, pending, dead_lettered }` — from `erpnext_posting_status`
  grouped by status (`dead_lettered` = `permanently_rejected`). `status=attention` when
  `dead_lettered > 0`.
- **reconciliation**: `{ latest_run_status, latest_run_at, open_mismatches }` — latest
  `erpnext_reconciliation_run` + open `erpnext_reconciliation_result` count.
  `status=attention` when `open_mismatches > 0` or latest run `failed`.
- **connector_health** (020) / **product_master** (021): `counts = null`,
  `status = not_available` in v1.

### PostingBacklogItem
Projection of one 015 `erpnext_posting_status` row where `status='permanently_rejected'`.
Wire field names are camelCase (matching the shipped `console-sync-ops.yaml`).

| Field | Type | Source | Notes |
|---|---|---|---|
| `postingStatusId` | uuid | 015 `id` | opaque operator reference |
| `kind` | enum(`sale_post`,`reversal`) | 015 `kind` | |
| `sourceSystem` | string | 015 `source_system` | provenance |
| `externalId` | string | 015 `external_id` | provenance |
| `status` | enum(`permanently_rejected`) | 015 `status` | always `permanently_rejected` (the backlog is dead-letters only) |
| `rejectionClass` | string \| null | 015 `rejection_category` | for grouping; null if not recorded |
| `deadLetteredAt` | date-time | 015 `updated_at` | UTC |

**Read-only**: no repair affordance, no internal columns, no credential/hash material.
**No money:** the 015 source table carries no money/valuation column, so this projection
has none (the contract banned-field scan enforces it).

### ReconciliationRunView
Projection of one 017 `erpnext_reconciliation_run` row.

| Field | Type | Source | Notes |
|---|---|---|---|
| `runId` | uuid | 017 `id` | |
| `storeId` | uuid | 017 `store_id` | |
| `kind` | enum(`stock`) | 017 `kind` | stock-only in v1 |
| `trigger` | enum(`on_demand`,`scheduled`) | 017 `trigger` | |
| `status` | enum(`running`,`completed`,`failed`) | 017 `status` | matches the DB CHECK (no `pending`) |
| `startedAt` | date-time | 017 `started_at` | UTC |
| `finishedAt` | date-time \| null | 017 `finished_at` | null while `running` |
| `mismatchSummary` | object \| null | 017 run `summary` jsonb | per-class counts (014 vocabulary); null if none |

### Per-endpoint page schemas (list responses)
Each list op has its OWN page schema (NOT a shared `oneOf` envelope) so the Console's
`openapi-typescript` generator produces a homogeneous, fully-typed `items` array per
endpoint: **`PostingBacklogPage`** (`items: PostingBacklogItem[]`) and
**`ReconciliationRunPage`** (`items: ReconciliationRunView[]`).

| Field | Type | Notes |
|---|---|---|
| `items` | (per-endpoint item)[] | bounded by `page_size` (default 50, max 200) |
| `nextCursor` | string \| null | opaque; null = last page. Backlog cursor = the `sequence` token; run-history cursor = the composite `<startedAtISO>\|<runId>` keyset token (started_at is not unique, so the UUIDv7 id tiebreaks for a stable, gap-free page boundary). |

## Validation & boundary rules

- **Request DTOs** use Zod `.strict()` — unknown keys rejected (§XII).
- `tenant_id` / `store_id` for authority resolve from **server-side context**, never
  from the request body (§XII). The store filter is validated against the operator's
  in-scope stores; an out-of-scope store yields the canonical non-disclosing response.
- List queries (`cursor`, `page_size`, `sort`, `group_by`, `store_id` filter) are
  bounded and validated; `page_size` is clamped to a max.

## RLS / isolation posture

- Every read executes inside `runWithTenantContext` so the source tables' RLS scopes
  rows to the active tenant; an **unset GUC fails closed** (no rows), never cross-tenant.
- Cross-tenant / cross-store references are **non-disclosing** (canonical 404 shape;
  §II / §XII) — the read-model never reveals another tenant's existence or volume.
- No `BYPASSRLS`; no SECURITY DEFINER bypass. The read-model is a pure tenant-scoped
  reader.

## What this model deliberately does NOT contain

- No new table, no migration, no Drizzle schema entry.
- No write/mutation field, no repair/run-trigger affordance.
- No materialized/cached copy of source rows (recompute-on-read).
- No new PII class — only provenance + operational state already visible via 015/017.
