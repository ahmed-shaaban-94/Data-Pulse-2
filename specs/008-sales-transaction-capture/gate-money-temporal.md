# 008 Decision Gate — Transaction Money + Temporal Semantics + Provenance Hash

**Feature**: 008-sales-transaction-capture
**Status**: OPEN — MUST be resolved before `/speckit-plan` (and therefore before any implementation slice)
**Owner decision required**: yes — every item below is an owner decision; this document frames trade-offs and does **not** pick.
**Why this gate exists**: 008 is the first feature to model a sale. The Constitution (v3.0.1) explicitly defers a set of money/temporal/provenance/lifecycle parameters as **Follow-up TODOs** in its Sync Impact Report and as live clauses in §III (Money, Tax, Rounding), §X (Retail Temporal Semantics), §IX/§XIII (Provenance), the Per-Tenant Resource Isolation section, and §XIV (PII & Data Lifecycle). The Constitution *fixes the obligations*; it leaves *these parameters* for "the entity's spec" / "the pricing spec" / "before any sale or catalog-pricing slice ships." This gate resolves the ones this feature exercises: §A transaction money (TODO #1), §B per-entity timestamps (TODO #2), §C payload hash (TODO #3), §D.2 per-tenant quota (TODO #6), and §D.3 sale-fact classification + retention (TODO #7). (TODO #4, audit-storage growth, is deferred per its own "once retention pressure surfaces" clause.) This is that decision point.

> **Already pinned — NOT open.** Catalog/store/price-history money is already fixed at `numeric(19,4)` + `char(3)` ISO-4217 currency with paired-currency CHECK constraints (003: `tenant_products`, `store_product_overrides`, `price_history`, `global_products`). 008 consumes that as-is. **Only TRANSACTION-level money is open below.**

The 008 spec's requirements hold **regardless** of how these are decided — money is exact-decimal + currency-bearing (FR-005), the temporal field *set* is fixed (FR-020), a payload hash is retained (FR-040). This gate decides the open *parameters*, not whether the obligations apply.

---

## A. Transaction Money

The Constitution (§III, Money-Tax-Rounding) fixes: floats forbidden; exact-decimal `numeric(p,s)`; explicit ISO-4217 currency on every monetary field; POS totals preserved as received; "the exact money library / representation MUST be chosen and recorded before any sale or catalog-pricing slice ships"; "rounding rules (per-line vs invoice-level, banker's vs half-up) are documented per tenant or per integration; defaults are decided in the pricing spec, not improvised in code."

### A.1 — Decimal precision & scale for transaction money

**Decision**: What `numeric(p,s)` precision/scale do transaction monetary fields (line price, line amount, sale total, tax amounts, refund amounts) use?

**Trade-off**:
- **Match catalog `numeric(19,4)`** — consistency with 003; one mental model; 4 decimal places handles sub-unit pricing (e.g., fuel, weighed goods). But sale *totals* aggregate many lines; confirm 19 integer+fraction digits is ample headroom for the largest plausible invoice in the largest plausible currency.
- **A different scale for totals vs lines** — e.g., lines at scale 4 (unit pricing precision) but totals at scale 2 (presentation/settlement). More faithful to how POS reports, but introduces a precision boundary where rounding happens (couples to A.3).

*No pick. Owner decides whether transaction money mirrors catalog `(19,4)` or diverges, and why.*

### A.2 — Line-tax representation

**Decision**: How is tax represented on a `sale_line` — a single per-line tax amount, a per-line tax-rate + computed amount, or a structured multi-tax breakdown (multiple tax components per line, e.g., GST+PST, federal+state)?

**Trade-off**:
- **Single per-line tax amount (snapshot only)** — simplest; faithful to "preserve what the POS charged"; the SaaS stores the number, does not recompute. But cannot answer "how much of this was tax type X" without the breakdown.
- **Rate + amount** — enables recomputation/audit, but invites the SaaS to *recompute* tax, which risks rewriting POS-charged values (forbidden by §III) unless strictly advisory.
- **Structured multi-tax breakdown** — needed for multi-tax jurisdictions; richest; most schema surface; only worth it if the target markets need it.

*No pick. Owner decides the tax representation; note this couples to A.3 (where rounding lands) and to OQ-2 (multi-tax = tender/payments territory).*

### A.3 — Rounding granularity: per-line vs invoice-level

**Decision**: Is monetary rounding applied **per line** (round each line, then sum) or at the **invoice level** (sum exact, round once)? These produce different totals on the same basket.

**Trade-off**:
- **Per-line rounding** — matches many POS receipts (each line shows a rounded amount); the SaaS sum-of-rounded-lines matches the displayed lines, but may differ from a single invoice-level round.
- **Invoice-level rounding** — single rounding point; cleaner aggregate; may disagree with the rounded line amounts the POS displayed.
- **Critical interaction with §III**: whichever the *POS* used is what was charged — 008 **preserves** the POS total verbatim (FR-030). This decision governs how the SaaS computes *its own* comparison total for the **advisory mismatch flag** (FR-031). Choosing a rounding rule that disagrees with the POS's rule will generate spurious mismatch flags. The owner should pick the rule that matches the dominant POS integration's behavior, or make the comparison tolerance-aware.

*No pick. Owner decides per-line vs invoice-level for the SaaS comparison total, ideally aligned to the POS rule to avoid false mismatch flags.*

### A.4 — Rounding mode: banker's (round-half-even) vs half-up

**Decision**: When rounding is applied (per A.3), which mode — banker's rounding (round-half-to-even) or arithmetic half-up?

**Trade-off**:
- **Half-up** — what most cashiers/humans expect; matches many retail POS systems.
- **Banker's (half-even)** — reduces cumulative bias across many roundings; common in financial/accounting contexts.
- Again, this matters mainly for the SaaS *comparison* total feeding the mismatch flag (the POS total is preserved regardless). Mismatched modes between SaaS and POS produce false-positive mismatch flags.

*No pick. Owner decides the mode, ideally matching the POS integration.*

### A.5 — Tender / change / multi-tax modeling (also OQ-2)

**Decision**: Does 008 persist **tender lines** (cash/card/voucher splits), **change given**, and the **multi-tax breakdown** at all — or defer them to a dedicated payments feature?

**Trade-off**:
- **Defer (recommended posture to consider)** — payments today exist only as a contract stub (`packages/contracts/openapi/pos-payments/vouchers.yaml`); tender / `PaymentAttempt` modeling is documented as POS-Pulse-side, not a backend table. Any backend tender persistence is **payment-class data under §XIV** (classification, redaction, retention obligations). Deferring keeps 008 focused on the sale fact and avoids pulling payment-class PII into the first sale slice.
- **Include now** — a complete invoice arguably needs tender to reconcile "total = sum of tenders − change"; but this widens scope into §XIV payment classification and a payments contract that does not yet exist on the backend.

*No pick. Owner decides include-vs-defer; if include, the §XIV payment-class posture must be specified in the same breath.*

### A.6 — Money library / representation (Constitution Follow-up TODO #1)

**Decision**: The concrete in-application money representation the Constitution demands be "chosen and recorded before any sale or catalog-pricing slice ships" — e.g., a decimal/big-decimal library, a `{ amount: string|bigint, currency: string }` value object, or DB-`numeric` round-tripped as a validated string. (Floats are forbidden regardless.)

**Trade-off**:
- **String-backed value object round-tripped to `numeric`** — no float ever appears; portable; explicit; more boilerplate at the boundary.
- **A big-decimal library** — ergonomic arithmetic (needed if the SaaS computes the comparison total, A.3/A.4); adds a dependency (`package.json` is a `[GATED]` path — needs approval); choice of library matters for rounding-mode support.
- This is the one item that may require a `[GATED]` dependency add; flag it so the approval rides with the decision.

*No pick. Owner records the representation + library (and approves any dependency add).*

---

## B. Per-Entity Timestamp Catalog — Required vs Optional (also OQ-3)

The 008 spec (FR-020) fixes the temporal **field set** and each field's meaning per §X. This gate fixes **which are required (NOT NULL) vs optional (nullable)** on each entity. Storage is UTC `TIMESTAMPTZ` regardless (FR-021); security clocks are the server clock regardless (FR-022).

For each entity, decide the required/optional status of each applicable timestamp:

| Timestamp | `sales` | `sale_lines` | void event | refund event | Framing |
|---|---|---|---|---|---|
| `occurredAt` | ? | inherit parent? | ? | ? | The business-event time. Likely required on `sales`; lines may inherit the parent rather than carry their own. |
| `receivedAt` | ? | — | ? | ? | Server-stamped at receipt. Strong candidate for required (server-owned, always known). |
| `processedAt` | ? | — | ? | ? | Set after (possibly off-request) processing. Naturally **optional/nullable** until processing completes (couples to the §V worker seam). |
| `businessDate` | ? | inherit? | ? | ? | Derived from store timezone. Required-on-`sales` is the likely answer; lines inherit. |
| `sourceClockAt` | ? | — | ? | ? | POS-reported clock; preserved, never a security clock. Optional if the POS may omit it. |
| `voidedAt` | — | — | required | — | The void's own terminal timestamp — required on the void record. |
| `refundedAt` | — | — | — | required | The refund's own terminal timestamp — required on the refund record. |

**Trade-off framing (not a pick)**:
- **More required (NOT NULL)** — stronger invariants, easier querying, but rejects events that legitimately lack a field (e.g., a POS that never reports `sourceClockAt`), which risks violating §X "delayed/partial events MUST NOT be rejected."
- **More optional** — tolerant of partial POS payloads (offline-first reality), but weaker invariants and more null-handling downstream.
- `processedAt` is almost certainly nullable-until-processed (it would otherwise force synchronous processing, against §V).

*No pick. Owner fills the table — required vs optional per cell — consistent with §X's tolerance for delayed/partial events.*

---

## C. Payload-Hash Algorithm for Provenance (also OQ-4)

The 008 spec (FR-040) fixes that a **payload hash** is retained per ingested event so the SaaS record is reconcilable to the original payload (§IX/§XIII). This gate fixes **the algorithm and canonicalization**. (The Constitution Follow-up TODO #3 literally asks: "Decide payload-hash algorithm for POS provenance (sha256 of canonical JSON?).")

**Decisions**:
1. **Hash algorithm** — e.g., SHA-256 (the Constitution's own speculation) vs SHA-512 vs BLAKE3. Trade-off: SHA-256 is the conventional, widely-supported default; alternatives offer speed/length differences rarely material for provenance.
2. **Canonicalization** — *what bytes are hashed.* Trade-off:
   - **Raw received bytes** — trivially reproducible from the stored raw payload; but byte-fragile (whitespace/key-order differences across re-deliveries hash differently, undermining dedup-by-hash).
   - **Canonical JSON (e.g., JCS / sorted-keys)** — stable across cosmetic re-serialization, so the *same logical payload* hashes identically; requires a pinned canonicalization spec so the backend and any verifier agree.
3. **Scope of the hash** — the full payload vs the dedup-relevant subset. (Note: dedup itself is `sourceSystem + externalId` per FR-041; the hash is for *provenance/reconciliation* and MAY also back the idempotency-token body-fingerprint per 005's mismatch detection.)

*No pick. Owner records algorithm + canonicalization + scope.*

---

## D. Confirmations (low-risk, but owner should ratify)

- **D.1 — Concurrency posture (OQ-5)**: Confirm 008's posture — a captured sale is an **immutable fact**; concurrency = **idempotent dedup on `sourceSystem + externalId`** (not LWW, not an optimistic `version` column); corrections are append-only void/refund terminal events. §III requires LWW/posture to be *justified when chosen*; the spec justifies "no version column on an append-only fact." Owner ratifies.
- **D.2 — Per-tenant bulk-sync bound (OQ-6)**: Confirm initial defaults for the bulk offline-recovery sync bound (batch-size ceiling, per-tenant ingestion rate / fair-sharing) layered on the inherited 001/004 platform posture. Values are initial defaults; the *posture's existence* is mandatory (Per-Tenant Resource Isolation; 008 FR-080).
- **D.3 — Sale-fact data classification + retention (Constitution Follow-up TODO #7; spec SI-012)**: 008 introduces the first persisted sale-fact entities, so §XIV's "each class MUST have a documented retention window" and first-class right-to-erasure obligations attach here. **Decision**: confirm the sale fact's data class (default posture: **business-class** — catalog references + quantities + POS-reported totals, no customer identity) and record its **retention window** (default: inherit the 001 long-horizon insert-only audit-retention precedent for an immutable fact) and a **right-to-erasure note** (audit-immutable; tombstone PII fields if any customer reference is ever admitted). This is a confirmation, not an open design problem — but it MUST be recorded, because the spec's §13 row XIV PASS is explicitly scoped to "pending D.3." *No silent pick beyond the stated default; owner ratifies or overrides the class + window.* (Note: this is distinct from §XIV's broader platform-wide classification taxonomy, which TODO #7 also covers and which a future platform feature owns — D.3 fixes only the sale-fact entities 008 creates.)

---

## Resolution checklist (gate is CLOSED when all are recorded)

- [ ] **A.1** transaction-money precision/scale
- [ ] **A.2** line-tax representation
- [ ] **A.3** per-line vs invoice-level rounding (for the SaaS comparison total)
- [ ] **A.4** rounding mode (banker's vs half-up)
- [ ] **A.5** tender/change/multi-tax — include or defer (with §XIV posture if include)
- [ ] **A.6** money library/representation (+ any `[GATED]` dependency approval)
- [ ] **B** per-entity timestamp required/optional table filled
- [ ] **C** payload-hash algorithm + canonicalization + scope
- [ ] **D.1** concurrency posture ratified
- [ ] **D.2** per-tenant bulk-sync bound defaults set
- [ ] **D.3** sale-fact data class + retention window + erasure note recorded

Once recorded here (and reflected back into the 008 spec's Clarifications + the resolved OQ list), `/speckit-plan` may proceed.