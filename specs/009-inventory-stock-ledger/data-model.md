# Phase 1 Data Model: Inventory & Stock Movement Ledger (009)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

**Altitude**: Design level, **not DDL**. This describes entities, fields, types-of-intent, nullability, relationships, and validation/state rules. The concrete Drizzle schema + the `0014+` SQL migration (actual `numeric(p,s)`, RLS policies, indexes, CHECK constraints, paired `*.down.sql`) are a **`[GATED]`** slice, not authored here (Constitution §VIII).

**Quantity**: exact-decimal `numeric(p,s)`, expressed in the product's single stocking unit, represented in-app as a string-backed value object (R3, no float). **Timestamps**: all `TIMESTAMPTZ` in UTC. **On-hand**: derived, compute-on-read (R1) — NOT a stored entity in v1.

---

## Entity 1 — `stock_movements` (the append-only ledger) — NEW

The single source-of-truth row for every stock change. Tenant- and store-scoped. Immutable after insert (FR-001).

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | server-generated |
| `tenant_id` | uuid FK→tenants | NN | RLS scope; **not body-assignable** (FR-052) |
| `store_id` | uuid FK→stores | NN | every movement is store-scoped (FR-002); not body-assignable |
| `movement_type` | enum | NN | `inbound` \| `outbound` \| `adjustment` \| `transfer_out` \| `transfer_in` \| `count_correction` (FR-002). **Write-off** = a reason-coded `outbound` (damaged/expired/shrinkage), distinguished by `reason`, not a separate enum member. |
| `quantity` | numeric(p,s) | NN | **signed** effect on on-hand (or magnitude + direction derived from type); exact-decimal, in the product's stocking unit (FR-022) |
| `stocking_unit` | text | NN | the unit `quantity` is expressed in; **must match the product's stocking unit** or the movement is rejected (FR-022 — no coercion) |
| `tenant_product_ref` | uuid FK→tenant_products | **NULL** | resolved Tenant Catalog product (FR-023); **nullable** because ad-hoc/unresolved references are recorded as provenance only — never auto-created (R5) |
| `reason` | text | NULL→NN by type | mandatory for `adjustment` (FR-012) and `count_correction`; optional/short for others |
| `occurred_at` | timestamptz | **NN** | business-event time (§X); backfilled/out-of-order values are normal |
| `received_at` | timestamptz | **NN** | server clock at receipt (§X); the security clock |
| `idempotency_key` | text | NULL | **lineage only** — the `Idempotency-Key` value echoed onto the row for the movement list/provenance. The dedup for manual movements lives in the **001/005 interceptor** (`idempotency_keys` table, key `(tenant_id, store_id, client_id, key)`), NOT in a `stock_movements` index. `client_id` resolves to the operator's `userId` for the cookieAuth surface (interceptor `clientId()` = `req.context.userId`). |
| `source_system` | text | NULL | provenance + dedup for **backfill/external-origin** movements (R4/FR-031) |
| `external_id` | text | NULL | provenance + dedup; paired with `source_system` |
| `sale_id` | uuid | NULL | **provenance only** — references an 008 sale (FR-032); see relationship note |
| `sale_line_id` | uuid | NULL | **provenance only** — references an 008 sale line |
| `terminal_event_ref` | uuid | NULL | **provenance only** — references an 008 void/refund terminal event for a restock (FR-025) |
| `transfer_group_id` | uuid | NULL | links a `transfer_out` to its `transfer_in` counterpart (FR-020); see Entity 3 |
| `stock_count_id` | uuid FK→stock_counts | NULL | set on a `count_correction` movement (FR-021); links to the originating count |
| `created_by` | actor ref | NN | acting principal; audited (FR-013); not body-assignable |

