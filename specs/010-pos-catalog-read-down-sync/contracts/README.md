# Contracts — 010 POS Catalogue Read-Down Sync

**Status**: Obligations only — final OpenAPI YAML deferred to a `[GATED]` contract slice.
**Plan**: [../plan.md](../plan.md) · **Spec**: [../spec.md](../spec.md) · **Research**: [../research.md](../research.md)
**Created**: 2026-06-01

---

## Why this directory has no `*.yaml`

`packages/contracts/openapi/**` is a `[GATED]` surface (Constitution §IV source-of-truth + Standing Rules §3): it requires explicit per-slice approval before any tool edits it. `/speckit-plan` authors **no** YAML — exactly as 005 deferred its contract. The canonical location for the eventual contract is **`packages/contracts/openapi/catalog/read-down.yaml`** (sibling to `unknown-items.yaml`).

**Do not author OpenAPI YAML here.** This README enumerates what the eventual YAML MUST satisfy.

---

## Anticipated operationIds

| operationId | Path | Purpose | Spec FRs |
|---|---|---|---|
| `posGetCatalogSnapshot` | `GET /api/pos/v1/catalog/snapshot` | Full resolved sellable store catalogue at a server-issued cursor; cursor-paginated. | FR-010…FR-013, FR-050…FR-053 |
| `posGetCatalogDeltas` | `GET /api/pos/v1/catalog/deltas` (`?since=<cursor>`) | Ordered, idempotent, gap-detectable `upsert` / `remove_from_sellable` changes after a cursor. | FR-020…FR-024, FR-042 |

`operationId` renames are breaking (§IV). Version segment `/api/pos/v1/`.

## Authentication & scoping

- **Security**: device-principal (002 terminal device token), NOT the manager Clerk-JWT scheme. A dedicated `posDeviceAuth` security scheme.
- Scope = the authenticated device's `(tenant_id, store_id)` ONLY. Wire term `branch_id` (uuid) mapped internally to `store_id` — reuse the `pos-operators` / `pos-audit-events` convention. A supplied `branch_id` is validated against token scope; mismatch → non-disclosing rejection.
- Cross-tenant/cross-store → **non-disclosing 404-class** (no exists/not-exists disclosure). Unresolved store context → `store_context_required`.

## Cursor & idempotency

- Cursor is **opaque, monotonic, scope-bound** (R2). Snapshot returns the current cursor; delta advances it.
- **Idempotent replay** (§XI / FR-021): same `since` cursor → same logical change set, safe to re-apply.
- Unservable/stale cursor → **`snapshot_required`** outcome (FR-023) directing a re-baseline.
- Duplicate-event rule (§IV): documented as cursor-replay idempotency (read-only; no write-conflict policy — R3).

## Payload

Each sellable row carries the [data-model §1](../data-model.md) wire shape: `product_id`, `sku`, `name_ar` (NOT NULL), `name_en`, `aliases[]`, `price { amount, currency_code }`, `tax_category`, `unit_pack_label`, `active`, `controlled_substance`, `prescription_required`, `row_cursor`. **No raw DB entity** (§IV `toBody()` projection). **Never a float** — `amount` is the existing `DecimalAmount` string at the currency's natural minor precision; single currency per `(tenant, store)` v1.

## Sellable-stream + null-price (Decisions #2/#3)

- Snapshot + upsert deltas emit ONLY sellable, priced, representable rows (R5).
- A product leaving the sellable stream (retire OR became-unpriced/non-representable) → `remove_from_sellable` delta (FR-042).
- Omitted unpriced products → observability signal + backlog data (R6); NEVER in the stream, NEVER to a cashier. No admin UI in this feature.

## Failure / error taxonomy (closed set the YAML must document)

- `snapshot_required` (stale/unservable cursor)
- non-disclosing 404-class (cross-tenant/store; scope mismatch)
- `store_context_required` (unresolved store)
- standard auth failures (missing/invalid/revoked device token)
- Responses MUST document each; no internal identifiers leaked.

## Transport / integrity

- JSON + gzip; snapshot cursor-paginated (`next_page_token`, consistent cursor point across pages); inline JSON (not fetch-by-URL) v1.
- v1 integrity = TLS + device-auth; optional content-hash/ETag. Detached signing deferred (R7).

## Observability (FR-070)

- `catalog_lookup_failure_rate`, `reconciliation_mismatch_rate` (003 §9), and the new `catalog_unpriced_issue_rate` (R6). No values/PII in labels.

## Contract tests (§VI test-first)

The gated contract slice ships with contract tests enforcing: scoping/non-disclosure, cursor idempotency + `snapshot_required`, sellable-only + removal tombstone, decimal-money shape, and the closed error set. Code conforms to the YAML; tests enforce conformance.

---

## When this README becomes obsolete

When the `[GATED]` contract slice authors `packages/contracts/openapi/catalog/read-down.yaml`, this "obligations" section MAY be retired (or kept as a cross-reference). The README stays to document the deferral.
