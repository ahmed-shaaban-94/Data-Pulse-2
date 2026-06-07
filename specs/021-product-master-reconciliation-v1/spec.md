# Feature Specification: Product-Master Reconciliation v1

**Feature Branch**: `021-product-master-reconciliation-v1`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Product-master reconciliation v1"

> **Arc context (not a clarification — grounding).** 021 is to **013**
> (product-master-from-erpnext, CLOSED — the `erpnext_item_map` identity table +
> the cookieAuth suggest/confirm/list + retire/re-point surface) what **017**
> (reconciliation & repair, CLOSED) is to **014/009** (stock). 013 established the
> **mapping**; 021 is the **reconciliation over that mapping**, in 017's proven
> **run → report → repair** shape, but the subject is **product/item-mapping
> divergence**, not stock and not posting.
>
> 021 does **not** re-spec 013's mapping table, nor 017's stock/posting
> reconciliation. It reads (never mirrors) the `erpnext_item_map` rows 013 ships,
> classifies divergence between the DP2 product master and ERPNext items, persists
> the externally-coupled comparison as a report, and exposes an **idempotent
> repair** that drives 013's **existing** suggest/confirm flow — never a new
> mapping primitive. Two 013 open questions are exactly what 021 answers in
> operational form: **OQ-5** (sellable-state divergence is "a reconciliation case,
> not a silent override") and **OQ-6** (the relationship between an unmapped
> product and the 003 unknown-items queue).
>
> **Boundary inherited from 011/013/017 (non-negotiable):** DP2 makes **no
> outbound ERPNext HTTP**. Any live ERPNext-item view is the connector's machinery
> (separate repo, ADR 0008) behind the fixed 012 contract; 021 consumes that seam
> and is **stub-tolerant** in v1 (the DP2-side run/report/repair ship and are
> testable against a recorded/stub ERPNext-item view; the live read activates when
> the connector ships a future `[GATED]` connector→DP2 item-view contract).
> Reconciliation is **never authority handover** (011-DR-STOCK-IMPACT / 013 §5):
> the §IX Tenant Catalog stays authoritative for the retail product; ERPNext owns
> accounting Item identity; a divergence is surfaced, never silently overwritten.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator reviews DP2 products that are not mapped to an ERPNext item (Priority: P1) 🎯 MVP

A **Tenant Admin / catalog operator** opens the product-master reconciliation
surface and sees, per tenant, the list of **active DP2 tenant products that lack
a current, confirmed ERPNext Item mapping** — each carrying the product
reference, why it is unmapped (`unmapped_dp2_product` — no mapping row at all, or
`suggestion_unconfirmed` — only a `suggested`/unconfirmed 013 row exists), the
provenance of any suggestion, and when the gap was observed. The list is
paginated, sortable, and groupable by mismatch class so the operator can triage
the products that **cannot yet post** (a sale line for an unmapped product
fails-to-DLQ per the posting decision §5) and act on them.

**Why this priority**: This is the MVP and the reason 021 exists as a standalone
deliverable. It is a **pure DP2-side read-projection** — `tenant_products` (003)
left-joined to `erpnext_item_map` (013), filtered by 013's confirmed-only
resolution invariant — and requires **zero connector / outbound ERPNext
dependency**. It makes the "which products are unpostable" gap **visible and
triageable** the same way 017's US1 made the posting dead-letter backlog visible,
and is independently shippable on top of the already-merged 013 data.

**Independent Test**: Seed a tenant with a mix of products — some with a
`confirmed` `erpnext_item_map` row, some with only a `suggested` row, some with no
mapping row at all, plus a retired mapping — call the review/list surface as the
tenant admin; confirm only that tenant's unmapped/unconfirmed products appear
(confirmed-and-active products are absent), correctly classified, with provenance,
paginated/sortable/groupable, and that a cross-tenant product is non-disclosing.

**Acceptance Scenarios**:

