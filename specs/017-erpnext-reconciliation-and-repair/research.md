# Phase 0 Research — 017 ERPNext Reconciliation & Repair

All Technical-Context unknowns are resolved below. Each is grounded in a shipped
predecessor (008/009/014/015) or a SIGNED decision (011-DR-*), so no external
research agents were needed.

---

## R1 — Posting repair mechanism: re-use the 015 state machine, do NOT re-model

**Decision**: A posting repair is a **state transition on the existing 015
`erpnext_posting_status` row**, not a new entity. The repair flips a
`permanently_rejected` row back to `pending` and **re-heads its `sequence`**
(`SET sequence = DEFAULT`) so the connector re-offers it on the next pull — the
exact mechanism US2-ACK already ships for `failed_transient` re-offer.

**Rationale**: The 015 O-3 idempotency invariant (exactly one ERPNext document
per originating row, keyed on `(tenant_id, source_ref_id)`) already holds across
re-offer + ack. Re-using it means a repaired posting that succeeds resolves to
the same `document_ref`, and a repair of an already-`posted` row is the
already-proven no-op echo — **for free**, with no second idempotency primitive
(Constitution §III, FR-010/012). Repair is bounded by the same
`POSTING_RETRY_BUDGET` (FR-019).

**Alternatives considered**: (a) a new "repair posting" table that re-drives the
connector — rejected: duplicates the 015 state machine and risks a second
document. (b) DP2 directly re-posting to ERPNext — rejected: DP2 makes no
outbound ERPNext HTTP (FR-015); the connector is the only ERPNext-calling
component.

**Implication**: 017's posting-repair code path is small — it writes a repair
attempt (append-only audit) + transitions the 015 row. It MUST re-evaluate
015-RESOLVE eligibility at repair time (so a still-unmapped row returns to the
backlog with its class intact, FR-011) rather than blindly flipping to `pending`.

---

## R2 — Reconciliation state: ONE new `[GATED]` table, three logical record kinds

**Decision**: One new `packages/db` table family for 017's own state —
`erpnext_reconciliation` carrying **runs**, **results**, and **repair attempts**.
Start with a single table holding reconciliation **runs** + a child **results**
table, and an append-only **repair-attempt** record. (Final shape — one table
with a discriminator vs. two/three tables — is a data-model.md decision; the
migration is `[GATED]` regardless.) The 015 dead-letters are **read, never
copied** — 017 projects over `erpnext_posting_status`, it does not mirror it.

**Rationale**: 017 needs its own durable state for *runs* and *mismatch reports*
(015 has no run/report concept) and for the *repair audit trail*. But the
posting backlog itself already lives in 015 — re-modeling it would create a
derived projection that can drift (the 010 RESTRICT-vs-CASCADE lesson: a derived
mirror is a liability). So: own the run/report/repair records; read the
dead-letters.

**Alternatives considered**: derive-on-read everything (no new table) — rejected:
a reconciliation *run* and a persisted *mismatch report* are first-class durable
facts an operator returns to; they cannot be derived. Mirror the 015
dead-letters into a 017 table — rejected (drift + the derived-projection trap).

---

## R3 — Stock reconciliation ERPNext-Bin read: a connector seam, v1 stub-tolerant

**Decision**: The stock-reconciliation run compares DP2 on-hand (009 compute-on-
read) against an **ERPNext valuation view supplied by the connector behind the
fixed 012 boundary**. DP2 makes no outbound ERPNext HTTP (FR-015). For v1, the
ERPNext-side read is modeled as a **seam** the run consumes; the connector repo
(separate, ADR 0008) owns the actual ERPNext-Bin fetch. The run is **tolerant of
an absent connector view** (reports `erpnext_only`/unavailable rather than
failing the whole run), so 017's DP2-side run + report + the *posting* repair loop
ship and are testable without a live connector.

**Rationale**: The 014 §8 carve assigns the *run* to 017 but the ERPNext-Bin
fetch is "017's machinery … behind the connector boundary" — and the connector
that performs it is a separate repo not yet built. Decoupling (the 009 backfill
precedent: read CAPTURED rows, never subscribe to a live producer) lets 017's
DP2-side surface land now; the connector-fed half activates when the connector
ships, behind the same contract.

**Alternatives considered**: block 017 stock reconciliation on the connector repo
— rejected: US1/US2 (posting) deliver standalone value and US3's DP2 side is
independently testable with a recorded/stub ERPNext view. Any new connector→DP2
contract for the ERPNext view is its own `[GATED]` 012-style slice, out of 017
v1 (matches FR-018: 017 adds no machine contract in v1).