- **Append-only / immutability (FR-001)**: no UPDATE or DELETE by the application layer. There are **no** writable-after-insert fields. (Contrast 008's `processed_at`/`mismatch_flag` — 009 movements have no SaaS-owned mutable state.)
- **Dedup / uniqueness (FR-030/031, R4)** — two surfaces, two mechanisms, **no overlap**:
  - **manual**: dedup is the **001/005 `Idempotency-Key` interceptor, reused UNCHANGED** — it writes the `idempotency_keys` table (key `(tenant_id, store_id, client_id, key)`, `client_id` = the operator's `userId` for the cookieAuth surface) and returns the prior response on replay. `stock_movements` has **NO manual-dedup unique index** (the interceptor already guarantees exactly-once at the HTTP layer; a movement-table index would be a competing primitive, which FR-030 forbids — "no new primitive"). The `idempotency_key` column is lineage-only.
  - **backfill/external**: 009 owns ONE movement-level dedup index — partial unique on `(tenant_id, source_system, external_id)` where both NOT NULL (FR-031). This is the only unique constraint 009 adds.
  - A manual replay with the same key but a **divergent body** ⇒ deterministic conflict (the interceptor's body-fingerprint mismatch behavior, unchanged).
- **RLS**: fail-closed `current_setting('app.current_tenant', true)::uuid` (FR-050), on every row.
- **No PII / no payment** (§XIV): catalog refs, quantities, provenance ids, reason text only. `reason` is bounded + emitter-redacted; MUST NOT carry PII.
- **Lot/batch seam (FR-040/041, R-future)**: a future `stock_lot_id uuid NULL FK→stock_lots` is the **only** addition needed to make a movement lot-aware. Generic-retail movements leave it NULL and remain valid — no rewrite. The base movement deliberately does **not** carry batch/expiry columns (they live on the future `stock_lots` dimension), satisfying FR-041.

## Entity 2 — On-Hand Balance — DERIVED (not a stored entity in v1)

On-hand for a `(tenant_id, store_id, tenant_product_ref)` = signed SUM of that key's `stock_movements.quantity`, computed on read (R1/FR-003).

- **Not materialized in v1** (plan §10): no `stock_balances` table. FR-003 permits a reconstructible materialization later purely for perf; not built now.
- **Empty key** ⇒ deterministic zero / "no record" (FR-005), never an error.
- **NULL-product (ad-hoc) movements (R5)**: a movement with `tenant_product_ref IS NULL` is a **recorded ledger entry that contributes to no product's on-hand** — you cannot track stock of a thing you cannot identify. It remains fully auditable and listable (FR-004), preserves its provenance, but rolls up to no `(tenant, store, product)` balance. This keeps per-product on-hand summable and SC-001 consistent (every product's listed movements sum to its reported on-hand, and ad-hoc entries never silently distort a product balance).
- **Negative-balance signal (FR-024, R2)**: when the derived SUM for a key is `< 0`, the on-hand projection carries a **`negative_balance` flag**, and a **new OpenTelemetry counter** (`meter.createCounter`, registered in `apps/api/src/observability/metrics/api.metrics.ts` alongside the existing registrars and exported via the Prometheus exporter) of negative-balance occurrences is incremented. **Labels follow the existing `api.metrics.ts` allowlist pattern — a CLOSED, low-cardinality, PII-free set (e.g. a `reason`-style label); NOT `tenant_id`/`store_id`** (the module's `assertMetricLabels` allowlist forbids unregistered labels, and per-tenant labels are a high-cardinality + PII-adjacent anti-pattern — see the `tenant_context_failure_total` precedent which labels by `reason`, not tenant). This is the one new observability signal (plan §3.3).
- **Movement list (FR-004)**: the same key's movements returned in a **stable order** (e.g., `occurred_at`, then `id` as tiebreak), each showing type, signed quantity, timestamps, actor, reason, and provenance/linkage refs; the list sums to the reported on-hand (SC-001).

## Entity 3 — Transfer linkage — NEW (relationship)

Binds a `transfer_out` movement (source store) to its `transfer_in` movement (destination store) as one logical intra-tenant transfer (FR-020).

- **Representation**: a shared `transfer_group_id` (UUID) on both movements. (A separate `stock_transfers` header table is an acceptable alternative the migration slice MAY choose; the design requirement is only that the two movements are mutually discoverable — SC-004.)
- **Same-tenant only**: both stores belong to the same tenant; a transfer naming a cross-tenant destination store ⇒ canonical non-leaking response (FR-051).
- **Negative effect at source** follows allow-and-flag (FR-024): a transfer-out that drives source on-hand negative is still recorded + flagged, never rejected (spec US5 scenario 4).
- **Validation**: source ≠ destination store; quantity > 0 (a zero-quantity transfer is a validation error, spec Edge Cases).

## Entity 4 — `stock_counts` — NEW

A recorded physical count for a `(tenant, store, product)` that yields a `count_correction` movement for any variance (FR-021).

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | |
| `tenant_id` / `store_id` | uuid | NN | RLS scope; not body-assignable |
| `tenant_product_ref` | uuid FK→tenant_products | NULL | the counted product (nullable per R5) |
| `counted_quantity` | numeric(p,s) | NN | the physical count, in the stocking unit |
| `derived_on_hand_at_count` | numeric(p,s) | NN | the compute-on-read on-hand captured at count time (provenance for the variance) |
| `counted_at` | timestamptz | NN | server clock |
| `created_by` | actor ref | NN | audited |

- **Variance → correction (FR-021)**: the count creates a `count_correction` movement with `quantity = counted_quantity − derived_on_hand_at_count`, linked via `stock_count_id`. After the correction, derived on-hand == `counted_quantity` (SC-005).
- **Zero variance**: deterministic, documented behavior — either no correction movement or an explicit zero-quantity correction record (the migration/impl slice picks one and documents it; spec US6 scenario 2). History is never rewritten.
- **The count itself is provenance**, not a stock mutation — only the correction movement changes on-hand.

---

## Future entity (FUTURE, gated — NOT in v1) — `stock_lots`

The pharmacy-ready extension seam (FR-040..042). **Designed-for, not created in v1.**

- Optional dimension carrying `batch_lot_number`, `expiry_date`, and a product reference. A movement becomes lot-aware via a nullable `stock_lot_id` FK on `stock_movements` (Entity 1 seam note). Generic-retail products never populate it.
- **Serial is a SEPARATE optional dimension (FR-042)** — lot/batch *groups* units sharing an expiry; a serial *identifies an individual unit*. Serialized tracking adds its **own** future dimension (e.g., `stock_serials` + a nullable `stock_serial_id` FK), NOT a field on `stock_lots`. Both are NULL for generic-retail movements; a product MAY be lot-tracked, serial-tracked, both, or neither. The migration slice records the chosen shape of each before any pharmacy/serialized slice ships.
- Enables (in a later **gated** slice, with the decision recorded per FR-042): lot-level on-hand, FEFO picking, lot-preserving transfers, recall/withdrawal, returned-stock-tied-to-a-known-lot, and (via the serial dimension) per-unit serialized tracking.
- **SC-009 design check**: adding `stock_lots` / `stock_serials` + their nullable FKs does NOT rewrite any existing generic movement — verified at design review of this seam.

## Existing entities consumed (NOT modified by 009)

- **Tenant Product** (003) — the catalog source-of-truth a movement's `tenant_product_ref` resolves to. **Read-only** for 009; never auto-created from a movement (FR-023, R5).
- **008 sale / sale_line / void / refund terminal event** — referenced by `sale_id`/`sale_line_id`/`terminal_event_ref` as **provenance only**; 009 reads the **captured** rows (R8), never `processed_at`-stamped, never mutates the sale fact. The 008 composite key `(sale_id, tenant_id, store_id)` keeps a sale-linked reference tenant-scoped.
- **Idempotency record** (001/005), **Audit event** (001/005), **Actor principal** (001/002), **Outbox** (001/005) — consumed unchanged; no new primitive (FR-013/030/031).

## State & lifecycle notes

- **Movement**: `created` (immutable) — terminal on insert. There is no in-place transition; corrections/restocks/reversals are **new movements**, never edits (FR-001/012/021).
- **Mass-assignment ban (FR-052)**: `tenant_id`, `store_id`, `created_by`, `received_at`, `transfer_group_id` authority, `stock_count_id`, and any derived balance resolve server-side — never from the request body. Strict `.strict()` boundary rejects unknown keys.
- **Validation rules**: `quantity` exact-decimal in the product's stocking unit (FR-022, cross-unit rejected); `movement_type` in the allowed set (FR-002); `reason` mandatory for `adjustment`/`count_correction`; `occurred_at`/`received_at` present (§X); transfer source ≠ destination; quantity ≠ 0; sale/terminal-event references are provenance-only and never required (FR-032).
- **Data-lifecycle classification + retention (§XIV)**: `stock_movements` + `stock_counts` are **business-class** — no PII, no payment/tender in v1. Retention inherits the 001 long-horizon, insert-only posture for the immutable ledger; right-to-erasure **tombstones** any future PII field rather than deleting a movement. Recorded in the `0014_inventory.sql` migration header; a lifecycle guard test (`apps/api/test/inventory/lifecycle/classification.spec.ts`) asserts no PII/payment-class field is persisted in v1. If a later slice admits a customer-reference field, this reclassifies and re-triggers the §XIV review.