1. **Given** a tenant with one product carrying a `confirmed` active mapping, one
   product whose only mapping row is `suggested`, and one product with no mapping
   row, **When** the operator lists the reconciliation backlog, **Then** exactly
   the two unmapped/unconfirmed products are returned — the `suggested`-only one
   classified `suggestion_unconfirmed` and the no-row one classified
   `unmapped_dp2_product`; the confirmed product is absent.
2. **Given** a product whose only active mapping is `confirmed` but was later
   **retired** (013 re-point/retire), **When** the operator lists the backlog,
   **Then** the product reappears as `unmapped_dp2_product` (a retired mapping is
   not a current mapping — the 013 confirmed-only-and-active invariant).
3. **Given** unmapped products across two tenants, **When** operator A lists the
   backlog, **Then** only tenant A's products are visible (tenant isolation;
   a cross-tenant reference is non-disclosing — §II/§XII).
4. **Given** a backlog larger than one page, **When** the operator pages and
   sorts/groups by class, **Then** results are stable, complete, and
   gap-detectable across pages (the 007/010/017 list conventions).

---

### User Story 2 - Operator repairs an unmapped product by driving the 013 suggest/confirm flow (Priority: P2)

From a surfaced unmapped/unconfirmed product, the operator triggers a **repair**
that re-makes the product **resolvable**: for a `suggestion_unconfirmed` product
the repair **confirms** the existing 013 suggestion (the operator acting on the
013 confirm action); for an `unmapped_dp2_product` the repair routes the operator
into the existing 013 **suggest-then-confirm** path (record a suggestion → confirm
it). The repair **owns no new mapping primitive** — it drives 013's already-shipped
`erpnext_item_map` lifecycle and honors 013's optimistic-concurrency `version`
guard. The repair is **idempotent**: confirming an already-`confirmed`-and-active
mapping is a non-destructive no-op that echoes the existing mapping; the same
`(tenant, product)` resolves to **at most one** active confirmed mapping (013's
OQ-2 1:1 partial-unique), never two.

**Why this priority**: Visibility (US1) lets operators *see* the unpostable
products; repair lets them *clear* the gap inside the system, closing the loop
without manual DB surgery — exactly 017's US1→US2 progression. It is P2 because
US1 already delivers triage value, and repair builds directly on the surfaced
backlog plus 013's already-proven confirm idempotency + `version` guard. Like
017's repair, **021 invents no new write path**: the repair re-uses 013.

**Independent Test**: Take a `suggestion_unconfirmed` product, trigger a repair to
confirm it; confirm the 013 row transitions `suggested → confirmed` (with
`confirmed_by`/`confirmed_at` provenance), the product leaves the US1 backlog, a
repair attempt is recorded, and a second repair of the now-confirmed product is a
no-op echo (no second mapping row, no `version` clobber). Take an
`unmapped_dp2_product`, repair via suggest→confirm; confirm one active confirmed
mapping results and the product leaves the backlog.

**Acceptance Scenarios**:

1. **Given** a `suggestion_unconfirmed` product, **When** the operator triggers a
   confirm repair with the expected `version`, **Then** the 013 mapping
   transitions to `confirmed` (with recorded confirm provenance), the product
   leaves the US1 backlog, and the repair attempt is recorded with outcome
   `mapped`.
2. **Given** a product whose mapping is already `confirmed`-and-active, **When** a
   repair is triggered for it, **Then** the repair is a non-destructive no-op that
   echoes the existing mapping — never a second active mapping row (013 OQ-2 1:1),
   never a `version` clobber.
