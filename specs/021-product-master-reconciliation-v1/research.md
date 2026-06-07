# Phase 0 Research — 021 Product-Master Reconciliation v1

Each unknown is resolved with a decision + rationale + the alternative rejected.
021 deliberately follows the **017 reconciliation precedent** (run → report →
repair) applied to **013's product mapping** rather than 014/009's stock.

---

## R1 — What is the MVP, and is it connector-dependent?

**Decision:** The MVP (US1) is a **pure DP2-side read-projection** of active
`tenant_products` (003) lacking a confirmed-and-active `erpnext_item_map` (013)
row, classified `unmapped_dp2_product` / `suggestion_unconfirmed`. It needs **zero
outbound/connector dependency**.

**Rationale:** Mirrors 017's US1 (a live read over already-shipped 015 rows). The
gap "which products cannot post" is fully derivable from 013 + 003 on the DP2
side, so it is independently shippable today. Putting any ERPNext-item-view leg in
the MVP would repeat the 017-VERIFY honesty error (a connector-gated/external leg
masquerading as buildable-now).

**Alternatives rejected:**
- *Two-sided compare as the MVP* — rejected: it depends on the connector's
  ERPNext-item fetch, which is external/gated; it cannot ship standalone.
- *No MVP without the connector* — rejected: the unmapped-DP2-product backlog is
  the highest-value, lowest-coupling slice and stands alone.

---

## R2 — Read-projection vs persisted run (the 017 schema discriminator)

**Decision:** The US1 backlog is a **live read-projection (no persisted run/result
rows)**. Only the US3 two-sided external compare is a **persisted run** (a
point-in-time snapshot against an outside view). 021 therefore owns a small table
family used **only** by US3 + US2's repair trail.

**Rationale:** 017's hard-won lesson — it refused to model a run `kind` that yields
no result rows, because that would imply a mirror of the read side. The US1
backlog is recomputable live from 013/003; persisting it would be an unwanted
mirror (READ-NOT-MIRROR-013) and a §IX-blurring duplicate of the 013 authority.

**Alternatives rejected:**
- *Persist a "posting/unmapped run" snapshot for US1* — rejected: no result rows
  beyond what the live join already gives; pure mirror.
- *One mega-run covering both US1 and US3* — rejected: conflates the connector-free
  MVP with the connector-gated compare and breaks independent shippability.

---

## R3 — How does 021 read the ERPNext item side (the connector boundary)?

**Decision:** Through a **connector seam** behind the fixed 012 boundary —
**stub-tolerant** in v1. The DP2-side run/report/repair ship and are testable with
a recorded/stub ERPNext-item view; the **live** read activates when the connector
ships a future `[GATED]` connector→DP2 item-view contract (`021-ITEM-VIEW-CONTRACT`).
An absent/partial view is **reported** (DP2-side classes only + ERPNext side
marked unavailable), never a run failure (FR-007).

**Rationale:** Identical to 017's R3 / `017-STOCK-VIEW-CONTRACT` posture. DP2 makes
no outbound ERPNext HTTP (011/013/ADR-0008); the connector is the only ERPNext
caller. Stub-tolerance lets 021 ship and be fully tested before the connector's
item view exists.

**Alternatives rejected:**
- *DP2 calls ERPNext directly* — rejected: violates the connector-only boundary
  (ADR 0008, 013 §6).
- *Block US3 entirely until the connector ships* — rejected: 017 proved the
  DP2-side run + persisted report + repair workflow are buildable + testable now
  against a stub; only the live leg is external.

---

## R4 — The mismatch-class vocabulary: borrow or derive?

**Decision:** **Derive** a 021 product-master vocabulary from 013's mapping
concepts: `match`, `unmapped_dp2_product`, `suggestion_unconfirmed`,
`unmapped_erpnext_item`, `attribute_drift`, `sellable_state_divergence`. 021 owns
this vocabulary (no predecessor owns a product-mapping vocabulary), but MUST NOT
invent a *competing* classification where 013 already named the case (FR-006).

**Rationale:** 017 borrowed 014's stock vocabulary because **014 owned it**. For
product mapping, no predecessor owns a vocabulary — 013 named the *cases* (§7.5
sellable-state divergence "a reconciliation case, not a silent override"; §7.7 the
unmapped-item case; OQ-5; OQ-6) but never enumerated a reconciliation enum. So 021
derives one directly from those concepts. `sellable_state_divergence` is the literal
operationalization of 013 OQ-5; `suggestion_unconfirmed` reflects 013's
confirmed-only resolution invariant; `unmapped_dp2_product` is 013 §7.7.

**Alternatives rejected:**
- *Reuse 014's stock vocabulary* — rejected: stock classes
  (`quantity_divergence`, `negative_balance_flagged`) don't describe item-identity
  mapping; semantic mismatch.
- *No `attribute_drift` (only mapped/unmapped)* — rejected: a confirmed mapping
  whose ERPNext-side attributes drifted is a real, actionable reconciliation case
  the two-sided run uniquely detects.

