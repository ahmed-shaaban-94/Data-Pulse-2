# Implementation Plan — `026-returns-reversal-contract`

**Branch**: `feat/026-returns-reversal-contract` · **Base**: `origin/main` @ `4997b49`
**Status**: DETERMINATION — OPEN (G2 evidence collection). NOT an implementation slice.

> This is a **determination plan** in the 023 posture: it produces evidence and a
> recommendation for an owner gate (CHECKPOINT-2 / G2). It authors **no** contract YAML,
> service code, or migration. See `spec.md` §0.

---

## Approach

1. **Frame, don't build.** Treat the returns surface as a contract *question*
   (suffices-vs-extend), answered by the owner at CHECKPOINT-2, not by this slice.
2. **Trace both sides of the wire for Question A.** The trace is already done and
   captured in `spec.md` §3.2 and `both-sides-review.md` with file:line citations across
   DP2 and the Connector. The plan's job is to make that trace reproducible, not to
   change either side.
3. **Recommend, don't author, for Question B.** Record the disposition (keep POS-local;
   gated on A) with rationale. No endpoint/state/migration.
4. **Keep G2 open.** The spec set collects evidence; the owner certifies G2.

## Constitution check (DP2 standing rules)

| Principle | Status |
|---|---|
| §III money never rewritten | N/A — no code/contract authored. |
| §IV no silent overwrite / idempotency | The determination *surfaces* an idempotency-anchor mismatch; it does not change idempotency behavior. PASS. |
| §IX DP2 makes no outbound ERPNext HTTP | Unchanged — pull/feed transport, no new push. PASS. |
| §VIII `[GATED]` discipline | Any contract/code change recommended here is a LATER `[GATED]` slice; this slice authors none. PASS. |
| Allowed files | Only `specs/026-returns-reversal-contract/**`. PASS. |

## What a LATER gated slice would do (NOT this slice)

- **026-CONTRACT (`[GATED]`, IFF A-fix approved):** propagate the terminal row's own
  `source_system`/`external_id` to the wire top-level anchor for `reversal` work-items
  (or a `kind`-aware connector key) — touching `posting-feed.yaml` and the
  emit/consumer/projection. RED conformance test first. Out of scope here.
- **026-RETURNS-QTY (`[GATED]`, IFF B-need confirmed AND A resolved):** a remaining-qty
  read-model/state/contract. Out of scope here.

## Risks

- **R1 — misreading "merged" as "works."** Mitigated by `spec.md` §0.1 stating two
  distinct not-proven reasons.
- **R2 — over-reach.** Mitigated by SC-03/SC-06/SC-11: branch diff touches only
  `specs/026-**`.
- **R3 — asserting the finding as G2-certified.** Mitigated by FR-005/SC-04: the spec
  states the finding with confidence but explicitly leaves G2 to the owner.