3. **Given** a confirm repair issued with a **stale `version`** (a concurrent
   re-point happened), **When** it is applied, **Then** it is rejected as a
   conflict (013's optimistic-concurrency guard, `409`) and the repair attempt is
   recorded with outcome `conflict`/`still_unmapped` — never a silent overwrite of
   the concurrent change.
4. **Given** any repair, **When** it is recorded, **Then** the §IX Tenant Catalog
   (`tenant_products`) is **never** mutated and ERPNext authority is never taken
   over — only the 013 mapping state advances.

---

### User Story 3 - Operator runs a product-master reconciliation against the ERPNext item view (Priority: P3)

The operator triggers (on demand) a **product-master reconciliation run** for a
tenant: the system compares the DP2 mapping set (`erpnext_item_map` confirmed/active
rows) against the **connector's ERPNext item view**, and produces a persisted
**mismatch report** classifying each line — e.g. `match` (a confirmed mapping
points at an ERPNext item that exists and agrees), `unmapped_dp2_product` (a DP2
product with no resolvable ERPNext item), `unmapped_erpnext_item` (an ERPNext item
no DP2 product maps to), `attribute_drift` (a confirmed mapping whose ERPNext-side
attributes — e.g. item code/barcode/UOM/sellable-state — have drifted from the
mapped reference), and `sellable_state_divergence` (DP2 sellable vs ERPNext Item
disabled, or vice versa — the operationalization of 013 **OQ-5**). The operator
reviews the report, filters by class, and can trigger a repair (re-confirm /
re-point via 013) for actionable classes. **DP2 stays authoritative for the retail
product**; a divergence is a reconciliation case to surface, never a silent
overwrite of either side.

> **v1 ERPNext-read scope (stub-tolerant, mirrors 017 US3/R3):** the run reads the
> ERPNext side through a **connector seam** (the connector owns the actual ERPNext
> item fetch behind the fixed 012 boundary — DP2 makes no outbound ERPNext HTTP).
> In v1 the seam is **stub-tolerant**: 021's DP2-side run, persisted report, and
> repair workflow ship and are testable with a recorded/stub ERPNext-item view; the
> **live** ERPNext read activates when the connector ships a future `[GATED]`
> connector→DP2 item-view contract (named here `021-ITEM-VIEW-CONTRACT`). An absent
> connector view is **reported** (the run reports only what the DP2-side projection
> can determine, e.g. `unmapped_dp2_product`/`suggestion_unconfirmed`, and records
> the ERPNext side as unavailable), **never a run failure**.

**Why this priority**: The full two-sided run completes the surface (it can also
detect `unmapped_erpnext_item` and `attribute_drift`, which US1's DP2-only
projection cannot), but it depends on the connector's ERPNext-item fetch
machinery, which is external/gated. It is therefore the largest and most
externally-coupled story, so it is P3 — exactly the 017 US3 honesty split. US1+US2
deliver standalone, connector-free value without it.

**Independent Test**: With a confirmed mapping set and a stub/recorded ERPNext-item
view, trigger a reconciliation run; confirm a persisted mismatch report is produced
with the correct 021 classes, scoped to the tenant, that an absent view still
completes the run (DP2-side classes only, ERPNext side marked unavailable), and
that a repair on an actionable class is recorded idempotently without mutating the
013 mapping or 003 catalog.

**Acceptance Scenarios**:

1. **Given** a tenant with a confirmed mapping set and a stub/recorded ERPNext-item
   view containing one extra item and one drifted item, **When** a reconciliation
   run executes, **Then** a persisted report is produced classifying each line
   (`match` / `unmapped_erpnext_item` / `attribute_drift` / etc.), scoped to the
   tenant, with the 013 mapping unchanged by the run.
2. **Given** a `sellable_state_divergence` result (DP2 sellable, ERPNext Item
   disabled), **When** the operator reviews it, **Then** the report names the
   divergence and offers a repair path, and the run **does not** silently flip
   either side's sellability (013 OQ-5: a reconciliation case, never a silent
   override).
3. **Given** the connector ERPNext-item view is **unavailable** (connector not yet
   shipped / stub empty), **When** a run executes, **Then** the run **completes**
   reporting the DP2-side-determinable classes and marks the ERPNext side
   unavailable — it does **not** fail and does **not** invent `unmapped_erpnext_item`
   from an absent view.
