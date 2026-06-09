# Feature Specification: Returns / Reversal Contract (Arc A S2)

**Feature Branch**: `feat/026-returns-reversal-contract`

**Created**: 2026-06-09

**Status**: DETERMINATION — OPEN (G2 evidence collection; NOT a build slice)

**Input**: Frame the DP2 returns surface as a **G2-verified contract**: an OPEN
determination of whether the *existing* forward-feed reversal surface SUFFICES for
returns, or must be EXTENDED — driven by two concrete questions the CHECKPOINT-2
both-sides review must resolve. Author the determination + Spec-Kit companions.
**Do NOT author any OpenAPI YAML, service code, or migration.**

---

## 0. What this spec IS and IS NOT (read first)

This is a **determination spec**, in the same posture as 023 (a parked
contract-determination, not an implementation slice). It exists to:

- **Frame** the returns/reversal surface as a contract question, not to build it.
- **Collect the G2 evidence** the owner needs at CHECKPOINT-2 to either (a) declare
  the existing forward-feed reversal surface SUFFICIENT for returns, or (b) approve a
  later, separately-gated slice that EXTENDS it.
- **Surface — with traced, cited code-fact evidence — one cross-system anchor
  mismatch (Question A) that, on current merged code, prevents returns from working
  end-to-end.**

This spec **MUST NOT**:

- Author or edit any OpenAPI YAML (`posting-feed.yaml`, `sales.yaml`) — SC-06.
  Recommendations may *describe* a change; authoring it is a later gated slice.
- Author or edit any application/service code (`sales.service.ts`, consumers,
  projections) — SC-11.
- Author any migration, package/lock, or CI file.
- Mark **G2 satisfied**. G2 is the owner's both-sides sign-off at CHECKPOINT-2
  (SC-09). This spec collects the evidence; it does **not** certify it.

### 0.1 End-to-end reversal is NOT proven (carry this honestly)

Both halves of the reversal path are *merged in code*, but the **end-to-end reversal
path is NOT proven**. There are **two independent reasons**, which must not be merged:

1. **Bench-unverified apply leg (S1).** The Connector's reversal-apply primitive
   (`feat/006-reversal-apply`, merged PR #27 @ `bc768ad`) was merged
   **BENCH-UNVERIFIED** — it has never run against a real Frappe bench. Its concrete
   `IdempotencyStore` (Frappe-DocType-backed) is a deferred `[GATED]` T020 adapter,
   flagged ⏳ BENCH-VALIDATION in the Connector itself.
2. **Wire-anchor mismatch (Question A).** Independent of bench: on current merged
   code, the idempotency anchor DP2 puts on the wire for a reversal collides with the
   original sale's anchor (see §3). This is a **code-logic** finding — it would hold
   even on a fully-validated bench.

> "015 US3-REVERSAL MERGED" + "S1 merged" does **NOT** read as "returns work
> end-to-end." It reads as "both halves exist in code; the seam between them is
> unverified, and one traced finding suggests the seam is currently broken."

---

## 1. Background — what already exists (verified read-only 2026-06-09)

The returns/reversal surface is **already modelled** as a forward-feed annotation on
the shipped 012 posting-feed contract. Build on this; do **not** redesign it.

| Asset | Where | What it gives |
|---|---|---|
| Reversal work-item kind | `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` v1.1.0-draft, `PostingWorkItem.kind` enum `[sale_post, reversal]` (~L335) | A reversal is a forward feed item: a NEW reversing document (credit note / return invoice), never an edit of the original (§5.4 of 015). |
| `reversalOf` + `ReversalRef` | posting-feed.yaml (~L367, ~L384–401): `{sourceSystem, externalId, reversalKind:[void,refund]}` | Carries the ORIGINAL sale's provenance so the connector locates the document to reverse (O-4). |
| Pull + ack ops | posting-feed.yaml `connectorPullPostings` (GET ~L107) + `connectorAckOutcome` (POST ~L149) | The transport already carries reversals; no new operation is needed for the happy path. |
| Wire idempotency anchor | posting-feed.yaml O-3: `sourceSystem + externalId` (~L345) | The documented wire dedup key. **This is the crux of Question A.** |
| Connector reversal-apply primitive | `Retail-Tower-ERP-Next-Connector` @ `bc768ad`, `connector/posting/reversal_builder.py`, `idempotency.py`, `contracts.py` | S1: builds a reversing doc, keys it on the wire anchor. Bench-unverified. |
| DP2 emit half (015 US3-REVERSAL) | `apps/api/src/catalog/sales/sales.service.ts` `recordVoid` (~L416) / `recordRefund` (~L527) | Writes `sale_voids`/`sale_refunds`; emits `erpnext.posting.requested` `kind=reversal`. MERGED (#504). |

**What does NOT exist** (searched, zero matches): a **dedicated returns contract**;
**remaining-returnable-quantity tracking** in DP2 (any endpoint or state). These are
the candidate-new surfaces Question B weighs.

---

## 2. The determination — SUFFICES vs EXTEND (OPEN)

> **This determination is OPEN. The recommendation below is a recommendation FOR
> CHECKPOINT-2, not a fact and not a decision.** Two questions (§3, §4) must be
> resolved by the both-sides review before G2 can close.

**Recommended determination (for owner ratification, NOT asserted as done):**

The existing **forward-feed reversal surface MOSTLY SUFFICES** for returns at the
contract *shape* level — the reversing-document primitive exists (S1), the
`reversal` work-item + `reversalOf` provenance exist, and a wire idempotency anchor is
documented. A *new* dedicated returns contract is likely **not** warranted.

**BUT** two things gate that conclusion:

- **Question A (cardinality-anchor correspondence)** is a **MUST-VERIFY that current
  evidence indicates is a real cross-system defect** — the anchors on the two sides of
  the wire do **not** correspond (§3). Until resolved, returns do **not** work
  end-to-end, regardless of bench. This is the **#1** open question and the **#1**
  precondition for G2.
- **Question B (remaining-returnable-quantity)** is a **candidate NEW surface** — a
  likely-real but *downstream* gap (§4). Recommended disposition in §4. **This spec
  does NOT author the endpoint or a migration.**

**Dependency between the two:** A is the more fundamental blocker. Partial returns (B)
produce N reversals that — on current code — all share the original sale's wire anchor,
so **B is moot until A is resolved**: there is no point adding remaining-qty state to
distinguish N partial returns when the wire cannot distinguish them in the first place.

---

## 3. QUESTION A — cardinality-anchor correspondence (MUST-VERIFY; current evidence: anchors do NOT correspond)

### 3.1 The question
S1's Connector builder writes the **reversal work-item's OWN top-level `external_id`**
into `rt_external_id` (the F-002 rule — the reversing doc's unique-provenance slot on
the ERPNext side). DP2 keys its O-3 reversal uniqueness on **`source_ref_id`** (the
void/refund row's own id — the "REVERSAL-CARDINALITY fix"). These are **different
anchors on the two sides of the same wire.** Do they correspond? I.e., does DP2's
per-reversal `source_ref_id` become the `externalId` the connector receives on the
work-item, such that S1's `rt_external_id = work_item.external_id` lands on the right
per-reversal slot?

### 3.2 The trace (traced end-to-end across BOTH repos — cited code-fact)

**DP2 side — the per-reversal anchor exists locally but is NOT propagated to the wire:**

1. `recordVoid`/`recordRefund` (`sales.service.ts` ~L416/527) insert the terminal row
   with its OWN provenance (`body.sourceSystem`/`body.externalId` into
   `sale_voids`/`sale_refunds`), then **emit** `erpnext.posting.requested` with payload
   `{ sale_id, store_id, kind:"reversal", source_ref_id: row.id }`. The emit carries
   **only `source_ref_id`** (the terminal row's id) — it does **NOT** carry the
   terminal row's own `source_system`/`external_id`.
2. `PostingRequestedConsumer.handle` (`apps/worker/src/erpnext-posting/posting-requested.consumer.ts`
   ~L98–122) inserts `erpnext_posting_status` with:
   ```sql
   INSERT INTO erpnext_posting_status (... source_ref_id, source_system, external_id ...)
   SELECT $1.., source_ref_id, s.source_system, s.external_id ...
     FROM sales s WHERE s.id = $4
   ON CONFLICT (tenant_id, source_ref_id) DO NOTHING
   ```
   → `source_system`/`external_id` come **from the `sales` row** (the ORIGINAL sale's
   provenance) for BOTH `sale_post` AND `reversal`. The per-reversal anchor lives ONLY
   in the separate `source_ref_id` column. DP2's local O-3 unique is
   `(tenant_id, source_ref_id)` — correctly per-reversal **on the DP2 side**.
3. `buildWorkItem` (`apps/api/src/catalog/erpnext-posting/posting-work-item.projection.ts`
   ~L206–224) sets the wire work-item's **top-level** `sourceSystem`/`externalId` =
   `row.sourceSystem`/`row.externalId` = the `sales` row values (the ORIGINAL sale).
   It sets `reversalOf.{sourceSystem,externalId}` ALSO from the sale (`s.source_system`/
   `s.external_id`). **`source_ref_id` is used only to classify void-vs-refund and is
   NOT placed in any wire field.** Confirmed it is never wired: the feed query in
   `erpnext-posting.service.ts` (~L193, ~L209–211) maps `sourceSystem`/`externalId`
   from the status row's `source_system`/`external_id` columns (the sale's).

**Connector side (S1 @ `bc768ad`) — keys on the wire top-level anchor, assumes it is per-reversal:**

4. `contracts.py` (~L198–200): `PostingWorkItem.idempotency_key = (self.source_system,
   self.external_id)` — parsed from the wire `sourceSystem`/`externalId` (the
   **top-level** work-item fields). **No `kind` component.**
5. `reversal_builder.py` (~L100–105): the **F-002 rule** sets
   `rt_external_id = work_item.external_id` (the work-item's OWN top-level externalId),
   with an explicit comment: *"Each reversal work-item has its OWN `external_id` … so
   each yields a distinct `rt_external_id` even when several share one `reversal_of`."*
   → **S1 ASSUMES each reversal work-item carries a distinct top-level `external_id`.**
6. `idempotency.py`: `Key = tuple[str, str]`, `key_for() = work_item.idempotency_key`,
   and `replay_guard()` short-circuits on that key alone — *"echo the existing
   `documentRef` … and NOT re-build/re-submit."*
7. `frappe_glue.py` (the reversal ORCHESTRATOR — call-site confirmed, not inferred):
   `post_work_item` (~L110) routes `kind=reversal` to `_post_reversal` (~L274), which at
   ~L295–297 computes `key = key_for(work_item)` and runs the **replay guard before
   building** the reversing invoice. Its docstring (~L292) states it keys on *"the
   reversal work-item's OWN `(source_system, external_id)`"* — i.e. S1 BELIEVES the wire
   carries the reversal's own distinct anchor. `_resolve_original_invoice` (~L252–267)
   *separately* uses `reversal_of.{sourceSystem,externalId}` for `return_against` (the
   original sale — correct for *locating* the doc). The bug is only in the **replay/
   provenance** anchor, not the locate anchor.

### 3.3 Finding (state with confidence — it is a traced code-fact, NOT softened)

**The anchors do NOT correspond.** DP2's per-reversal cardinality fix lives only in
`source_ref_id`, which is **never placed on the wire**. The wire top-level `externalId`
DP2 emits for a reversal is the **ORIGINAL sale's `external_id`** — identical for the
`sale_post` and for *every* reversal of that sale. S1 keys both its idempotency replay
AND `rt_external_id` on that wire `externalId`, on the explicit assumption that it is
per-reversal-distinct. That assumption is **false on current DP2 code.**

**Consequence — and it is more severe than a multi-reversal collision:**
because the Connector's `idempotency_key` has **no `kind` component**, a reversal
work-item shares the SAME `(sourceSystem, externalId)` key as **its own original
`sale_post`**. On the merged S1 code path, the reversal is mis-deduped against its own
original sale — and **two independent mechanisms each cause this, so the conclusion is
robust regardless of bench/store semantics:**

- **Mechanism 1 — replay short-circuit (call-site confirmed, `frappe_glue.py`
  `_post_reversal` ~L295–297):** `_post_reversal` runs the replay guard on the
  reversal's `key_for(work_item)` = the wire `(source_system, external_id)` = the sale's
  anchor, BEFORE building. The `sale_post` already recorded a `documentRef` under that
  same key (~L238). So the guard finds the sale_post's invoice and **echoes it as a
  duplicate `posted` — the reversing document is never built/submitted.**
- **Mechanism 2 — DB unique-index collision (`reversal_builder.py` ~L23–26):** even if
  replay were bypassed, the `unique_rt_si_provenance` index spans all Sales Invoices via
  `rt_external_id`; the sale_post's SI carries `rt_external_id = E` and the reversal's SI
  would also be written `rt_external_id = E` → a hard unique-index / `IdempotencyConflict`
  at insert.

Net: **even the FIRST reversal of a sale does not post correctly end-to-end** (not merely
the 2nd+); and for a sale voided AND refunded, or N partial refunds, ALL share one wire
anchor and cannot be distinguished. The failure mode is silent-echo (Mechanism 1) or hard
conflict (Mechanism 2), but the conclusion — *the reversing document does not post
correctly on current code* — holds either way.

> **HONESTY CAVEAT.** The wire-anchor construction (DP2) and the connector key/replay
> call-site (`frappe_glue._post_reversal`) are unambiguous in merged code (cited
> file:line). What is NOT separately bench-proven is the *runtime* of S1's concrete
> `IdempotencyStore` — the deferred `[GATED]` T020 Frappe-DocType adapter
> (⏳ BENCH-VALIDATION). The two-mechanism finding above is **UNVERIFIED across the
> boundary** only in that no owner has signed off on the two sides together. It is NOT
> "cardinality is handled." It is "current evidence shows a real cross-system anchor
> mismatch; G2 cannot close until it is resolved."

### 3.4 Candidate fix (RECOMMENDATION for CHECKPOINT-2 — do NOT author here)
A distinct per-reversal anchor **already exists in DP2** — the terminal row's own
`source_system`/`external_id` (written by `recordVoid`/`recordRefund` into
`sale_voids`/`sale_refunds`). It is simply **dropped before the wire**: the emit carries
only `source_ref_id`, and the consumer/projection pull `source_system`/`external_id`
from the `sales` row. The likely-small fix is to **propagate the terminal row's own
provenance to the wire top-level `sourceSystem`/`externalId` for `reversal` work-items**
(keeping `reversalOf` = the original sale), so the wire anchor is per-reversal and
matches S1's F-002 assumption. **Authoring that change (in `posting-feed.yaml` and/or
the emit/consumer/projection code) is a LATER, separately-gated slice — out of scope
here (SC-06/SC-11).** CHECKPOINT-2 decides whether this, or a `kind`-aware connector
key, or another option, is the correct resolution.

---

## 4. QUESTION B — remaining-returnable-quantity (candidate NEW surface; RECOMMEND, do NOT build)

### 4.1 The question
Partial returns (POS-014 FR-4) are bounded by the **remaining un-returned quantity** of
the original sale line. DP2 has **NO** such tracking (zero matches). Under concurrent
partial returns, two returns could each pass a *local* (POS-side) check against the same
remaining quantity and **over-return** (refund/return more than was sold). Does the
returns contract need a **DP2 remaining-returnable-quantity endpoint/state**, or does the
quantity limit stay **POS-local**?

### 4.2 Recommended disposition (RECOMMENDATION for CHECKPOINT-2 — endpoint NOT authored)
**Recommend: do NOT add a DP2 remaining-qty endpoint in this arc. Keep the quantity
limit POS-local for now, and re-evaluate only after Question A is resolved.** Rationale:

1. **B is gated on A.** Until the wire anchor distinguishes reversals (A), N partial
   returns cannot be told apart on the wire — adding DP2 remaining-qty state to bound
   them is premature. A is the precondition; B is downstream.
2. **Concurrency risk is real but bounded.** The over-return window requires *concurrent*
   partial returns of the *same* line — a narrow operational case. DP2 already records
   each refund as an append-only `sale_refunds` row with verbatim POS amount; a
   *reconciliation* detection of over-return (017-style) is a lighter-weight mitigation
   than a new authoritative remaining-qty contract surface, and does not add a new
   write-path contract.
3. **Avoid scope creep / premature contract.** A remaining-qty endpoint is a new
   read-model + likely new state (migration) + a new contract operation. That is a
   distinct, separately-gated slice that should only be opened if (a) A is resolved and
   (b) the owner confirms POS-local + reconciliation is insufficient — mirroring 023's
   "earn implementation only if a concrete need is confirmed" discipline.

**Explicitly: this spec does NOT author a remaining-qty endpoint, read-model, state, or
migration.** It records the recommendation and the open question for CHECKPOINT-2.

---

## 5. User Scenarios & Testing *(determination-scoped)*

### User Story 1 — Owner runs the CHECKPOINT-2 both-sides review (Priority: P1)
The owner uses this spec's `both-sides-review.md` to collect Question A & B evidence
across DP2 and the Connector, and either declares the forward-feed reversal surface
sufficient (with A resolved) or approves a later gated extension slice.

**Why this priority**: Without this, "015 + S1 merged" is mistaken for "returns work."
This story produces the G2 evidence package — the entire purpose of the spec.

**Independent Test**: The both-sides-review scaffold lists Questions A & B with the
traced citations; a reviewer can follow each citation to the named file:line in both
repos and reach the same finding without re-deriving it.

**Acceptance Scenarios**:
1. **Given** the cited DP2 trace (§3.2 steps 1–3), **When** the reviewer opens
   `posting-work-item.projection.ts` ~L206–224 and the consumer INSERT ~L98–122,
   **Then** they confirm the wire `externalId` is the SALE's `external_id`, not
   `source_ref_id`.
2. **Given** the cited Connector trace (§3.2 steps 4–7), **When** the reviewer opens
   `contracts.py` ~L198–200, `idempotency.py`, and `frappe_glue.py` `_post_reversal`
   ~L295–297, **Then** they confirm the replay key is `(sourceSystem, externalId)` with
   no `kind`, and the reversal path runs that replay guard before building.
3. **Given** Questions A and B, **When** the owner records the CHECKPOINT-2 verdict,
   **Then** G2 is signed off (or a gated extension slice is approved) — **by the owner,
   not by this spec**.

### User Story 2 — A future implementer reads an honest "not-proven" status (Priority: P2)
A future agent reading this spec must NOT infer that returns work end-to-end.

**Independent Test**: §0.1 states two distinct not-proven reasons (bench-unverified
apply; wire-anchor mismatch) without merging them.

---

## 6. Requirements *(determination-scoped — NOT build requirements)*

- **FR-001**: This spec MUST frame the determination as **OPEN** (suffices-vs-extend
  unresolved), not pre-decided.
- **FR-002**: This spec MUST surface **Question A** with traced, cited file:line
  evidence from BOTH repos, and state the finding (anchors do NOT correspond) with
  confidence — while keeping the *resolution* open for CHECKPOINT-2.
- **FR-003**: This spec MUST present **Question B** with a recommended disposition and
  rationale, and MUST NOT author any endpoint/state/migration for it.
- **FR-004**: This spec MUST state that end-to-end reversal is **NOT proven**, citing
  the two independent reasons separately (§0.1).
- **FR-005**: This spec MUST NOT mark **G2** satisfied; G2 is the owner's both-sides
  sign-off at CHECKPOINT-2.
- **FR-006**: This spec MUST NOT author or edit any OpenAPI YAML, service code, or
  migration. Recommendations describe candidate changes only.

## 7. Success Criteria *(determination-scoped)*

- **SC-1**: A reviewer can reproduce the Question A finding by following the §3.2
  citations in both repos, without re-deriving the trace.
- **SC-2**: The determination reads as OPEN — no sentence asserts the surface "is
  sufficient" or "cardinality is handled" as fact.
- **SC-3**: No OpenAPI YAML, service code, or migration is authored on this branch
  (verifiable: `git diff` touches only `specs/026-returns-reversal-contract/**`).
- **SC-4**: G2 is NOT marked satisfied anywhere in this spec set.

## 8. Out of Scope (this slice)

- Authoring `posting-feed.yaml` / `sales.yaml` changes (the A candidate fix) — later
  gated slice.
- Authoring a remaining-qty endpoint / read-model / state / migration (B) — later gated
  slice IFF approved.
- Any application/service/consumer/projection code change.
- Any cross-repo status file edit; any Connector/POS/Console/Orchestrator edit
  (READ-ONLY context here).
- Certifying G2 (owner-only at CHECKPOINT-2).

---

## 9. References (read-only, verified 2026-06-09)

- DP2 `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` v1.1.0-draft
  (~L107, 149, 320–401).
- DP2 `apps/api/src/catalog/sales/sales.service.ts` `recordVoid` ~L416 / `recordRefund`
  ~L527.
- DP2 `apps/worker/src/erpnext-posting/posting-requested.consumer.ts` ~L45–122.
- DP2 `apps/api/src/catalog/erpnext-posting/posting-work-item.projection.ts` ~L91–227.
- DP2 `apps/api/src/catalog/erpnext-posting/erpnext-posting.service.ts` ~L187–211.
- DP2 `specs/015-pos-sale-posting-to-erpnext/spec.md` §5.4 (~L245–253), O-3 (~L284).
- Connector (`Retail-Tower-ERP-Next-Connector` @ `bc768ad`, PR #27):
  `connector/posting/reversal_builder.py` (~L23–26, ~L100–105), `idempotency.py`,
  `contracts.py` (~L198–200), `frappe_glue.py` (`post_work_item` ~L110/140,
  `_post_reversal` ~L274/~L295–297, `_resolve_original_invoice` ~L252–267).
