# Wave Status — `026-returns-reversal-contract`

> Arc A S2: frame the DP2 returns/reversal surface as a **G2-verified contract**, as an
> **OPEN determination** (suffices-vs-extend) driven by two questions the CHECKPOINT-2
> both-sides review must resolve. **Determination spec, not an implementation slice** —
> mirrors 023's parked posture.

**Last updated:** 2026-06-09 by Ahmed Shaaban — determination authored on
`feat/026-returns-reversal-contract` (off `origin/main` @ `4997b49`). **NOT committed,
NOT pushed, NO PR.**
**Spec:** `026-returns-reversal-contract` (`specs/026-returns-reversal-contract/`)
**Status:** 🧭 **DETERMINATION — OPEN.** G2 NOT certified (owner-only at CHECKPOINT-2).
No contract YAML / service code / migration authored. End-to-end reversal **NOT proven**.

---

## Determination outcome (recommendation FOR CHECKPOINT-2 — NOT a decision)

The existing **forward-feed reversal surface MOSTLY SUFFICES** at the contract-shape
level (reversing-document primitive + `reversal` work-item + `reversalOf` + a documented
wire idempotency anchor all exist). A *new dedicated returns contract* is likely not
warranted. **BUT** the conclusion is gated on two open questions, and current evidence
on Question A indicates a real cross-system defect that must be resolved before G2 can
close.

## Question A — cardinality-anchor correspondence  →  **FINDING: anchors do NOT correspond** (resolution OPEN)

Traced end-to-end across BOTH repos (cited file:line in `spec.md` §3.2 /
`both-sides-review.md`):

- DP2's per-reversal cardinality fix lives only in `source_ref_id` and is **never put
  on the wire**. `buildWorkItem` emits the **original sale's** `external_id` as the wire
  top-level `externalId` for every reversal (consumer pulls `s.source_system/external_id`
  from the `sales` row).
- The Connector keys idempotency on `(sourceSystem, externalId)` **with no `kind`**, and
  writes `rt_external_id = work_item.external_id`, **assuming** per-reversal distinctness
  that DP2 does not provide.
- **Consequence (more severe than multi-reversal collision):** a reversal shares its own
  `sale_post`'s anchor → the connector's `replay_guard` short-circuits and **never builds
  the reversing document — even the FIRST reversal of a sale does not post end-to-end.**

**This is the #1 open question and the precondition for G2.** Candidate fix
(recommendation only): propagate the terminal row's own provenance — which already exists
in `sale_voids`/`sale_refunds` — to the wire anchor for reversals. **Not authored** (later
`[GATED]` 026-CONTRACT slice). Honesty caveat: S1's concrete `IdempotencyStore` is a
deferred bench-unverified adapter, so the runtime is code-logic-traced, not bench-proven.

## Question B — remaining-returnable-quantity  →  **RECOMMEND: keep POS-local; gated on A**

DP2 has no remaining-qty tracking; concurrent partial returns could over-return.
**Recommended disposition (owner ratifies at T005):** do NOT add a DP2 remaining-qty
endpoint/state/migration in this arc — keep the limit POS-local + lean on
reconciliation; B is moot until A distinguishes reversals on the wire. **Endpoint NOT
authored.**

## Why end-to-end reversal is NOT proven (two independent reasons — do not merge)

1. **S1 apply leg bench-unverified** (Connector PR #27 @ `bc768ad`; concrete
   `IdempotencyStore` is the deferred `[GATED]` T020 Frappe adapter, ⏳ BENCH-VALIDATION).
2. **Question A wire-anchor mismatch** — a code-logic finding independent of bench.

## Artifacts on this branch

`spec.md` (determination, Questions A & B, FR-001..006, SC-1..4) · `plan.md`
(determination posture, Constitution check PASS) · `tasks.md` (T001-003 authored;
T004-006 owner gates; T007-008 future `[GATED]`) · `execution-map.yaml` (parked,
non-dispatchable; G2 NOT-CERTIFIED) · `both-sides-review.md` (CHECKPOINT-2 scaffold).

## Next recommended action

Take **Question A** to CHECKPOINT-2 as the #1 G2 blocker (T004): confirm the trace
against live code + S1 store semantics, decide the resolution. Ratify the Question B
disposition (T005). G2 sign-off (T006) is owner-only. Only after T004/T005 clear do the
future `[GATED]` 026-CONTRACT / 026-RETURNS-QTY slices open.
