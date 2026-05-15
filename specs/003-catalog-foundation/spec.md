# Feature Specification: Catalog Foundation

**Feature ID**: 003
**Short name**: catalog-foundation
**Status**: Clarified (no implementation)
**Created**: 2026-05-15
**Clarified**: 2026-05-15
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.0

---

## 1. Background & Why

Data-Pulse-2 Foundation (001) is complete: tenant/store context, RLS, auth,
memberships, invitations, audit foundations, and POS integration seams are in
place. POS Operator Identity (002) defines how POS-Pulse authenticates against
the platform.

Before any retail-domain feature (inventory, orders, sales, refunds, reporting,
real POS sync) can be specified or built, the platform needs a **catalog
source-of-truth model**. Without it, every downstream feature would silently
make incompatible assumptions about *which* record is authoritative for a
product, its price, its barcodes, and its tax treatment — and historical sale
facts would risk being rewritten by later catalog edits in violation of
Constitution §10.

This spec defines the **catalog foundation**: the distinct source-of-truth
layers, their relationships, the actors that operate on each, and the
boundaries that downstream features must respect. It is **specification-only**.
No application code, no migrations, no OpenAPI YAML, no schema changes.
Implementation lands in subsequent gated features after open questions are
resolved.

This feature directly operationalizes Constitution §9 (Source-of-Truth Model)
and §10 (Retail Temporal Semantics) and is the prerequisite for all retail
features that follow.

---

## 2. Goals

- Define the **Global Product Index** as a reference-only, non-authoritative
  catalog of suggestions visible to all tenants.
- Define the **Tenant Catalog** as the authoritative record of products owned
  by a tenant.
- Define the **Store Override** as the authoritative record of branch-level
  deviations (price, availability, tax treatment, etc.) from the tenant view.
- Define **Product Aliases** for barcodes, SKUs, PLUs, supplier codes, and
  external POS identifiers, with explicit uniqueness and conflict rules.
- Define **Price History** with exact-decimal money and explicit currency,
  preserving the full historical price trail.
- Define the **Unknown Item Workflow** — how a POS or import flow records an
  item it cannot resolve, without silently creating a trusted product.
- Define the **SaleLine Snapshot** concept as the future invoice truth: how
  sales records will capture catalog state at sale time so later catalog edits
  cannot retroactively rewrite history. (Concept only — not implemented here.)
- Define the actors and authorization boundaries for each layer.
- Define audit and observability requirements for catalog operations.
- Enumerate the open questions whose answers must be locked before
  implementation begins.

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, or workers.
- No `plan.md`, `tasks.md`, `data-model.md`, or contract YAML in this PR.
- No DB schema, Drizzle schema, or SQL migrations.
- No OpenAPI files, package files, lockfiles, CI changes, generated files, or
  app source modifications.
- No inventory, orders, carts, sales, payments, refunds, invoices, POS sync,
  POS app, dashboard UI, analytics, reporting, billing, dbt, ClickHouse, or
  Dagster work.
- No copying of legacy Data-Pulse code, schema, naming, or DB structure.
- No collapse of Global Catalog, Tenant Catalog, Store Override, and SaleLine
  Snapshot into a single source-of-truth record.
- No implementation of the SaleLine Snapshot itself — only the contract that
  future sales features must respect.
- No tax engine. No promotions / discount engine. No supplier / purchasing
  domain.
- No product-variant matrix engine if Q6 resolves "defer".

---

## 4. Actors

| Actor | Description |
|---|---|
| **Platform Admin** | Operates the Global Product Index. Curates global suggestions. Cannot edit tenant or store records. |
| **Tenant Owner** | Highest authority within a tenant. Manages tenant catalog and store overrides across all stores of the tenant. |
| **Tenant Admin** | Manages the Tenant Catalog: creates, edits, retires tenant-owned products. May adopt Global Product Index suggestions into the Tenant Catalog. |
| **Store Manager** | Manages Store Overrides for a specific store. Cannot create tenant-level products. Cannot edit other stores. |
| **Store Staff** | Reads the resolved catalog (tenant view + store override) for lookups. No write authority on the catalog itself. |
| **POS Device / POS Operator** *(future)* | Reads the resolved store catalog for sales and triggers the Unknown Item Workflow when a scanned identifier does not resolve. Identity is established per spec 002. |
| **Anonymous / unauthenticated** | No catalog access whatsoever. |

