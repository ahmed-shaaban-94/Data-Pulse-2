# Phase 1 Data Model: Sales / Transaction Capture (008)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Gate**: [gate-money-temporal.md](./gate-money-temporal.md)

**Altitude**: Design level, **not DDL**. This describes entities, fields, types-of-intent, nullability, relationships, and validation/state rules. The concrete Drizzle schema + the `0012+` SQL migration (with the actual `numeric(p,s)`, RLS policies, indexes, CHECK constraints) are a **`[GATED]`** slice, not authored here (Constitution §VIII).

**Money**: every monetary field is exact-decimal `numeric(19,4)` + an ISO-4217 `currency_code` (gate A.1). Represented in-app as a string-backed value object (gate A.6, no float). **Timestamps**: all `TIMESTAMPTZ` in UTC (FR-021). Nullability follows gate B (R6).

---

## Entity 1 — `sales` (invoice/transaction header) — NEW

The immutable sale fact. Tenant- and store-scoped. One row per logical `(tenant, sourceSystem, externalId)` (dedup, FR-050).

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | server-generated |
| `tenant_id` | uuid FK→tenants | NN | RLS scope; **not body-assignable** (FR-061) |
| `store_id` | uuid FK→stores | NN | every sale is store-scoped (FR-001); not body-assignable |
| `currency_code` | char(3) ISO-4217 | NN | submission currency, preserved as received (FR-030) |
| `pos_total` | numeric(19,4) | NN | POS-reported total, **preserved verbatim** (FR-030); never rewritten |
| `occurred_at` | timestamptz | **NN** | business-event time (gate B) |
| `received_at` | timestamptz | **NN** | server clock at receipt (gate B); security clock |
| `business_date` | date | **NN** | derived from **store timezone** (FR-023), not client clock |
| `processed_at` | timestamptz | NULL | null-until-processed, set off-request (§V); SaaS-owned (FR-071) |
| `source_clock_at` | timestamptz | NULL | POS-reported clock, preserved; **never** a security clock (FR-022); POS may omit |
| `source_system` | text | NN | provenance + dedup key (FR-040/041) |
| `external_id` | text | NN | provenance + dedup key; not body-assignable authority |
| `payload_hash` | text (sha256 hex) | NN | SHA-256 over canonical (sorted-key) JSON of the full payload (gate C) |
| `mismatch_flag` | boolean / enum | NULL→default | advisory; SaaS-owned processing state (FR-031/032); not POS-supplied |
| `created_by` | actor ref | NN | acting principal (POS device); not body-assignable |

- **Uniqueness**: `(tenant_id, source_system, external_id)` unique — the dedup contract (FR-050/041). Cross-tenant `external_id` collisions are isolated (SI-001).
- **Immutability**: append-only after capture; the only writable-after-insert fields are `processed_at` + `mismatch_flag` (SaaS-owned, idempotent, FR-071). No `version` column (gate D.1).
- **RLS**: fail-closed `current_setting('app.current_tenant', true)::uuid` (FR-060).
- **No tender / payment fields** (gate A.5, deferred to 010).

## Entity 2 — `sale_lines` (per-line snapshot) — NEW

One row per sold line; child of `sales`. **Snapshot frozen at capture** (FR-002/003).

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | |
| `sale_id` | uuid FK→sales | NN | parent |
| `tenant_id` / `store_id` | uuid | NN | consistent with parent; RLS |
| `line_name` | text | NN | **snapshot** of item name as charged (frozen) |
| `unit_price` | numeric(19,4) | NN | **snapshot** of price as charged (frozen) |
| `currency_code` | char(3) | NN | matches parent currency |
| `quantity` | numeric | NN | line quantity as reported |
| `line_amount` | numeric(19,4) | NN | POS-reported line amount, preserved |
| `tax_amount` | numeric(19,4) | NULL→0 | **single per-line tax amount, snapshot** (gate A.2); SaaS does not recompute |
| `unit` | text | NN | **snapshot** of unit as charged (frozen) |
| `tenant_product_ref` | uuid FK→tenant_products | NULL | optional lineage only (FR-003); **nullable** because ad-hoc lines exist (FR-004) |