4. **Given** a reconciliation run, **When** it reads the DP2 mapping set and the
   ERPNext view, **Then** the 013 `erpnext_item_map`, the 003 `tenant_products`,
   and the 008 sale facts are **never** mutated by the run — reconciliation is
   read + report + (idempotent) repair only.

---

### Edge Cases

- **Repair of a product whose mapping was concurrently re-pointed** → the stale
  `version` confirm is a `409` conflict (013's guard); the repair attempt is
  recorded with outcome `conflict`, the product stays in the backlog, never a
  silent overwrite.
- **Repair of an already-confirmed-and-active product** (a stale backlog view) →
  non-destructive no-op echoing the existing mapping; never a second active
  mapping row (013 OQ-2 1:1).
- **A product that is both an unknown-item (003/006/007 inbound queue) and an
  unmapped-DP2-product (021 outbound)** → 021 surfaces it only in the
  product-master reconciliation backlog and **does not** reuse or overload the
  003 unknown-items queue (013 §8 / OQ-6); the two mechanisms stay distinct,
  though resolving an unknown item may *later* require a 021/013 mapping before
  that product can post.
- **A reconciliation run while a 013 suggestion is mid-confirm** → the run reports
  the in-flight state (still `suggestion_unconfirmed`), does not double-classify,
  and does not race the confirm.
- **Cross-tenant / out-of-scope reference** on any list/repair/run call →
  non-disclosing not-found (§II/§XII); no existence leak.
- **The connector ERPNext-item view returns a partial / stale page** → the run
  reports what it received and marks completeness; it never overwrites a DP2
  mapping from an incomplete external view.
- **Backlog growth / alerting** → the persisted backlog depth + the reconciliation
  outcome signal feed an operator alert when the unmapped-product depth crosses a
  threshold; the alert carries no PII / money / raw payloads (§VII/§XIV).

## Clarifications

### Session 2026-06-07

These points were latent ambiguities in "Product-master reconciliation v1." Each
was auto-resolved using best-judgment defaults grounded in the 013/017 precedent
and the constitution, and the resolution is already encoded in the requirements
above. No `[NEEDS CLARIFICATION]` markers remain.

- **Q: Is the MVP (US1) connector-dependent, or pure DP2-side?**
  **A: Pure DP2-side read-projection (no connector).** The unmapped-product
  backlog is `tenant_products` ⟕ `erpnext_item_map` under 013's confirmed-only
  invariant. *Rationale:* mirrors 017's US1 (live read over already-shipped data);
  putting a connector-gated leg in the MVP would repeat the 017-VERIFY honesty
  error. The ERPNext-item-view-dependent detection (`unmapped_erpnext_item`,
  `attribute_drift`) is deliberately deferred to P3.

- **Q: Does 021 model a persisted "run" for the US1 backlog, or a live
  projection?**
  **A: Live read-projection for US1 (no run rows); persisted run only for the US3
  external compare.** *Rationale:* the 017 read-projection-vs-run discriminator —
  017 refused to model a run `kind` that yields no result rows. The US1 backlog is
  derivable live from 013/003, so persisting it would be an unwanted mirror.

- **Q: What mismatch-class vocabulary, and who owns it?**
  **A: A 021 product-master vocabulary derived from 013's mapping concepts**
  (`match` / `unmapped_dp2_product` / `suggestion_unconfirmed` /
  `unmapped_erpnext_item` / `attribute_drift` / `sellable_state_divergence`).
  *Rationale:* 017 borrowed 014's stock vocabulary because 014 owned it; for
  product mapping no predecessor owns a vocabulary, so 021 derives one from 013's
  §7 concepts and 013 OQ-5/OQ-6 — and MUST NOT invent a *competing* classification
  where 013 already named the case (FR-006).

- **Q: How does repair work — a new mapping primitive, or reuse 013?**
  **A: Reuse 013's existing suggest/confirm/re-point lifecycle + its `version`
  optimistic-concurrency guard + its 1:1 active partial-unique.** *Rationale:* the
  017 REPAIR-REUSES-existing-state discipline; 021 owns no new mapping table or
  write primitive — exactly one active confirmed mapping per `(tenant, product)`.

- **Q: Which auth scheme guards the 021 operator surface?**
  **A: `cookieAuth` / `DashboardAuthGuard`, human-operator-only (Tenant Admin).**
  *Rationale:* settled by 007/013/014/017 precedent; NOT the machine connector
  bearer and NOT a POS device scheme. The connector never calls 021.

- **Q: How is the audit-of-record written for a run/repair?**
  **A: A direct in-transaction `INSERT INTO audit_events` on the same tx client**
  as the state write (atomic). *Rationale:* the 017 FR-014 correction — 013/014/015's
  async `@Auditable` (post-response BullMQ) and `insertAuditEvent` (forbidden
  in-tx) cannot satisfy the atomicity requirement, so 021 reuses 017's new
  in-transaction path, not 013's async one.

## Requirements *(mandatory)*

### Functional Requirements

#### Reconciliation reporting (run → report)

- **FR-001**: System MUST surface, per tenant, the backlog of **active DP2 tenant
  products that lack a current confirmed-and-active ERPNext Item mapping** — each
  carrying the product reference, the mismatch class (`unmapped_dp2_product` |
  `suggestion_unconfirmed`), the provenance of any existing suggestion
  (`suggestion_source`, `suggested_by`/`suggested_at` from 013), and an observed-at
  timestamp.
- **FR-002**: The backlog (US1) MUST be a **live read-projection** over
  `tenant_products` (003) ⟕ `erpnext_item_map` (013) applying 013's confirmed-only
  resolution invariant (`state='confirmed' AND retired_at IS NULL` = mapped) — it
  MUST NOT mirror or copy the 013 rows into a 021-owned table (READ-NOT-MIRROR-013,
  the 017 US1 discriminator).
- **FR-003**: The backlog list MUST be paginated, sortable, groupable by mismatch
  class, and gap-detectable across pages (consistent with the 007/010/017 list
  conventions).
- **FR-004**: System MUST scope every reconciliation read to the caller's tenant;
  a cross-tenant or out-of-scope reference MUST be non-disclosing (§II/§XII).
- **FR-005**: System MUST be able to execute a **product-master reconciliation
  run** (on demand) for a tenant that compares the DP2 confirmed mapping set against
  the connector's ERPNext-item view (012 seam) and persist the result as a
  **mismatch report**.
- **FR-006**: A mismatch report MUST classify each result using the **product-master
  reconciliation vocabulary derived from 013's mapping concepts** — `match`,
  `unmapped_dp2_product`, `suggestion_unconfirmed`, `unmapped_erpnext_item`,
  `attribute_drift`, `sellable_state_divergence` — and MUST NOT invent a competing
  classification where 013 already named the case (the 017 FR-005 discipline; 013
  §7.5 sellable-state and §7.7 unmapped item).
- **FR-007**: A reconciliation run MUST treat an **absent or partial connector
  ERPNext-item view** as a reported condition (DP2-side classes only + ERPNext side
  marked unavailable/incomplete), never a run failure, and MUST NOT synthesize
  `unmapped_erpnext_item` from an empty/absent view (the 017 FR stub-tolerance).
- **FR-008**: System MUST persist reconciliation runs + their report results for
  later review + audit; a run/report is retained (not deleted) for the
  operability/audit horizon (§XIV — retention is a state, not a row removal).
- **FR-009**: System MUST emit/track the unmapped-product backlog depth + the
  reconciliation outcome signal (the §VII "reconciliation mismatch rate" family),
  so operators can alert on a growing unmapped backlog; signals MUST carry no PII /
  money / raw payloads.

#### Repair (the repair action)

- **FR-010**: System MUST expose a **repair** action for an actionable
  unmapped/divergent product that **drives 013's existing `erpnext_item_map`
  lifecycle** — confirm an existing suggestion (`suggestion_unconfirmed` →
  confirmed), or suggest-then-confirm a mapping (`unmapped_dp2_product`), or
  re-point/re-confirm a drifted mapping (`attribute_drift` /
  `sellable_state_divergence`). 021 MUST NOT introduce a new mapping primitive or a
  second mapping table.
- **FR-011**: A repair MUST be **idempotent** and preserve 013's invariants: a
  confirm repair of an already-`confirmed`-and-active mapping is a non-destructive
  no-op echoing the existing mapping; the same `(tenant, product)` resolves to **at
  most one** active confirmed mapping (013 OQ-2 1:1 partial-unique) — never two.
- **FR-012**: A repair MUST honor 013's **optimistic-concurrency `version` guard**:
  a confirm issued with a stale `version` MUST be rejected as a conflict (`409`),
  the repair attempt recorded, and the product left in the backlog — never a silent
  overwrite of a concurrent re-point (this is the 013-OCC reuse, not a new
  mechanism).
- **FR-013**: A repair whose target product is **still unresolved** after the
  attempt (e.g. confirm conflict, or a suggestion the operator declined) MUST leave
  the product in the backlog with its class intact (no silent success), and MUST
  record the repair attempt — never an infinite silent retry.
- **FR-014**: A repair MUST NEVER mutate the §IX Tenant Catalog (`tenant_products`,
  003) or the 008 sale facts — only the 013 mapping state advances. ERPNext
  authority is never taken over (011-DR-STOCK-IMPACT / 013 §5).
- **FR-015**: System MUST record a platform **`audit_events`** entry for every
  reconciliation run and every repair action (actor, tenant, target product
  reference, repair kind, outcome), with no raw payloads/PII. The audit write MUST
  be **atomic with the state write** — a repair/run that cannot also audit rolls
  back. **Implementation note (the 017 FR-014 correction):** 013/014/015 use the
  async `@Auditable` interceptor (post-response BullMQ enqueue) and the synchronous
  `insertAuditEvent` helper **forbids** in-transaction use — neither satisfies this
  atomicity requirement. 021 MUST use a **direct `INSERT INTO audit_events` on the
  same transaction client** as the state write (the new in-transaction audit path
  017 established), alongside 021's own operational `repair_attempt` / `run` rows —
  all written atomically, never one without the other.

#### Boundary & authority

- **FR-016**: DP2 MUST make **no outbound ERPNext HTTP call**; any ERPNext-side read
  (the ERPNext-item view) is the connector's machinery behind the fixed 012
  contract (ADR 0008). 021 consumes the connector boundary; it does not
  re-implement it, and is stub-tolerant until the connector ships the item-view
  contract.
- **FR-017**: 021 MUST NOT change ERPNext authority: mapping/reconciliation is never
  authority handover (013 §5 / 011-DR-STOCK-IMPACT). The §IX Tenant Catalog stays
  authoritative for the retail product; ERPNext owns accounting Item identity only.
  A divergence is surfaced, never silently overwritten.
- **FR-018**: 021 MUST consume the fixed 012 boundary and any future
  `021-ITEM-VIEW-CONTRACT` as a contract-first surface (§IV); any DP2 operator
  surface 021 adds ships as a `[GATED]` OpenAPI contract first.
- **FR-019**: 021 is **exclusively a human operator surface** (Tenant Admin) in
  v1 — every 021 surface (list backlog, run reconciliation, trigger repair) MUST
  authenticate as the **dashboard human session scheme** (`cookieAuth` /
  `DashboardAuthGuard`), consistent with 007/013/014/017, NOT the machine connector
  bearer and NOT a POS device scheme. The connector never calls 021.
- **FR-020**: 021 MUST keep the **outbound product-master reconciliation** distinct
  from the **inbound 003/006/007 unknown-items queue** (013 §8 / OQ-6): it MUST NOT
  reuse or overload the unknown-items queue for the unmapped-mapping case, nor
  invent a parallel "unresolved" mechanism that silently collides with it.

### Key Entities *(include if feature involves data)*

- **Unmapped-Product Backlog Item (US1 — read-projection, NOT owned/persisted by
  021)**: A derived view row, per active `tenant_products` (003) row that lacks a
  `confirmed`-and-active `erpnext_item_map` (013) row — carrying the product
  reference, the class (`unmapped_dp2_product` | `suggestion_unconfirmed`), the
  suggestion provenance, and an observed-at timestamp. Computed live from 013/003;
  **not** a 021-owned table (READ-NOT-MIRROR-013).
- **Reconciliation Run**: One execution of a product-master reconciliation for a
  tenant (the US3 two-sided compare against the connector item view). Attributes:
  scope (tenant), trigger (on_demand; scheduled reserved), started/finished
  timestamps, summary counts by mismatch class (no PII/money — counts only), actor
  (the operator), correlation id, ERPNext-side availability flag. Append-only;
  never rewritten. (Owned by 021; `[GATED]`.)
- **Reconciliation Result / Mismatch Report Line**: One classified line of a run —
  per originating reference (DP2 product ref and/or ERPNext item ref), the 021
  mismatch class, operator-facing detail values (allowed on the row, never in
  metric labels), provenance, and 021's own workflow state (`open` | `repaired` |
  `accepted`). Retained for audit. (Owned by 021; `[GATED]`.)