POS Device is included as an actor because the catalog must already model what
POS will read once spec 002 is implemented — but no POS endpoint is implemented
in this feature.

---

## 5. Source-of-Truth Layers

The catalog is organized into **four distinct layers**. Each layer has its own
authority scope and is never collapsed into another. This section is the
backbone of the spec; everything else flows from it.

### 5.1 Global Product Index — *reference only*

- **Authority**: none. Reference and suggestions only.
- **Scope**: platform-wide, visible to all tenants in a read-only suggestion
  mode.
- **Purpose**: speed up tenant onboarding by offering pre-curated product
  shells (name, default barcode candidates, suggested category, suggested tax
  category) that a tenant **may** choose to adopt.
- **Writers**: Platform Admin only.
- **Readers**: any authenticated tenant user (read-only suggestion surface).
- **Hard rules**:
  - A Global Product Index record is **never** the source of truth for any
    tenant's product.
  - It must **not** be referenced by foreign key from any tenant-owned record
    in a way that lets a platform-side edit silently mutate tenant data.
  - Adoption is **copy-on-adopt snapshot** (Q5 resolved): the tenant receives
    an independent Tenant Catalog record. Provenance is preserved via a
    `source_global_product_id` (or equivalent) reference for auditing only;
    later edits to the Global Product Index do **not** propagate to adopted
    tenant products.

### 5.2 Tenant Catalog — *tenant-owned truth*

- **Authority**: authoritative for the tenant's products.
- **Scope**: tenant-scoped. Every record carries `tenant_id`.
- **Writers**: Tenant Owner / Tenant Admin.
- **Readers**: Tenant Owner / Tenant Admin / Store Manager / Store Staff
  within the same tenant; resolved view consumed by POS reads.
- **Hard rules**:
  - The Tenant Catalog is the **source of truth** for a tenant-owned product's
    canonical fields (name, default price, default tax category, default
    availability, default aliases, status).
  - Cross-tenant access — read or write — returns a safe non-disclosing
    response (Constitution §2). A tenant must not learn about the existence
    of another tenant's products via 404 vs 403 leaks.
  - Body-supplied `tenant_id`, `store_id`, role/status/security fields, and
    audit fields are never trusted (Constitution §12). Tenant context comes
    from the authenticated principal, not the payload.

### 5.3 Store Override — *branch-level truth*

- **Authority**: authoritative for branch-level deviations from the Tenant
  Catalog.
- **Scope**: tenant-scoped **and** store-scoped. Every record carries both
  `tenant_id` and `store_id`.
- **Writers**: Tenant Owner / Tenant Admin / Store Manager of that store.
- **Readers**: same, plus Store Staff of that store; resolved view consumed by
  POS reads of that store.
- **Hard rules**:
  - Store Override is the source of truth **only for the fields it overrides**
    for the specific store. Non-overridden fields fall back to the Tenant
    Catalog.
  - A Store Override cannot exist without a corresponding Tenant Catalog
    record.
  - **Overrideable fields in v1 (Q8 resolved)**: price, availability / active
    status, and tax category / tax treatment. Canonical tenant product name
    and category are **not** overrideable at store level in v1; product
    identity remains tenant-level truth.
  - Active-store and store-access rules from Foundation (001) are enforced.
    Cross-store access — read or write — returns a safe non-disclosing
    response.

### 5.4 SaleLine Snapshot — *future invoice truth (concept only)*

- **Authority**: when implemented, authoritative for what was sold, at what
  price, with what tax, at the moment of sale.
- **Scope**: tenant-scoped, store-scoped, immutable post-write.
- **Writers**: future sales/POS ingestion path. Not implemented in this
  feature.
- **Readers**: future invoice, refund, and reporting features.
- **Hard rules** (binding on future features):
  - A SaleLine Snapshot captures the catalog state (product identity, name,
    price, currency, tax treatment, aliases used to identify) **at sale time**.
  - Historical sale facts must **not** be silently rewritten by later catalog
    edits. A price change in the Tenant Catalog or Store Override has **no
    retroactive effect** on past SaleLine Snapshots (Constitution §10).
  - Sales features built after this spec must implement snapshot capture. This
    spec records that obligation; it does not implement it.

