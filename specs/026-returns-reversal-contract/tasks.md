# Tasks — `026-returns-reversal-contract`

**Status**: DETERMINATION — OPEN. Tasks are evidence-collection + owner gates, NOT a
build slice. No contract YAML / code / migration authored by any task here.

> Owner gates (T004/T005) gate any FUTURE implementation; they are NOT cleared by this
> slice. G2 is certified by the owner at CHECKPOINT-2, not by completing these tasks.

---

## Phase 0 — Determination authoring (this slice; DONE on this branch)

- [x] **T001** Author `spec.md` framing the determination as OPEN (suffices-vs-extend),
      with Questions A & B. (FR-001..FR-006)
- [x] **T002** Author `both-sides-review.md` — the CHECKPOINT-2 scaffold listing
      Questions A & B as the G2 evidence to collect, with traced file:line citations
      across DP2 and the Connector.
- [x] **T003** Author `plan.md`, `execution-map.yaml`, `wave-status.md` in the
      determination/parked posture (mirrors 023). No dispatchable contract-authoring
      slice created.

## Phase 1 — CHECKPOINT-2 both-sides review (OWNER; NOT this slice)

- [ ] **T004 [GATE — G2 evidence: Question A]** Owner + both-sides reviewers confirm
      the Question A trace against live DP2 + Connector code and S1's intended/realized
      `IdempotencyStore` semantics. Decide the resolution (propagate terminal-row
      provenance to wire / `kind`-aware connector key / other). **Until cleared,
      returns do NOT work end-to-end and G2 cannot close.**
- [ ] **T005 [GATE — Question B disposition]** Owner ratifies the recommended
      disposition (keep POS-local + reconciliation; gated on A) OR confirms a concrete
      need for a DP2 remaining-qty surface. Only on a confirmed need does a future
      `026-RETURNS-QTY` slice open.
- [ ] **T006 [GATE — G2 sign-off]** Owner records the CHECKPOINT-2 verdict: forward-feed
      reversal surface sufficient (A resolved) OR a `[GATED]` extension slice approved.
      **This is the G2 certification — owner-only.**

## Phase 2 — Future gated implementation (ONLY if approved at Phase 1; NOT this slice)

- [ ] **T007 [GATED]** `026-CONTRACT` — author the A-fix (wire anchor) per the T004
      verdict: RED conformance test → minimal `posting-feed.yaml` + emit/consumer/
      projection change → GREEN. Out of scope here.
- [ ] **T008 [GATED]** `026-RETURNS-QTY` — remaining-qty surface, IFF T005 confirmed a
      need. Out of scope here.

## Verification (this slice)

- [ ] **V1** `git diff origin/main...HEAD --name-only` lists ONLY
      `specs/026-returns-reversal-contract/**` (SC-03/SC-06/SC-11).
- [ ] **V2** No occurrence of "G2 satisfied" / "cardinality is handled" / "returns work
      end-to-end" as an assertion anywhere in the spec set (SC-02/SC-04).