---

## R5 — How does repair work: a new primitive or reuse 013?

**Decision:** **Reuse 013's existing lifecycle** — confirm a suggestion, or
suggest-then-confirm, or re-point — driving the shipped `erpnext_item_map` flow,
honoring 013's **optimistic-concurrency `version` guard** and **1:1 active
partial-unique**. 021 owns no new mapping table or write primitive.

**Rationale:** The 017 REPAIR-REUSES-015-O3 discipline applied to 013. A repair is
just the operator acting on the 013 mapping from the reconciliation surface; reusing
013 guarantees exactly-one active confirmed mapping per `(tenant, product)` and a
non-destructive no-op on an already-confirmed mapping. A stale-version confirm is
013's `409`, recorded as a repair attempt — never a silent overwrite.

**Alternatives rejected:**
- *A 021-owned mapping table* — rejected: duplicates 013, risks two competing
  authorities for the mapping link, violates §IX/§III discipline.
- *Last-write-wins on confirm* — rejected: 013 already chose optimistic concurrency
  (a confirm is a trust action); LWW would silently clobber a concurrent re-point.

---

## R6 — Audit-of-record: async `@Auditable` or in-transaction?

**Decision:** A **direct in-transaction `INSERT INTO audit_events`** on the same tx
client as the state write (run/repair), atomic with 021's own operational
`run`/`result_state`/`repair_attempt` rows. NOT the async `@Auditable` interceptor,
NOT `insertAuditEvent`.

**Rationale:** The 017 FR-014 correction. 013/014/015 use `@Auditable` (a
post-response BullMQ enqueue) and the synchronous `insertAuditEvent` helper
*forbids* in-transaction use — neither can guarantee "a repair that cannot also
audit rolls back." 021's repair/run advance state and audit atomically, so it
needs the in-transaction path 017 established.

**Alternatives rejected:**
- *Async `@Auditable` (the 013 default)* — rejected: post-response enqueue is not
  atomic with the state write; a crash between them loses the audit.
- *`insertAuditEvent` inside the tx* — rejected: the helper explicitly forbids
  in-transaction use.

---

## R7 — On-demand vs scheduled runs

**Decision:** **On-demand in v1.** The `trigger` column reserves `'scheduled'`;
scheduled cadence is wired later over the **same** run processor (a future
`021-SCHEDULED-RUNS`, mirroring `017-SCHEDULED-RUNS`).

**Rationale:** On-demand delivers the operator value immediately and is fully
testable; scheduling is additive wiring over the identical processor, so deferring
it costs nothing and avoids guessing a cadence prematurely.

**Alternatives rejected:**
- *Ship scheduled runs in v1* — rejected: adds a cron/wiring surface with no extra
  user value before the live connector read even exists.

---

## R8 — Auth scheme for the operator surface

**Decision:** **`cookieAuth` / `DashboardAuthGuard`, human-operator-only (Tenant
Admin).** NOT the machine `connectorBearer`, NOT a POS device scheme.

**Rationale:** The 007/013/014/017 precedent — every operator reconciliation/mapping
surface is the dashboard human session. The connector never calls 021 (a repair
just advances a 013 mapping; the connector's only ERPNext interaction stays behind
the 012 boundary). FR-019.

**Alternatives rejected:**
- *Connector bearer on a 021 surface* — rejected: 021 has no machine-facing
  contract; the connector does not participate.

---

## R9 — Signal placement + cardinality

**Decision:** Register the unmapped-product-backlog-depth / reconciliation-outcome
signal in the **shared `apps/api/src/observability/api.metrics.ts`** (the 010
`catalog_unpriced_issue_rate` precedent), as the §VII "reconciliation mismatch
rate" family, with **no PII/money/raw-payload labels** (counts + mismatch_class
only). Append the metric name to the cardinality/signal-name drift lists in
lockstep.

**Rationale:** 010/017 established that per-feature metric files fragment the
catalogue; the shared file is the single registration point. §VII names
"reconciliation mismatch rate" explicitly.

**Alternatives rejected:**
- *A per-feature metrics file* — rejected: the 010 correction.
- *Label by product/tenant name* — rejected: PII/cardinality risk (§VII/§XIV).

---

## R10 — Drift-test allowlists (the #447/#487-class CI break)

**Decision:** Any future `0022` migration + schema module MUST be appended, in
lockstep, to: `packages/db/__tests__/cli/migrate.spec.ts` `EXPECTED_MIGRATIONS`;
`packages/db/__tests__/schema/catalog/barrel.spec.ts` `EXPECTED_CATALOG_MODULES`;
the metric-name drift list (R9); and any new migration spec MUST re-call
`ensureAppRole` AFTER the migration (grants only cover tables-at-grant-time).

**Rationale:** The documented migration-test gotcha (the #447/#487 hard CI break).
Recorded here so the future `[GATED]` SCHEMA slice does not re-trip it.

**Alternatives rejected:** none — this is a known-good checklist.