- **Repair Attempt**: A record of an operator-triggered repair — target product
  reference, repair kind (`confirm` | `suggest_confirm` | `re_point`), actor,
  timestamp, outcome (`mapped` | `still_unmapped` | `no_op_echo` | `conflict`), and
  the resolved mapping reference when it succeeds. Append-only; the audit trail of
  the repair workflow. (Owned by 021; `[GATED]`.)
- **ERPNext Item Mapping (consumed, owned by 013)**: The `erpnext_item_map` rows
  021 reads for the backlog and transitions via repair through 013's **existing**
  suggest/confirm/re-point flow. 021 does **not** own this table; the 013 lifecycle
  + `version` guard + 1:1 partial-unique stay authoritative.
- **Tenant Product (consumed, owned by 003)**: The `tenant_products` rows the
  backlog projects over; 021 reads them and NEVER mutates them (§IX).
- **Connector ERPNext-Item View (consumed via the 012 seam)**: The ERPNext-side
  item list 021 compares against in a run; fetched only by the connector (no
  outbound DP2 HTTP); stub-tolerant in v1.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can see the complete backlog of their tenant's active
  products that cannot post (no confirmed ERPNext mapping) in a single review
  surface — 100% of unmapped/unconfirmed active products are surfaced, 0%
  cross-tenant leakage, with no connector dependency for US1.