---

## 6. Cross-cutting Concepts

### 6.1 Product Aliases

Aliases are how external systems and humans refer to a product: barcodes
(EAN/UPC), SKUs, PLUs, supplier codes, external POS IDs.

- Every alias carries an **identifier type** (e.g. `barcode`, `sku`, `plu`,
  `supplier_code`, `external_pos_id`) and a **value**.
- Aliases attach to a Tenant Catalog product. **Uniqueness is
  identifier-type-specific (Q4 resolved)**:
  - Default identifier types — `barcode` and `sku` — are **tenant-wide
    unique** (one product per `(tenant_id, identifier_type, value)`).
  - `external_pos_id` aliases must include `sourceSystem` and are unique per
    `(tenant_id, source_system, value)` per Constitution §11.
  - Store-specific aliases are allowed **only when explicitly marked
    store-scoped**, in which case uniqueness is per
    `(tenant_id, store_id, identifier_type, value)`. Aliases default to
    tenant-wide unless flagged.
- Alias resolution from a POS scan must return at most one product within the
  resolution scope. Duplicate aliases within the same scope are a **conflict
  event** and are surfaced as an observability signal (§9).
- External POS identifiers from sale ingestion follow the
  `sourceSystem + externalId` pattern (Constitution §11) and are idempotent
  by that pair.

### 6.2 Price History

- Every price change to a Tenant Catalog product or a Store Override produces
  a **price history record** preserving the previous price, the new price, the
  effective time, the actor, and the correlation id.
- Money is **exact-decimal with explicit currency**. Floating-point money is
  forbidden everywhere (Constitution §3).
- **Precision/scale (Q1 resolved)**: `numeric(19,4)` for all catalog and
  unit price fields. This accommodates weighted goods, fractional unit
  pricing, tax math, discounts, and POS-side precision beyond two decimals.
- **Currency model (Q2 resolved)**: v1 uses a **tenant default currency**,
  but every monetary record still carries an explicit `currency_code`.
  Implicit currency is forbidden; storing money without its currency is
  invalid.
- **Rounding policy (Q3 resolved)**: **line-level rounding** for
  catalog-derived display totals using **half-up** by default. Future
  invoice / sale totals received from POS are **preserved as received** and
  are **not** re-rounded by the platform (Constitution §3).
- **Price history shape (Q9 resolved)**: **effective intervals** with
  `effective_from` and `effective_to`. Historical prices are not
  destructively overwritten; a new price closes the prior interval and opens
  a new one. This supports scheduled / future-dated pricing without
  requiring a full event-sourcing model.
- Price history must never be edited or deleted by application code (audit
  immutability per Constitution §13). Corrections are recorded as new events.
- A price change must not retroactively rewrite SaleLine Snapshots (§5.4).

### 6.3 Unknown Item Workflow

When a POS scan or an import flow encounters an identifier (barcode, SKU, POS
external id) that does not resolve to any product in the resolved store
catalog:

- An **Unknown Item** record is written, capturing the identifier, the
  identifier type, the store context, the POS device / actor, the sale-time
  context if any, and a correlation id.
- The system must **not** silently create a trusted Tenant Catalog product
  from an unknown identifier. **Manual approval only in v1 (Q10 resolved)** —
  no auto-create path exists. Any future auto-create policy must be added by
  an explicit, separately-specified opt-in feature.
- An unknown item enters a review queue surfaced to Tenant Admin / Store
  Manager. Resolution paths: link to an existing product (creating an alias),
  create a new tenant-owned product, or dismiss as invalid.
- Resolution is an audited event (§8).
- POS flows must remain functional when an unknown item occurs; behavior
  during the sale (block, allow at zero, allow with manual price, etc.) is a
  future sales-feature concern and out of scope here. This spec only
  guarantees that the *recording* happens.

### 6.4 Resolved Catalog View (read model)

The "resolved store catalog" is the view that store staff and POS read:

```
Resolved(store) = Tenant Catalog ⊕ Store Override(store)
```