- **Snapshot discipline (FR-003)**: `line_name`/`unit_price`/`tax_amount`/`unit` are frozen — later changes to the referenced Tenant Product / Store Override / price history MUST NOT mutate any existing `sale_line`. `tenant_product_ref` is lineage, never the source of live values.
- **Ad-hoc lines (FR-004)**: a line with no resolvable tenant product still snapshots price/name/tax/unit; 008 MUST NOT auto-create a tenant product from a sale line.
- **Timestamps**: lines **inherit** the parent's `occurred_at`/`business_date` (gate B — no own copies).

## Entity 3 — Void terminal event — NEW

A separate append-only record referencing a `sales` row (FR-010/011). Never mutates the original sale.

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | |
| `sale_id` | uuid FK→sales | NN | the voided sale |
| `tenant_id` / `store_id` | uuid | NN | RLS, consistent with the sale |
| `voided_at` | timestamptz | **NN** | terminal stamp, server clock (gate B / FR-011) |
| `source_system` / `external_id` | text | NN | provenance + dedup for the terminal event (FR-013) |
| `payload_hash` | text | NN | SHA-256 canonical (gate C) |
| `created_by` | actor ref | NN | acting principal; audited (FR-090) |

- **Idempotent** on `(tenant, source_system, external_id)`; a second void ⇒ deterministic already-voided outcome, no duplicate (FR-013).

## Entity 4 — Refund terminal event — NEW

Same shape as void, referencing a `sales` row (FR-010/012). Workflow depth out of scope (FR-015).

| Field (intent) | Type intent | Null? | Notes |
|---|---|---|---|
| `id` | UUIDv7 PK | NN | |
| `sale_id` | uuid FK→sales | NN | the refunded sale |
| `tenant_id` / `store_id` | uuid | NN | RLS |
| `refunded_at` | timestamptz | **NN** | terminal stamp, server clock (gate B / FR-012) |
| `pos_refund_amount` | numeric(19,4) | NN | POS-reported refund amount, **preserved** (FR-012/030) |
| `currency_code` | char(3) | NN | |
| `source_system` / `external_id` | text | NN | provenance + dedup (FR-013) |
| `payload_hash` | text | NN | SHA-256 canonical |
| `created_by` | actor ref | NN | audited |

- **Idempotent** on `(tenant, source_system, external_id)` (FR-013); POS refund amounts preserved, SaaS MAY flag a mismatch but never rewrites (FR-030/031).

---

## Existing entities consumed (NOT modified by 008)

- **Tenant Product / Store Override / Price History** (003) — the catalog source-of-truth a `sale_line` snapshots **from**. Read-only for 008.
- **Unknown Item** (003/005) — the catalog-reconciliation signal; **complementary to, not part of,** the sale fact (plan §4.3, FR-004). Distinct record.
- **Idempotency record** (001/005), **Audit event** (001/005), **Actor principal** (001/002) — consumed unchanged; no new primitive (FR-051/090).

## State & lifecycle notes

- **Sale**: `captured` (immutable) → may have ≥0 append-only void/refund terminal events layered on top. No in-place transition; "voided"/"refunded" are derived from the presence of terminal events, not a mutable status on the sale.
- **Mass-assignment ban (FR-061)**: `tenant_id`, `store_id`, `created_by`, `source_system`/`external_id` authority, `business_date`, `received_at`, `processed_at`, `mismatch_flag` resolve server-side — never from the request body. Strict `.strict()` boundary rejects unknown keys (FR-062).
- **Validation rules**: currency required + ISO-4217 (FR-005); `pos_total`/`line_amount`/`tax_amount` exact-decimal (no float); `occurred_at`/`received_at`/`business_date` present (gate B); payload hash computed server-side over canonical JSON (gate C).
- **Data-lifecycle classification + retention (SI-012 / gate D.3, §XIV)**: the four entities (`sales`, `sale_lines`, `sale_voids`, `sale_refunds`) are **business-class** — catalog references, quantities, and POS-reported totals only; **no PII and no payment/tender data in v1** (tender deferred per gate A.5). Retention **inherits the 001 long-horizon, insert-only audit-retention posture** for the immutable fact; right-to-erasure **tombstones** any future PII field rather than deleting the fact row. If a later slice admits a customer-reference or tender field, this **reclassifies** (PII/payment-class) and re-triggers SI-012. The classification is also recorded in the `0012_sales.sql` migration header; the future **008-LIFECYCLE** slice will add a guard test (`apps/api/test/catalog/sales/lifecycle/classification.spec.ts`) asserting no PII/payment-class field is persisted in v1. (That test is not part of this schema slice and does not yet exist on `main`.)