- **SC-002**: An operator can make an unmapped/unconfirmed product resolvable by
  triggering one repair (driving the 013 confirm / suggest-confirm flow), with no
  manual database access required, and the product then leaves the backlog.
- **SC-003**: A product that is repaired and confirmed results in **exactly one**
  active confirmed mapping — 0 duplicate active mappings and 0 silent overwrites of
  a concurrent re-point across any number of repeated repair attempts (013 OQ-2 1:1
  + `version` guard hold 100%).
- **SC-004**: A reconciliation run for a tenant produces a persisted, reviewable
  mismatch report classified entirely in 021's product-master vocabulary, with the
  013 mapping, 003 catalog, and 008 sale facts unchanged by the run (verified
  before/after).
- **SC-005**: A reconciliation run executes and **completes** when the connector
  ERPNext-item view is unavailable — reporting only DP2-side-determinable classes
  and marking the ERPNext side unavailable — 0 run failures attributable to the
  absent connector and 0 fabricated `unmapped_erpnext_item` rows.
- **SC-006**: A repair of a still-unresolved product returns it to the backlog
  without loss and records the attempt — 0 silent successes and 0 unbounded retry
  loops.
- **SC-007**: Operators are alerted when the unmapped-product backlog depth crosses
  a configurable threshold, with no PII / money / raw payloads in the alert.

