# Feature Specification: POS Catalogue Read-Down Sync

**Feature ID**: 010
**Short name**: pos-catalog-read-down-sync
**Feature Branch**: `[010-pos-catalog-read-down-sync]` (branch not created by this draft — authored on the current working branch; branch creation deferred to the owner)
**Created**: 2026-06-01
**Status**: Draft
**Owner**: Ahmed Shaaban
**Depends on**: [specs/003-catalog-foundation](../003-catalog-foundation/spec.md) (Resolved Catalog View §6.4 + `pos-read-model-direction.md`), [specs/002-pos-operator-identity](../002-pos-operator-identity/spec.md) (device-token principal)
**Consumed by**: POS-Pulse `010-terminal-catalogue-read-sync` (separate repository)
**Constitution version**: 3.0.1 — primary touchpoints §2 (multi-tenant RLS / object safety), §4 (Contract-First POS Integration), §9 (Source-of-Truth Model), §10 (Retail Temporal Semantics), §11 (Idempotency & External IDs), §12 (Authorization & Object Safety), §13 (Audit), §7/§9 (Observability)

**Input**: User description — define the platform-side POS catalogue read-down API (snapshot + delta) that POS terminals consume to maintain an offline-capable local replica of the resolved store catalogue.

---

## Clarifications

### Session 2026-06-01