where `⊕` applies store overrides field-by-field over tenant defaults
(within the §5.3 overrideable-fields set).

**Read-model direction (Q12 resolved)**: future POS sync is planned as a
**snapshot + delta** model so POS terminals can operate offline. A
per-lookup endpoint may be added later as an online fallback, **not** as
the primary POS path. No endpoint is implemented in this spec; only the
seam is recorded so future contracts honor the direction.

---

## 7. Required Scenarios

The spec is accepted only if these scenarios are unambiguously supported by
the model defined in §5–§6.

| # | Scenario | Outcome the model must guarantee |
|---|---|---|
| 1 | Tenant admin creates and manages a tenant-owned product. | Record written to Tenant Catalog under `tenant_id`; no Global Product Index record is mutated; audit entry recorded; aliases attach to the new product per §6.1. |
| 2 | Tenant admin adopts a Global Product Index suggestion. | A Tenant Catalog record is created under the tenant. The Global record remains reference-only and is **not** authoritative for the new record. The adoption mode (copy-on-adopt vs link) follows the resolution of **Q5**. |
| 3 | Store manager creates a Store Override for price / availability / tax. | A Store Override record is written under `(tenant_id, store_id)`. The Tenant Catalog record is unchanged. Resolved view for that store reflects the override; other stores are unaffected. Audit entry recorded. |
| 4 | Staff / POS lookup resolves a barcode/SKU to the correct catalog view. | Lookup resolves against the resolved store catalog (§6.4). At most one product within the resolution scope. Duplicate-alias conflicts emit the observability signal in §9 instead of returning an arbitrary winner. |
| 5 | POS records an unknown item. | An Unknown Item record is written per §6.3. No Tenant Catalog product is silently created. The item enters the review queue. |
| 6 | Price change preserves history and does not mutate past sale facts. | A price history record is written per §6.2. Past SaleLine Snapshots (when sales features land) are not altered. The change is auditable to actor + correlation id. |
| 7 | Cross-tenant / cross-store access is safely rejected. | Cross-tenant read or write returns a safe non-disclosing response (Constitution §2, §12). Cross-store write outside the principal's store access is rejected the same way. No 404-vs-403 disclosure. |

---

## 8. Audit Requirements

Auditable events for this domain (Constitution §13). Every event carries
actor, tenant, store (where applicable), operation, target, timestamp,
correlation id, and outcome.

- Tenant Catalog product create / update / retire.
- Store Override create / update / remove.
- Product alias create / update / remove (and conflicts detected on write).
- Global Product Index adoption into a Tenant Catalog.
- Price change on Tenant Catalog or Store Override (with from-value /
  to-value / currency).
- Unknown Item record created.
- Unknown Item resolved (link to existing / create new / dismiss).

Audit entries are insert-only at the application layer. Corrections are new
entries, not edits.

---

## 9. Observability Requirements

Catalog signals the platform must expose (Constitution §7). No values, names,
or PII in metric labels.

- **Unknown-item rate** — count and rate per tenant / per store.
- **Duplicate-alias conflict rate** — alias writes rejected or flagged because
  the value collides within the resolution scope.
- **Catalog lookup failure rate** — POS-style lookups that returned no
  product, separated from unknown-item events.
- **Reconciliation mismatch rate** — when future POS sync runs, the rate of
  resolved-catalog vs POS-side mismatches. This metric is **named** in this
  spec; emission lands with the future sync feature.

---

## 10. Security & Authorization Boundaries

This section restates how Constitution §2 and §12 bind this feature.

- Every tenant-owned concept is tenant-scoped at the DB, API, and test
  layers.
- Every store-level concept is tenant-scoped **and** store-scoped.
- Body-supplied `tenant_id`, `store_id`, `role`, `status`, `created_by`,
  `acceptedAt`, and any other security / audit field are **never trusted**.
  Tenant and store context come from the authenticated principal and the
  active store rules established in Foundation (001).
- Cross-tenant access returns a safe non-disclosing response. The same
  non-disclosure rule applies to cross-store access outside the principal's
  store-access set.
- Default deny: a principal without an explicit permission for a layer
  cannot read or write it.