## Assumptions

- **013 is shipped** (`erpnext_item_map` identity table — `state`
  suggested/confirmed, `erpnext_item_ref`, `retired_at`, the 1:1 active partial-
  unique, the `version` optimistic-concurrency token, and the cookieAuth
  suggest/confirm/list + retire/re-point surface). 021 reads that mapping and
  drives that lifecycle; it does not re-implement mapping. (Verified: 013 CLOSED on
  `main`, PRs #487 + #489.)
- **003 is shipped** (`tenant_products` Tenant Catalog) — the backlog projects over
  it; 021 never mutates it (§IX).
- **The connector** (separate repo, ADR 0008) is the only ERPNext-calling component
  and owns any ERPNext-item fetch; 021 consumes the 012 contract boundary and makes
  no outbound ERPNext HTTP. The live ERPNext-item read is **gated** behind a future
  `021-ITEM-VIEW-CONTRACT`; 021 v1 is stub-tolerant. (Mirrors 017's `017-STOCK-VIEW-CONTRACT`
  deferral.)
- **The operator surface is the dashboard human session** (`cookieAuth` /
  `DashboardAuthGuard`, Tenant Admin), consistent with 007/013/014/017.
  **Decided:** 021 is human-operator-only in v1; the connector never calls 021.
- **Repair re-uses 013's primitives** (suggest/confirm/re-point lifecycle, the
  `version` guard, the 1:1 partial-unique) rather than inventing a new one — the
  017 REPAIR-REUSES-existing-state discipline applied to 013.