---

## R4 — Mismatch vocabulary: consume 014's, do NOT define a competing one

**Decision**: 017 classifies stock results with **014's** mismatch vocabulary
(`match | quantity_divergence | unmapped_store | unmapped_item | dp2_only |
erpnext_only | negative_balance_flagged`, exact-match, neg-balance-first) and
posting dead-letters with **015's** rejection categories (`unmapped_item |
unmapped_store | unmapped_account | validation | closed_period |
retry_budget_exhausted`). 017 owns no classification of its own.

**Rationale**: 014 §8 explicitly assigns the *definition* of mismatch classes to
014 ("017 needs a stable vocabulary to report/repair against"). Inventing a third
vocabulary would fork the contract (Constitution §IV terminology drift).

**Alternatives considered**: a 017 unified super-vocabulary — rejected (drift;
014 is the owner). 017 MAY add a thin *result-state* enum (`open | repaired |
accepted`) that is orthogonal to the mismatch class — that is 017's own (it is
about the operator workflow, not what the mismatch *is*).

---

## R5 — Scheduling cadence: on-demand v1; scheduled is opt-in, deferred config

**Decision**: v1 ships **on-demand** reconciliation runs (operator triggers a run
for a tenant/store). A **scheduled** cadence (e.g. nightly per tenant) is a thin
later addition (a BullMQ repeatable job enqueuing the same run processor) and is
**not** a v1 blocker — the run processor is identical whether triggered on-demand
or scheduled, so scheduling is a wiring concern, not a design one.

**Rationale**: On-demand is the minimum operable surface and is fully testable;
the scheduled trigger reuses the same idempotent processor (§V). Avoids baking a
cadence policy into v1 before operators have used the on-demand path.

**Alternatives considered**: schedule-first — rejected: more infra (cron/
repeatable-job wiring, per-tenant cadence config) for no extra correctness; the
operator on-demand trigger is the higher-value, lower-risk MVP.

---

## R6 — Auth surface: human Tenant Admin only (FR-018, decided)

**Decision**: Every 017 surface authenticates as the **dashboard human session**
(`cookieAuth` / DashboardAuthGuard), mirroring 007/013/014. No machine
connectorBearer path, no POS device scheme. The connector never calls 017.

**Rationale**: FR-018, decided 2026-06-06. Posting repair re-makes a 015
work-item eligible and the connector re-posts via the **existing** 012 feed/ack
it already polls — so 017 needs no new machine-facing contract or auth path.

**Alternatives considered**: hybrid human+connector — rejected for v1 (a new
`[GATED]` contract + second auth path for no v1 need).

---

## R7 — Observability: extend the shared posting-recon family, no per-feature file

**Decision**: Reconciliation/repair signals extend the **shared**
`erpnext_posting_reconciliation_total` family 015-POLISH already registered in
`api.metrics.ts` + `worker.metrics.ts`. 017 adds (at most) a run-outcome counter
+ a repair-outcome counter in the **same shared files** (NOT a per-feature
metrics file — the 010 `catalog_unpriced_issue_rate` precedent), unlabeled (no
tenant/store/sale/category — those live on the row + audit).

**Rationale**: Constitution §VII + the 015-POLISH precedent (the stop condition
explicitly forbids a per-feature metrics file). DLQ depth + queue lag + failed-job
rate are already covered generically by the shipped `outbox_*{event_type}` +
`queue_*{queue}` signals.

**Alternatives considered**: a per-feature `reconciliation.metrics.ts` — rejected
(violates the shared-file rule + the cardinality drift contract).

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| How does repair avoid a 2nd ERPNext document? | R1 — re-use 015 O-3 state machine (re-head to pending); never re-model |
| New table or derive-on-read? | R2 — one new `[GATED]` table for runs/results/repair-attempts; READ the 015 dead-letters |
| How does the stock run read ERPNext? | R3 — connector seam behind 012; v1 stub-tolerant, DP2-side ships independently |
| Whose mismatch vocabulary? | R4 — 014's (stock) + 015's (posting); 017 adds only an orthogonal result-state enum |
| On-demand or scheduled? | R5 — on-demand v1; scheduled is later wiring over the same processor |
| Auth surface? | R6 — human Tenant Admin only (cookieAuth); no machine path |
| Signals? | R7 — extend the shared `erpnext_posting_reconciliation_total` family; no per-feature file |