- Future POS-facing catalog endpoints must be **documented, versioned,
  authenticated, idempotent where mutating, and contract-first** in
  `packages/contracts/openapi/` (Constitution §4). This spec records that
  obligation; no contract YAML is written here.

---

## 11. Constitution Alignment

| Principle | How this spec aligns |
|---|---|
| §2 Multi-Tenant SaaS by Default | Tenant scoping at every layer; RLS fail-closed; cross-tenant 404 safe; store-scoping for branch concepts. |
| §3 Backend Authority & Data Integrity | Server-side authz; exact-decimal money + currency; uniform error envelope respected by future endpoints. |
| §4 Contract-First POS Integration | Future POS reads documented in `packages/contracts/openapi/` with stable `operationId` and non-leaky response shapes. |
| §6 Test-First Quality | Test obligations enumerated in §13; cross-tenant + cross-store sweep tests are mandatory for the future implementation feature. |
| §7 Observable Systems | Signals named in §9; no PII in labels. |
| §9 Source-of-Truth Model | Global = reference; Tenant = customer truth; Store Override = branch truth; SaleLine Snapshot = invoice truth. Layers are never collapsed. |
| §10 Retail Temporal Semantics | Price changes preserve history; past SaleLine Snapshots not silently rewritten; storage UTC. |
| §11 Idempotency & External IDs | External POS identifiers use `sourceSystem + externalId`; future ingestion is idempotent. |
| §12 Authorization & Object Safety | Body-supplied IDs / roles / statuses / audit fields not trusted; mass-assignment forbidden; safe 404 on cross-tenant. |
| §13 Auditability & Provenance | Audit event list in §8; insert-only; corrections are new events. |
| §14 PII & Data Lifecycle Discipline | Catalog data is business class (not PII), but alias supplier codes and external POS ids must respect logger-boundary redaction; soft-delete is the default for retire flows. |

---

## 12. Open Questions

> **All twelve questions resolved on 2026-05-15.** See §16 Clarifications for
> the canonical decision record. The summaries below are kept for traceability
> and as anchors so future docs can link to `Q#`.

1. **Q1 — Money precision/scale.** ✅ Resolved → `numeric(19,4)` (see §16.Q1).
2. **Q2 — Currency model.** ✅ Resolved → tenant default currency, but every
   monetary record carries `currency_code` (see §16.Q2).
3. **Q3 — Rounding policy.** ✅ Resolved → line-level half-up for
   catalog-derived totals; POS-supplied invoice totals preserved as received
   (see §16.Q3).
4. **Q4 — Alias uniqueness scope.** ✅ Resolved → identifier-type-specific;
   `barcode` / `sku` tenant-wide; `external_pos_id` requires `sourceSystem`;
   store-scoped only when explicitly marked (see §16.Q4).
5. **Q5 — Global adoption mode.** ✅ Resolved → copy-on-adopt snapshot;
   provenance preserved via `source_global_product_id`; no propagation (see
   §16.Q5).
6. **Q6 — Product variants.** ✅ Resolved → deferred from v1; model must
   remain compatible with future variants but not implement them (see
   §16.Q6).
7. **Q7 — Categories.** ✅ Resolved → flat tenant-owned categories in v1;
   tree categories deferred (see §16.Q7).
8. **Q8 — Overrideable fields in v1.** ✅ Resolved → price, availability /
   status, tax category / treatment. Canonical product name and category are
   **not** overrideable (see §16.Q8).
9. **Q9 — Price history shape.** ✅ Resolved → effective intervals
   (`effective_from`, `effective_to`); never destructively overwritten (see
   §16.Q9).
10. **Q10 — Unknown item resolution policy.** ✅ Resolved → manual approval
    only in v1; no auto-create path (see §16.Q10).
11. **Q11 — Tax metadata in v1.** ✅ Resolved → minimal tax category /
    treatment metadata; no tax engine (see §16.Q11).
12. **Q12 — Future POS catalog read model.** ✅ Resolved → snapshot + delta
    as the primary POS path; per-lookup endpoint is a later online fallback
    only (see §16.Q12).

---

## 13. Test Obligations (for the future implementation feature)

Recorded here so the future feature's `tasks.md` cannot omit them:

- Cross-tenant sweep: every catalog endpoint, both read and write, returns a
  safe non-disclosing response when the principal's tenant differs from the
  target's tenant.
- Cross-store sweep: every store-level endpoint enforces active-store /
  store-access rules from Foundation (001).
- RLS bypass probe: the runtime DB role cannot read or write cross-tenant
  catalog rows even if application checks are removed.
- Malicious override tests: body-supplied `tenant_id`, `store_id`, `role`,
  `status`, `created_by`, and audit fields are ignored.
- Price history immutability: a price change emits a new history row;
  attempts to edit or delete history rows via the application layer fail.
- SaleLine Snapshot non-rewrite: when sales features land, a fixture of past
  sales is unaffected by catalog and price edits made after the sale.
- Alias conflict: a duplicate alias within the configured uniqueness scope
  (per **Q4**) is rejected or flagged per the chosen policy, and the
  duplicate-alias conflict metric is emitted.
- Unknown item recording: a POS-shaped lookup with an unresolvable identifier
  creates exactly one Unknown Item record and does **not** create a Tenant
  Catalog product.

---

## 14. Out-of-scope Reminders

Restated to prevent scope creep during clarification:

- No DB schema, Drizzle schema, migrations, OpenAPI YAML, package files, or
  lockfiles change in this PR.
- No NestJS modules, controllers, services, workers, or tests added.
- No inventory, orders, sales, payments, refunds, invoices, dashboard, POS
  app, analytics, reporting, billing, dbt, ClickHouse, or Dagster work.
- No legacy Data-Pulse code, schema, or naming copied.
- The four source-of-truth layers (§5) are not collapsed under any future
  pressure.

---

## 15. Acceptance

This spec is accepted when:

- ✅ All twelve open questions in §12 have owner decisions recorded — done on
  2026-05-15 (see §16 Clarifications).
- The seven required scenarios in §7 are unambiguously supported by §5–§6
  under those decisions.
- Constitution alignment (§11) is reviewed and signed off.
- Only then is `plan.md` generated for this feature.

---

## 16. Clarifications

**Recorded**: 2026-05-15
**Owner**: Ahmed Shaaban
**Status**: All open questions resolved. Spec is ready for `plan.md`
generation pending §15 sign-off on scenarios + constitution alignment.

### Q1 — Money precision/scale

**Decision**: Use `numeric(19,4)` for all catalog and unit price fields.

**Rationale**: Retail catalogs need headroom for weighted goods, fractional
unit pricing, tax math, discounts, and POS-side precision beyond two
decimals. Floating-point money is forbidden everywhere (Constitution §3).

**Where it lands in the spec**: §6.2 Price History.

### Q2 — Currency model

**Decision**: v1 uses a **tenant default currency**, but every monetary
record still carries an explicit `currency_code`.

**Rationale**: Keeps the MVP simple while preserving multi-currency
readiness and preventing implicit-currency bugs. Storing money without a
currency code is invalid even if only one currency is in active use.

**Where it lands in the spec**: §6.2 Price History.

### Q3 — Rounding policy

**Decision**: Line-level rounding for catalog-derived display totals using
**half-up** by default. Future invoice / sale totals received from POS must
be **preserved as received** by the platform — POS totals are never silently
re-rounded server-side.

**Rationale**: The catalog can define pricing display behavior, but future
sales / POS ingestion must not silently rewrite POS-supplied historical
totals (Constitution §3, §10).

**Where it lands in the spec**: §6.2 Price History; binding obligation on
future sales feature for SaleLine Snapshot capture.

### Q4 — Alias uniqueness scope

**Decision**: Identifier-type-specific uniqueness:
- `barcode` and `sku` aliases are **tenant-wide unique** —
  `(tenant_id, identifier_type, value)`.
- `external_pos_id` aliases must include `sourceSystem` and are unique per
  `(tenant_id, source_system, value)` per Constitution §11.
- Store-specific aliases are allowed **only when explicitly marked
  store-scoped**, with uniqueness per
  `(tenant_id, store_id, identifier_type, value)`. Aliases default to
  tenant-wide unless flagged.

**Rationale**: Prevents accidental duplicate identifiers while preserving a
safe path for legacy store-specific POS identifiers.