- **No new ERPNext authority** is introduced; reconciliation never overwrites
  either side silently (013 §5 / 011-DR-STOCK-IMPACT, SIGNED).
- **The audit-of-record write is a NEW in-transaction `INSERT INTO audit_events`**
  (the 017 correction), NOT the 013/014/015 async `@Auditable` path and NOT
  `insertAuditEvent` (forbidden in-tx).
- **Scheduling** for product-master reconciliation runs is **on-demand in v1**;
  scheduled cadence is reserved (a `trigger` value), to be wired later over the same
  processor (mirrors 017's `017-SCHEDULED-RUNS` deferral) — a planning detail, not a
  scope clarification.
- **Persistence/retention** of runs + reports follows the 001 long-horizon audit
  posture (retained, not deleted — §XIV).
- **Mobile / non-dashboard surfaces are out of scope** for v1.

## Dependencies

- **013-product-master-from-erpnext** (CLOSED) — owns the `erpnext_item_map`
  mapping + lifecycle 021 reads and repairs; 013 OQ-5 (sellable-state divergence)
  and OQ-6 (unknown-items relationship) are operationalized here.
- **003-catalog-foundation** (CLOSED) — owns `tenant_products`, the backlog's
  read-projection parent.
- **012-erpnext-connector-contracts** (SHIPPED) — the fixed connector boundary;
  the future ERPNext-item view (`021-ITEM-VIEW-CONTRACT`) is its own `[GATED]`
  contract slice.
- **017-erpnext-reconciliation-and-repair** (CLOSED) — the run→report→repair shape,
  the read-projection-vs-run discriminator, the in-transaction audit correction, and
  the stub-tolerant connector-read posture 021 mirrors (for product-mapping rather
  than stock).
- **011-DR-STOCK-IMPACT / 011-DR-POSTING** (SIGNED) — the authority + failure-posture
  decisions 021 must not contradict.
- **008-sales-transaction-capture** (CLOSED) — the sale facts 021's runs/repairs
  must never mutate (§IX).