- Q: Direction relative to existing 005? → A: This is **read-DOWN** (platform → terminal catalogue publication). It is the opposite of 005-pos-catalog-sync-reconciliation, which is capture-UP (POS submits unknown items) + tenant-admin reconciliation. The two MUST NOT be conflated. (Direction locked.)
- Q: Read-model shape? → A: **Snapshot + delta**, specified from v1 — binding per 003 §6.4 and `pos-read-model-direction.md` Q12. Online per-scan lookup is NOT the primary path (003 §4 rejected it); it may be a later online fallback only. (Model locked.)
- Q: How is a POS terminal authenticated and scoped? → A: **Device-principal** authentication (002 terminal device token), NOT the manager Clerk-JWT scheme. Scope derives from the authenticated device's `(tenant_id, store_id)` only. The POS wire term is `branch_id` (uuid) which the platform maps internally to `store_id`, reusing the existing convention in `pos-operators.openapi.yaml` / `pos-audit-events.openapi.yaml`. Body/query-supplied scope is untrusted. (Auth/scoping locked.)
- Q: How is money represented on the wire, and what about products with no price? → A: Price is an **exact-decimal string + ISO-4217 `currency_code`** (no float ever, gate A.6), emitted at the currency's **natural minor precision**. A product that is **NULL-priced, missing currency, or non-representable in the currency minor unit is NOT POS-sellable** and MUST NOT be emitted as an active sellable row. (Money + null-price locked — Decisions #2/#3 below.)
- Q: What happens when a previously sellable product becomes unpriced? → A: **Decision #3** — the delta stream MUST emit a sellable-stream **removal** operation (`retire` / `remove_from_sellable`) so the consumer drops it from its local sellable replica. It must never remain active with a NULL / sentinel / manual price.
- Q: How are omitted unpriced products surfaced? → A: **Decision #2** — BOTH an **observability signal/counter** (unpriced-catalogue issues; reuse/extend 003 §9 `catalog_lookup_failure_rate`, name an unpriced-issue signal) AND an **admin/reconciliation backlog/report** for tenant/admin correction. NEVER surfaced to the cashier; NEVER in the POS sellable stream.
- Q: Delta mechanism — change-log/version column vs derived from `updated_at`/`row_version`? → A: **Deferred to `/speckit-plan` + data-model.** The spec fixes the delta *semantics* (ordered, gap-detectable, idempotent, explicit removal tombstones — FR-020…FR-024) and an **opaque** cursor (FR-011); because the cursor is opaque, the backing mechanism is invisible to the consumer and to acceptance tests. Choosing a change-log/version column (and any gated migration) is a plan-level implementation decision, not a spec clarification — recording one here would contradict §3 Non-Goals ("No DB schema changes").
- Q: Currency multiplicity per `(tenant, store)`? → A: **Single currency per `(tenant, store)` for v1** (e.g. EGP). The per-row payload still carries `currency_code` (so mixed-currency is forward-representable without a contract break), but the v1 sellable rule and the consumer's minor-unit conversion assume one currency per store. Mixed-currency-per-store is out of scope for v1.
- Q: Who owns the unpriced-product reconciliation backlog (Decision #2b)? → A: **This feature owns only the signal/data**, NOT a new admin UI. It emits the unpriced-issue observability signal and the backlog *data*; the admin correction surface is owned by an existing/future reconciliation queue (005/006/007 family), consistent with §3 Non-Goals (no reconciliation surface in this read-only feature). No new admin screen is built here.

### Session 2026-06-03

- Q: (R-1) FR-050 required five payload fields — `name_ar`, `name_en`, `controlled_substance`, `prescription_required`, `unit_pack_label` — that have **no backing column** in the DP2 catalog (`tenant_products` has a single generic `name` and none of the flags; `global_products` / `product_aliases` lack them too). Add columns, or revise the payload down to the real schema? → A: **Revise FR-050 down to the real schema (Option B).** The read-down payload MUST emit **only fields that resolve from existing 003 catalog columns** — keeping 010 read-only and schema-free (§3/§9) and avoiding a Constitution §I violation (the five fields were carried from the legacy/pharmacy model without re-grounding against the DP2 schema). **Removed from the payload:** the `name_ar`/`name_en` split (replaced by the single `name` column), `controlled_substance`, `prescription_required`, `unit_pack_label`. **Retained** (all backed by real columns): `product_id`, `sku` + `aliases[]` (from `product_aliases`), `price { amount, currency_code }`, `tax_category`, the resolved `active` flag, and the per-row `row_cursor`. POS-Pulse 010 loses Arabic-name and pharmacy-flag display in v1; re-adding any of these is a **future spec** that first adds the backing column to the Tenant Catalog (003), not a read-down concern. (Payload locked to the real schema.)

---

## 1. Background & Why

POS terminals must search products and resolve barcodes/SKUs while operating offline (POS keeps selling when the network is down). The authoritative catalogue lives on the platform as the **Resolved Store Catalogue** — `Resolved(store) = Tenant Catalog ⊕ Store Override` (003 §6.4). Today there is **no platform API** by which a terminal can obtain that catalogue: 003 records the *direction* (`pos-read-model-direction.md`: snapshot + delta), but authors no endpoint, no contract, and no route. The existing 005 feature is the **opposite direction** (POS capturing unknown items *up* for reconciliation).

This feature specifies the platform-side **read-down** workflow: how an authenticated POS terminal obtains a snapshot of its store's sellable catalogue and then advances that local state forward via deltas — without ever writing to the authority, without direct database access, and without breaching tenant/store isolation. It is the platform half of the contract that POS-Pulse `010-terminal-catalogue-read-sync` consumes.

The platform **remains the catalogue authority** (§9). This feature is read-only publication of a projection; it does not collapse the source-of-truth layers (Global Index / Tenant Catalog / Store Override / future SaleLine Snapshot remain as defined in 003 §5).

---

## 2. Goals

- Define how the platform publishes the resolved store catalogue to an authenticated POS terminal as a **snapshot** at a server-issued cursor.
- Define how the platform publishes **ordered, idempotent, gap-detectable deltas** after a cursor so a terminal advances its local state without re-downloading the full catalogue.
- Define **device-principal authentication** and `(tenant_id, store_id)` scoping (POS wire term `branch_id`, mapped internally to `store_id`), including non-disclosing cross-scope rejection.
- Define which products are **POS-sellable** and therefore eligible for the sellable stream, and the precise rule that **unpriced / missing-currency / non-representable-price products are excluded** (and how a product *transitioning* into that state is removed via a delta).
- Define the **read-model payload** each catalogue row carries so a POS terminal can search, resolve, display, and resolve-to-cart-line a product (consumed by POS-Pulse 009/010).
- Define **money representation** (exact-decimal string + currency, natural minor precision) and the **lossless conversion guarantee** the consumer relies on.
- Define **integrity, transport, pagination**, and the **failure / non-disclosing error posture**.
- Define **audit and observability** obligations (including the unpriced-product issue surfacing — Decision #2).
- Define the **downstream contract obligations** the eventual gated OpenAPI YAML must satisfy, **without authoring the YAML** in this spec.

---

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, workers, or jobs.
- No `plan.md`, `tasks.md`, `data-model.md`, `research.md`, or contract YAML in this spec PR.
- No DB schema changes, Drizzle schema, or SQL migrations. Catalog tables remain as defined in 003.
- No OpenAPI files, package files, lockfiles, CI changes, generated files, or app source modifications.
- **No catalogue WRITE / mutation surface of any kind.** This is read-only publication.
- **No unknown-item capture-up** (005) and **no tenant-admin reconciliation** (005/006/007) — opposite direction; consumed/referenced, not redefined.
- No inventory (009), sales (008), SaleLine Snapshot, pricing/tax/promotions engines.
- No POS-side replica, fold, normalization, or storage — those are owned by POS-Pulse 010 (separate repo). The platform supplies raw fields; POS computes search folding.
- No **snapshot signing implementation** — signing is named and deferred (003 PQ-6) with a documented upgrade path; v1 relies on TLS + device-auth.
- No **online per-scan lookup** — rejected as the primary path (003 §4); a future online fallback is out of scope here.
- No **manual-price entry, sentinel price, or any handling that keeps an unpriced product sellable** — unpriced products are simply omitted from the sellable stream.
- No **direct SaaS database access** by any POS client (hard constitutional rule, §4; 003 §5.2).

---

## 4. Actors

| Actor | Role in this workflow |
|---|---|
| **POS Device / Terminal** | The read-down consumer. Authenticates with its platform device token (002). Requests a snapshot, then deltas, scoped to its own `(tenant_id, store_id)`. Has NO write access and NO access to authoring/reconciliation surfaces. |
| **Platform (this feature)** | Projects the Resolved Store Catalogue (003 §6.4), filters to the sellable stream, and serves snapshot + delta responses. Remains the authority; never accepts catalogue writes here. |
| **Tenant Admin / Store Manager** | Not a direct actor on the read-down API, but the **recipient** of the unpriced-product reconciliation backlog (Decision #2). Corrects unpriced products in the authoring surfaces (003/005/006/007), which then flow into the sellable stream. |
| **Platform Operator** | Reads aggregate observability signals (unpriced-issue rate, lookup-failure rate, reconciliation-mismatch rate) for operational health only. No tenant-specific catalogue data. |
| **Anonymous / unauthenticated / non-device principal** | No access. A manager Clerk JWT alone (no device principal) is NOT sufficient for this API. |

Cross-tenant and cross-store access is rejected with a non-disclosing response (§2/§12; 003 §5.5) for every actor.

---

## 5. User Scenarios & Testing *(mandatory)*

### User Story 1 — Terminal obtains a fresh sellable catalogue snapshot (Priority: P1)

A newly paired (or re-baselining) POS terminal requests the full resolved sellable catalogue for its store so it can build/rebuild its offline local replica.

**Why this priority**: Without the snapshot there is no replica — the entire POS search/lookup path (POS-Pulse 009) has no data. This is the MVP; everything else is incremental.

**Independent Test**: Authenticate as a device principal for `(tenant T, store S)`, request the snapshot, and verify the response contains exactly the sellable priced products resolved for store S (Tenant Catalog ⊕ Store Override), each with the required payload fields, money as exact-decimal+currency at natural minor precision, and a server-issued cursor. No unpriced product appears.

**Acceptance Scenarios**:

1. **Given** an authenticated device principal for `(T, S)` and store S has N sellable priced products, **When** it requests the snapshot, **Then** the response carries exactly those N products (resolved view), each with the required fields and a server-issued opaque cursor, paginated if large.
2. **Given** store S has a product with a NULL price (or missing currency, or a price not representable in the currency minor unit), **When** the snapshot is requested, **Then** that product is **absent** from the sellable stream and an unpriced-issue observability signal + reconciliation-backlog entry is recorded.
3. **Given** a store override sets a different price/availability than the tenant default, **When** the snapshot is requested, **Then** the resolved row reflects the override (price/availability/tax field-by-field per 003 §5.3), and other stores are unaffected.

### User Story 2 — Terminal advances its replica via deltas (Priority: P2)

A terminal that already holds a snapshot at cursor C requests changes since C, so it advances its local state forward without re-downloading the full catalogue.

**Why this priority**: Keeps terminals current at predictable per-change cost rather than per-scan or per-full-resync cost (003 §4.3). Required by the binding snapshot+delta model, but a terminal can operate on a snapshot alone in the interim.

**Independent Test**: Hold a snapshot at cursor C; mutate the authoritative catalogue (add, change price, retire, make-unpriced); request deltas since C; verify the ordered upsert/retire operations exactly reconcile the local replica to the new resolved state, that re-requesting since C is idempotent, and that an unservable cursor returns `snapshot_required`.

**Acceptance Scenarios**:

1. **Given** a terminal at cursor C and a product was added/changed after C, **When** it requests deltas since C, **Then** it receives ordered `upsert` operations carrying the new resolved rows and an advanced cursor; applying them brings the replica to the current resolved state.
2. **Given** a previously sellable product was retired OR became unpriced/missing-currency/non-representable after C, **When** deltas since C are requested, **Then** a **sellable-stream removal** operation (`retire` / `remove_from_sellable`) is emitted so the consumer drops it (Decision #3). The product never appears as active with a NULL/sentinel/manual price.
3. **Given** a terminal re-requests deltas with the **same** cursor C, **When** the platform serves it, **Then** the result is **idempotent** (same logical set; safe to re-apply).
4. **Given** a cursor C the platform can no longer serve (too old / compacted), **When** deltas since C are requested, **Then** the platform returns a **`snapshot_required`** outcome directing the terminal to re-baseline via a fresh snapshot.

### User Story 3 — Isolation and non-disclosure hold for every request (Priority: P1)

A terminal can only ever obtain its own store's catalogue; cross-tenant/cross-store attempts reveal nothing.

**Why this priority**: A read-down API that leaked another tenant's or store's catalogue would be a critical isolation breach (§2/§12). Isolation is as load-bearing as the data itself.

**Independent Test**: With a device principal scoped to `(T, S)`, attempt to obtain a snapshot/delta for `(T, S')` or `(T', *)` via any body/query parameter; verify a non-disclosing 404-class response that does not reveal whether the other scope exists, and that the authenticated scope is the only one ever served.

**Acceptance Scenarios**:

1. **Given** a device principal scoped to `(T, S)`, **When** it supplies a `branch_id`/scope parameter for a different store/tenant, **Then** the platform serves only `(T, S)` if the parameter matches the token scope, else returns a non-disclosing 404-class outcome (no exists/not-exists disclosure).
2. **Given** a request authenticated only by a manager Clerk JWT (no device principal), **When** it hits the read-down API, **Then** it is rejected — device-principal authentication is required.
3. **Given** an unresolved store context, **When** a request is made, **Then** the platform returns a `store_context_required`-class outcome (reusing the existing POS error code).

### Edge Cases

- **Empty sellable catalogue**: a store with zero sellable priced products returns a valid empty snapshot at a cursor (not an error) — the terminal records "synced, empty," distinct from "never synced."
- **All products unpriced**: the snapshot is empty for the sellable stream; the unpriced-issue signal + reconciliation backlog reflect the count.
- **Currency precision mismatch**: a stored price with more fractional digits than the currency's minor unit can represent is treated as non-representable → excluded from the sellable stream and reported (it is a data error, not a rounding decision).
- **Large catalogue**: snapshot exceeds a single response → cursor-paginated via a continuation token; the cursor for delta purposes is stable across pages.
- **Concurrent mutation during snapshot pagination**: the snapshot reflects a single consistent cursor point; mutations after that cursor are delivered as deltas, never as torn snapshot pages.
- **Clock skew**: freshness/cursor semantics use a server-issued monotonic cursor, not client wall-clock, so terminal clock skew cannot corrupt delta ordering.
- **Cursor from a different store**: a cursor issued for `(T, S)` presented under a different scope is rejected non-disclosingly (cursors are scope-bound).

---

## 6. Requirements *(mandatory)*

### Functional Requirements

**Authentication & scoping**
- **FR-001**: The read-down API MUST authenticate the caller as a **device principal** (002 terminal device token). A manager Clerk JWT without a device principal MUST be rejected.
- **FR-002**: Every snapshot/delta response MUST be scoped to the authenticated device's `(tenant_id, store_id)` ONLY. Body/query-supplied scope MUST NOT be trusted to widen or change scope.
- **FR-003**: The POS-facing wire term for store scope MUST be `branch_id` (uuid), mapped internally to `store_id`, consistent with `pos-operators.openapi.yaml` / `pos-audit-events.openapi.yaml`. A supplied `branch_id` MUST be validated against the token scope; a mismatch returns a non-disclosing rejection.
- **FR-004**: Cross-tenant or cross-store requests MUST return a **non-disclosing 404-class** outcome that does not reveal whether the other scope exists (§2/§12; 003 §5.5).
- **FR-005**: An unresolved store context MUST return a `store_context_required`-class outcome (reusing the existing POS error code).

**Snapshot**
- **FR-010**: The platform MUST provide a **snapshot** operation returning the full **resolved sellable** store catalogue (`Resolved(store) = Tenant Catalog ⊕ Store Override`, 003 §6.4) for the authenticated `(tenant_id, store_id)`.
- **FR-011**: The snapshot MUST carry a **server-issued opaque monotonic cursor** representing the catalogue state point it reflects.
- **FR-012**: The snapshot MUST be **cursor-paginated** for large catalogues via a continuation token, with all pages reflecting the same consistent cursor point.
- **FR-013**: The snapshot MUST include **only POS-sellable, priced** products (see Sellable Stream rules FR-040…FR-044). Unpriced products MUST NOT appear.

**Delta**
- **FR-020**: The platform MUST provide a **delta** operation returning changes after a supplied cursor as **ordered** operations of types `upsert` and **sellable-stream removal** (`retire` / `remove_from_sellable`).
- **FR-021**: Delta responses MUST be **idempotent**: re-requesting the same `since` cursor yields the same logical change set and is safe to re-apply.
- **FR-022**: Delta responses MUST be **gap-detectable** and carry an advanced cursor; a consumer applying deltas in order reaches the current resolved state.
- **FR-023**: When the supplied cursor is **unservable** (too old/compacted), the platform MUST return a **`snapshot_required`** outcome directing the consumer to re-baseline via a fresh snapshot.
- **FR-024**: Cursors MUST be **scope-bound**; a cursor issued for one `(tenant, store)` presented under another scope MUST be rejected non-disclosingly.

**Sellable stream & null-price rule (Decisions #2/#3)**
- **FR-040**: A product is **POS-sellable** for the stream only if it is active (`retired_at IS NULL` AND resolved `is_active`/availability true) AND has a **present price with currency, representable in the currency's minor unit**.
- **FR-041**: A product with **NULL price, missing currency, or a price not losslessly representable** in the currency's minor unit MUST NOT be emitted as an active sellable row (snapshot or delta upsert).
- **FR-042**: When a previously sellable product **becomes** unpriced/missing-currency/non-representable, the delta stream MUST emit a **sellable-stream removal** operation so the consumer removes it. It MUST NOT remain active with a NULL/sentinel/manual price (Decision #3).
- **FR-043**: Omitted unpriced products MUST be surfaced via **(a)** an observability signal/counter (unpriced-catalogue issues) AND **(b)** backlog **data** consumable by an admin/reconciliation surface for tenant/admin correction (Decision #2). This feature owns only the **signal + data**; it MUST NOT build a new admin UI — the correction surface is owned by an existing/future reconciliation queue (005/006/007 family), per §3 Non-Goals.
- **FR-044**: Unpriced products MUST NEVER be surfaced to the cashier and MUST NEVER appear in the POS sellable stream. (`tenant_products.default_price = NULL` "price-on-request / POS manual entry" is explicitly out of the v1 sellable read-down stream.)

**Payload**
- **FR-050**: Each sellable row MUST carry **only fields backed by existing 003 catalog columns** (clarified 2026-06-03, R-1 / Option B): `product_id`, `sku` (the `sku`-type `product_aliases` entry), `name` (the single `tenant_products.name` — NOT NULL; NO `name_ar`/`name_en` split, which has no backing column), `aliases` (list — the non-`sku` `product_aliases` values), `price` as `{ amount, currency_code }`, `tax_category`, a resolved **active** flag, and a per-row `row_cursor`. **Explicitly NOT emitted in v1** (no backing column — would violate §3/§9 read-only + Constitution §I): `controlled_substance`, `prescription_required`, `unit_pack_label`. Re-adding any of these is a future spec that first adds the column to the Tenant Catalog (003).
- **FR-051**: `price.amount` MUST be an **exact-decimal string** (≤4 fractional digits per the existing `DecimalAmount` pattern), paired with an ISO-4217 `currency_code`, **emitted at the currency's natural minor precision** (e.g. EGP ≤2dp). It MUST NEVER be a float. A `(tenant, store)` catalogue is **single-currency for v1** (clarified 2026-06-01); `currency_code` is carried per row for forward-compatibility, not to support mixed currencies within a store in v1.
- **FR-052**: The platform MUST supply **raw** name/alias fields; it MUST NOT compute search folding/normalization (the consumer owns that).
- **FR-053**: The resolved **active** flag MUST reflect `retired_at IS NULL` AND the resolved tenant/store availability.

**Integrity, transport, observability, audit**
- **FR-060**: v1 integrity MUST rely on **TLS + device-auth**; the response MAY carry a content hash/ETag for change detection. Detached snapshot signing is **named and deferred** (003 PQ-6) with a documented upgrade path; it MUST NOT block v1.
- **FR-061**: Responses MUST be JSON with **gzip** content-encoding; the snapshot MUST be inline (not a fetch-by-URL artifact) in v1.
- **FR-070**: The platform MUST emit observability signals: `catalog_lookup_failure_rate`, the snapshot+delta `reconciliation_mismatch_rate` hook (003 §9), and the **unpriced-product issue** signal (Decision #2). No values/names/PII in metric labels.
- **FR-080**: Read-down access events MUST be auditable consistent with §13 (actor = device principal, tenant, store, operation, cursor, outcome, correlation id). Reads do not mutate catalogue state; audit captures access, not catalogue change.
- **FR-090**: The eventual OpenAPI YAML MUST live at `packages/contracts/openapi/catalog/read-down.yaml` (a `[GATED]` surface), authored in a separate gated contract slice — NOT in this spec.

### Key Entities *(include if feature involves data)*

- **Resolved Sellable Catalogue Row**: the projection a POS terminal reads — one per sellable product for the store, derived from `Tenant Catalog ⊕ Store Override` (003 §6.4), filtered by the sellable rule (FR-040). Carries the FR-050 payload (revised 2026-06-03 to fields backed by real 003 columns only). Not a new authoritative table; a read projection.
- **Catalogue Cursor**: a server-issued opaque monotonic token representing a catalogue state point for a `(tenant, store)`. Scope-bound. Drives snapshot↔delta continuity.
- **Sellable-Stream Delta Operation**: an ordered change — `upsert` (row added/changed) or `retire`/`remove_from_sellable` (row left the sellable stream, including via becoming unpriced). Idempotent per cursor.
- **Unpriced-Catalogue Issue**: a derived signal/backlog entry (not a catalogue row) recording that an authoritative product is excluded from the sellable stream because it is unpriced/missing-currency/non-representable. Surfaced to observability + admin reconciliation; never to POS.

---

## 7. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A paired terminal can obtain a complete sellable catalogue snapshot for its store and reconstruct a local replica that returns the correct product for **100%** of a representative barcode/SKU set, with **zero** unpriced products present.
- **SC-002**: After an authoritative catalogue change (add / price-change / retire / become-unpriced), a terminal applying the resulting deltas reaches a replica state that matches the platform's resolved sellable view with **zero** divergence across a representative change set.
- **SC-003**: **100%** of cross-tenant / cross-store read-down attempts return a non-disclosing response that does not reveal whether the other scope exists; **zero** cross-scope catalogue rows are ever served.
- **SC-004**: **Zero** unpriced / missing-currency / non-representable products are ever emitted as active sellable rows, across snapshot and delta, including the transition case (a product becoming unpriced produces a removal delta in **100%** of cases).
- **SC-005**: Re-requesting deltas with the same cursor is idempotent — applying it twice yields the same replica state in **100%** of cases — and an unservable cursor yields a `snapshot_required` re-baseline directive **100%** of the time.
- **SC-006**: **100%** of money amounts are emitted as exact-decimal strings at the currency's natural minor precision with a paired currency code; **zero** floats and **zero** sub-minor-precision amounts reach the consumer.
- **SC-007**: Every excluded unpriced product is reflected in **both** the observability counter and the admin reconciliation backlog; **zero** unpriced products are surfaced to a cashier.

---

## 8. Assumptions

- **POS device-token principal exists and carries `(tenant_id, store_id)`** per 002 (verified: `auth_tokens.store_id` FK → `stores`; `branch_id` is the POS-facing name mapped to `store_id`). This feature consumes that principal; it does not redefine pairing/auth.
- **`branch_id ≡ store_id`** (same UUID value, dual-named by layer). No translation table is required — only the documented naming note. (Verified against `pos-operators.openapi.yaml:36`, `auth_tokens.ts`, `stores.ts`.)
- **The Resolved Catalog View (003 §6.4) is computable server-side** from Tenant Catalog ⊕ Store Override; this feature projects it, it does not author the resolution rules.
- **Every emitted payload field maps to an existing 003 column** (clarified 2026-06-03, R-1 / Option B). Verified against `tenant_products` (`name`, `tax_category`, `default_price`/`default_currency_code`, `is_active`, `retired_at`), `product_aliases` (`identifier_type='sku'` → `sku`; other types → `aliases[]`), and `store_product_overrides` (resolved price/availability/tax). The read **projection** therefore needs **no new catalogue columns** — keeping §3 ("No DB schema changes" for the catalog) and §9 (read-only) intact. (The change-log/cursor mechanism in plan R1 is a *separate* additive `[GATED]` table, not a catalogue-column change.)
- **Single currency per `(tenant, store)` for v1** (e.g. EGP) — clarified 2026-06-01. The payload still carries per-row `currency_code` so mixed-currency is forward-representable without a contract break, but the v1 sellable rule and the consumer's minor-unit conversion assume one currency per store. Mixed-currency-per-store is out of scope for v1.
- **The consumer (POS-Pulse 010) owns** all POS-side replica storage, search folding/normalization, the decimal→minor-units conversion, and the offline behavior. The platform supplies raw fields and the lossless-money guarantee only.
- **Snapshot signing is deferred** (TLS + device-auth for v1) per 003 PQ-6; this is acceptable for the internal/dev rollout.
- **The OpenAPI contract is authored later, in a gated slice** (`packages/contracts/openapi/catalog/read-down.yaml`), exactly as 005 deferred its YAML. This spec authors none.
- **No new catalogue tables/migrations** are required by this read projection; it reads existing 003 catalog tables. *(To be confirmed at `/speckit-plan`: whether the cursor/delta mechanism needs a change-log/version column — see open question.)*

---

## 9. Resolved Clarifications & Plan-Level Deferrals

All clarify-session questions are resolved (see `## Clarifications`):

1. **Currency multiplicity — RESOLVED:** single currency per `(tenant, store)` for v1 (e.g. EGP); `currency_code` carried per row for forward-compatibility (FR-051; §8).
2. **Unpriced backlog ownership — RESOLVED:** this feature owns the signal + backlog **data** only; the admin correction UI is owned by an existing/future reconciliation queue (005/006/007 family). No new admin surface here (FR-043; §3).
3. **Cursor/delta mechanism — DEFERRED to `/speckit-plan` + data-model (by design, not unresolved):** the spec fixes delta *semantics* (ordered, gap-detectable, idempotent, removal tombstones — FR-020…FR-024) and an **opaque** cursor (FR-011). Because the cursor is opaque, the backing mechanism (change-log/version column vs derived from `updated_at`/`row_version`) and any gated migration are a plan-level implementation choice, invisible to the consumer and acceptance tests. Recording a mechanism here would contradict §3 Non-Goals ("No DB schema changes"). **`/speckit-plan` MUST resolve this and decide whether a `[GATED]` migration review is needed.**

---

## 10. Downstream Dependency — POS-Pulse 010

POS-Pulse `010-terminal-catalogue-read-sync` (separate repo) is the **sole consumer** and is **blocked** on this feature until:

1. The gated **OpenAPI contract** `packages/contracts/openapi/catalog/read-down.yaml` is authored + pinned (so POS-Pulse can regenerate its API types).
2. The **snapshot endpoint** (FR-010…FR-013) is implemented and reachable by a device-authenticated terminal.
3. Open Question #2 (currency) is resolved (POS-Pulse's decimal→minor conversion depends on it).

POS-Pulse 010 v1 MAY consume the **snapshot only** (storing the cursor, deferring delta application to a POS-Pulse v2 slice) — the platform contract still specifies both snapshot + delta (binding model); the consumer's v1 cut does not narrow the platform contract.
