# Phase 1 Data Model (PROSE) — Spec 032

**SPECIFY-ONLY.** This is a conceptual entity/status description for planning. It contains **no SQL, no DDL, no migration file, no column types**. The actual schema and migration `0025` are authored by the owner-gated implementation slice (Principle VIII approval). Nothing here re-decides a §13 owner decision.

## Entity: Captured Sale (existing — reference only)

The captured sale already ships in `apps/api/src/catalog/sales/`. This slice does **not** redefine it. Relevant existing properties (per spec §6 and Constitution IX/X):

- Provenance: `sourceSystem`, `externalId`, ingestion timestamps, payload hash (028 / Principle XIII).
- SaleLine snapshot is the invoice truth (Principle IX) — past lines are immutable; void/refund are modeled as separate terminal events (Principle X), never mutations.
- Money preserved as received (Principle III); not rewritten by DP-2.

This slice **adds** a server-authoritative status association to this entity (below); it does not alter sale-fact fields.

## New concept: Server-Authoritative Sale-Status

- **Ownership**: DP-2 sets it; POS never overrides (§7, the terminal observes / DP-2 decides).
- **Vocabulary (conceptual, not a DB enum here)**: `captured` → `synced` | `failed-retryable` | `failed-needs-repair`. Maps to the Spec-029 §6 terminal-visible states; the exact mapping is documented by the slice.
- **Distinct from POS-local outbox UX state** — that is a terminal-side concept; this is the server view the Console reads.
- **Temporal**: transitions stamped on the **server clock** (Principle X); `receivedAt`/`processedAt` semantics apply. `sourceClockAt` (POS-reported) is preserved, never used for security/ordering decisions.
- **Deferred to the slice**: whether status is a column on the sale record or a related row; the precise enum values and allowed transitions; indexes for the tenant+store newest-first read.

## New concept: L1 Idempotency-Key record (engaging the existing seam)

- **Contract**: the platform `idempotency_keys` mechanism, keyed by `(tenant_id, store_id, client_id, key)` with a server-clock TTL (Constitution "Idempotency & External IDs").
- **Scope this slice**: capture only (the broader "all POS write ops" scope is OPEN — §13 item 2).
- **Behavior**: replay of the same key with the same body returns the prior response, no re-apply (Principle XI). Key conflict (different body) → `409` request-level (§8 table).
- **Relationship to L2**: L1 is request-level; L2 (`tenant_id, source_system, external_id` atomic dedup) is fact-level and remains LIVE (F-4). Both together guarantee replay → same sale, no duplicate (G5).

## New concept: Dead-Letter / NEEDS_REPAIR quarantine

- **Purpose**: hold non-retryable failed syncs with **provenance intact** (028), never a silent drop (Principle V/XIII).
- **Classification source**: the §8 refusal taxonomy (401/403 → 028; 409 live provenance-conflict preserved; 422 validation/AlreadyApplied-OPEN; transient → RETRYABLE).
- **Read exposure**: feeds the §9 NEEDS_REPAIR list — tenant + store scoped, newest-first, keyset/cursor paginated (clarify session 2026-06-12).
- **Repair**: server-mediated, audited, acts only on DP-2-classified NEEDS_REPAIR; never a sale-fact rewrite; no POS-local override (authority confirmation OPEN — §13 item 3).
- **Deferred to the slice**: storage shape (table vs append-only), retention, and the exact provenance fields carried.

## Cross-tenant / isolation posture

- All new concepts are tenant- and store-scoped with RLS fail-closed (Principle II).
- Cross-tenant lookups on the read surface return safe-404 (Principle II / XII), not 403.
- The runtime DB role does not bypass RLS; the drain worker establishes tenant context before DB access (Principle V).

## What this model intentionally does NOT define

- No `payments.confirm`/`settled_at`/tender-settlement entity (F-2 — does not exist, not invented).
- No re-registration of the `sale.captured` outbox event (F-5).
- No rebuild of the live L2 dedup (F-4).
- No SQL, no migration `0025` DDL (slice-authored, Principle VIII).