**Where it lands in the spec**: §6.1 Product Aliases; §9 duplicate-alias
conflict metric.

### Q5 — Global adoption mode

**Decision**: **Copy-on-adopt snapshot.** A Tenant Catalog record created
via adoption is fully independent. Provenance is preserved via
`source_global_product_id` (or equivalent reference) for audit only. Later
edits to the Global Product Index do **not** propagate to adopted tenant
products.

**Rationale**: Global Product Index is reference-only (Constitution §9).
Tenant Catalog is the tenant's truth and must remain isolated from
platform-side edits.

**Where it lands in the spec**: §5.1 Global Product Index.

### Q6 — Product variants

**Decision**: **Defer variants from v1.** The model must remain
forward-compatible with a future variant system but must not design or
implement variants now.

**Compatibility constraint for v1**: a Tenant Catalog product is treated as
the sellable SKU itself. The product identifier strategy must not preclude
later attachment of a variant matrix (e.g. via a future
`product_variant_group_id` or `parent_product_id` column) without breaking
existing aliases, price history, or store overrides.

**Rationale**: Variants compound complexity across pricing, aliases,
inventory, and POS reads. Keep the first catalog foundation smaller.

**Where it lands in the spec**: §3 Non-Goals; future-feature constraint.

### Q7 — Categories

**Decision**: **Flat tenant-owned categories** in v1. Nested / tree
categories are deferred.

**Rationale**: Flat categories are enough for early catalog organization and
avoid premature hierarchy rules (parent moves, depth caps, cycle detection).

**Where it lands in the spec**: §5.2 Tenant Catalog; §3 Non-Goals (tree
categories explicitly deferred).

### Q8 — Store override fields in v1

**Decision**: Store Override may cover:
- **price**,
- **availability / active status**,
- **tax category / tax treatment**.

Canonical Tenant Catalog **product name** and **category** are **not**
overrideable at store level in v1.

**Rationale**: Branches commonly differ on price, availability, and tax
treatment; canonical product identity is tenant-level truth and must not be
fragmented across stores.

**Where it lands in the spec**: §5.3 Store Override (overrideable-fields
list).

### Q9 — Price history shape

**Decision**: **Effective intervals** with `effective_from` and
`effective_to`. A new price closes the prior interval and opens a new one.
Historical prices must not be destructively overwritten.

**Rationale**: Effective intervals are queryable, human-readable, support
scheduled / future-dated pricing, and don't require a full event-sourcing
model. Past prices remain reconstructible by interval lookup at any
`businessDate`.

**Where it lands in the spec**: §6.2 Price History.

### Q10 — Unknown item resolution

**Decision**: **Manual approval only in v1.** Unknown items must never
auto-create trusted Tenant Catalog products. A future opt-in auto-create
policy is possible but must be a separately-specified feature with explicit
guardrails.

**Rationale**: POS / client-supplied data is not authoritative and must not
silently pollute the tenant catalog (Constitution §9, §12).

**Where it lands in the spec**: §6.3 Unknown Item Workflow.

### Q11 — Tax metadata in v1

**Decision**: Minimal **tax category / tax treatment** metadata on Tenant
Catalog products and Store Overrides (e.g. an opaque string label such as
`standard` / `zero` / `exempt` — exact vocabulary TBD by the implementation
feature). **No tax engine.** Jurisdiction logic, rate tables, and tax
calculation are out of scope.

**Rationale**: The catalog needs tax classification hooks so future sales
can capture tax treatment in SaleLine Snapshots, but a full tax engine is a
separate domain.

**Where it lands in the spec**: §5.3 Store Override (overrideable);
§3 Non-Goals (tax engine).

### Q12 — Future POS catalog read model

**Decision**: Plan future POS sync as a **snapshot + delta** model so POS
terminals can operate offline. A per-lookup (online) endpoint may be added
later as an online fallback, **not** as the primary POS path. In this
feature, only the seam is recorded — no POS endpoint is implemented.

**Rationale**: POS must work during connectivity loss; an online-only
lookup primary path is unacceptable.

**Where it lands in the spec**: §6.4 Resolved Catalog View; binding
direction for the future POS sync feature's contract.
