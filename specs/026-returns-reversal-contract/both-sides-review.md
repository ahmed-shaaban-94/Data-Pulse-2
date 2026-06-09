# CHECKPOINT-2 Both-Sides Review Scaffold — `026-returns-reversal-contract`

> **Purpose.** This is the **G2 evidence package**, NOT a G2 certification. It lists the
> two questions the owner + both-sides reviewers (DP2 side + Connector side) must resolve
> at CHECKPOINT-2 before the returns/reversal contract can be declared sufficient. G2 is
> the owner's sign-off here — this document only *collects* the evidence (SC-09).
>
> **All citations are verified read-only on 2026-06-09.** DP2 @ `origin/main` 4997b49 on
> branch `feat/026-returns-reversal-contract`; Connector `Retail-Tower-ERP-Next-Connector`
> @ `bc768ad` (PR #27). Both repos are READ-ONLY context for this slice.

---

## How to use this scaffold

For each question: (1) follow the cited file:line on BOTH sides; (2) confirm or refute
the stated finding; (3) record the owner verdict and resolution. Do **not** treat the
"current evidence" boxes as decided — they are traced facts pending the both-sides verdict.

---

## QUESTION A — does DP2's `source_ref_id` correspond to the `externalId` S1 keys on?  ★ #1 G2 PRECONDITION

### Evidence to collect / confirm

**DP2 side — where does the wire `externalId` for a reversal come from?**

| # | File:line | What to confirm |
|---|---|---|
| A1 | `apps/api/src/catalog/sales/sales.service.ts` `recordVoid` ~L416 / `recordRefund` ~L527 | The terminal row stores its OWN provenance (`body.sourceSystem`/`externalId`) in `sale_voids`/`sale_refunds`, but the `erpnext.posting.requested` emit payload carries ONLY `source_ref_id = row.id` (+ sale_id/store_id/kind) — the terminal row's own provenance is NOT in the emit. |
| A2 | `apps/worker/src/erpnext-posting/posting-requested.consumer.ts` ~L98–122 | The `erpnext_posting_status` INSERT sources `source_system`/`external_id` from `SELECT … s.source_system, s.external_id FROM sales s` — the ORIGINAL sale, for BOTH `sale_post` AND `reversal`. The local O-3 unique is `(tenant_id, source_ref_id)` — per-reversal on the DP2 side only. |
| A3 | `apps/api/src/catalog/erpnext-posting/posting-work-item.projection.ts` ~L206–224 | The wire work-item top-level `sourceSystem`/`externalId` = `row.sourceSystem`/`row.externalId` (the sale's). `reversalOf` ALSO = the sale's provenance. `source_ref_id` is used ONLY to classify void-vs-refund (~L189–203); it is placed in NO wire field. |
| A4 | `apps/api/src/catalog/erpnext-posting/erpnext-posting.service.ts` ~L193, ~L209–211 | The feed query maps `sourceSystem`/`externalId` from the status row's `source_system`/`external_id` columns — confirming the sale's provenance reaches the wire, not `source_ref_id`. |

**Connector side (S1 @ `bc768ad`) — what does S1 key on, and what does it assume?**

| # | File:line | What to confirm |
|---|---|---|
| A5 | `connector/posting/contracts.py` ~L198–200 | `PostingWorkItem.idempotency_key = (self.source_system, self.external_id)` from the wire top-level fields. **No `kind` component.** |
| A6 | `connector/posting/idempotency.py` | `Key = tuple[str, str]`; `replay_guard()` short-circuits on the key alone ("echo existing documentRef … NOT re-build/re-submit"). Concrete store is the deferred `[GATED]` T020 Frappe adapter (⏳ BENCH-VALIDATION). |
| A7 | `connector/posting/reversal_builder.py` ~L100–105 (+ ~L23–26) | F-002 rule: `rt_external_id = work_item.external_id` (the work-item's OWN top-level externalId), with the explicit comment that each reversal has its OWN `external_id` → distinct `rt_external_id`. **S1 ASSUMES per-reversal distinctness DP2 does not deliver.** L23–26: `unique_rt_si_provenance` spans ALL Sales Invoices via `rt_external_id` → a second SI with the same `rt_external_id` hard-collides. |
| A8 | `connector/posting/frappe_glue.py` `_post_reversal` ~L274, ~L295–297 (routed from `post_work_item` ~L110/140) | The reversal ORCHESTRATOR (call-site, not inferred): computes `key = key_for(work_item)` = wire `(source_system, external_id)` and runs the **replay guard BEFORE building**. Docstring ~L292: keys on *"the reversal work-item's OWN (source_system, external_id)"* — confirming S1's false assumption. `_resolve_original_invoice` ~L252–267 separately uses `reversal_of.*` for `return_against` (correct for *locating* the original; the bug is only in the replay/provenance anchor). |

### Current evidence (traced; pending both-sides verdict)
> **The anchors do NOT correspond.** The wire `externalId` DP2 emits for a reversal is
> the **original sale's** `external_id` — identical for the `sale_post` and every
> reversal of that sale. S1 keys idempotency (no `kind`) AND `rt_external_id` on that
> wire `externalId`, on the false assumption it is per-reversal-distinct. So a reversal
> collides with **its own original `sale_post`** via **two independent mechanisms**:
> (1) `_post_reversal`'s replay guard (A8) finds the sale_post's `documentRef` and
> short-circuits → reversing doc never built; (2) failing that, the
> `unique_rt_si_provenance` index (A7) hard-collides at insert. **Even the first reversal
> does not post correctly end-to-end** — more severe than a 2nd-reversal-only collision.
>
> **Caveat:** the wire-anchor construction and the connector key/replay call-site are
> unambiguous in merged code (cited). The runtime of S1's concrete (bench-unverified)
> `IdempotencyStore` is the only piece not separately proven; the two-mechanism
> conclusion holds regardless. UNVERIFIED across the boundary until owner sign-off.

### Resolution options for the owner (NONE authored here)
- **A-opt-1 (DP2 wire-anchor fix):** propagate the terminal row's own
  `source_system`/`external_id` to the wire top-level anchor for `reversal` work-items
  (keep `reversalOf` = original sale). Small — the distinct anchor already exists in
  `sale_voids`/`sale_refunds`. Touches `posting-feed.yaml` + emit/consumer/projection →
  later `[GATED]` 026-CONTRACT slice.
- **A-opt-2 (connector `kind`-aware key):** add `kind` (or `source_ref_id`, if wired) to
  the connector idempotency key. Touches the Connector — separate repo, separate gate.
- **A-opt-3:** other, per reviewer judgment.

### Owner verdict (CHECKPOINT-2 / T004) — _to be recorded_
- Anchors correspond? ☐ confirmed-do-not-correspond  ☐ refuted (explain)
- Chosen resolution: ______________________
- G2 precondition satisfied? ☐ yes (resolution agreed)  ☐ no (still blocking)

---

## QUESTION B — does the returns contract need a DP2 remaining-returnable-quantity surface?

### Evidence to collect / confirm
| # | Fact | Source |
|---|---|---|
| B1 | DP2 has NO remaining-returnable-quantity tracking (endpoint or state). | Searched 2026-06-09 — zero matches. |
| B2 | Each refund is an append-only `sale_refunds` row with verbatim POS amount; void is `sale_voids`. | `sales.service.ts` `recordRefund`/`recordVoid`. |
| B3 | Partial returns (POS-014 FR-4) are bounded by remaining un-returned qty — enforced POS-locally today. | POS-014 (read-only context). |
| B4 | Concurrent partial returns of the same line could each pass a local check → over-return. | Concurrency reasoning. |

### Recommended disposition (owner ratifies; endpoint NOT authored)
> **Keep the quantity limit POS-local for this arc; do NOT add a DP2 remaining-qty
> endpoint/state/migration.** Rationale: (1) **B is gated on A** — N partial reversals are
> indistinguishable on the wire until A is resolved; (2) over-return is a narrow
> concurrent-same-line case better caught by reconciliation (017-style) than a new
> authoritative write-path contract; (3) avoid a premature contract surface — open a
> `026-RETURNS-QTY` slice ONLY IFF the owner confirms a concrete need AND A is resolved.

### Owner verdict (CHECKPOINT-2 / T005) — _to be recorded_
- Disposition: ☐ keep POS-local + reconciliation (as recommended)  ☐ confirm need for DP2 remaining-qty surface
- If a need is confirmed: open future `[GATED]` `026-RETURNS-QTY` (precondition: A resolved).

---

## G2 sign-off (CHECKPOINT-2 / T006) — OWNER ONLY — _to be recorded_

- [ ] Question A resolved (resolution agreed; e2e collision addressed).
- [ ] Question B disposition ratified.
- [ ] End-to-end reversal proven OR a clear path recorded (incl. S1 bench validation).
- [ ] **Verdict:** ☐ forward-feed reversal surface SUFFICIENT (G2 satisfied)
      ☐ `[GATED]` extension slice(s) APPROVED (G2 satisfied conditional on those slices)

> **This document does not check any of the boxes above. G2 is satisfied only when the
> owner records this verdict at CHECKPOINT-2.**
