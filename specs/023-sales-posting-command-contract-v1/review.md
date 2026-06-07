# Self-Review: Sales-Posting Command Contract v1

**Feature**: 023-sales-posting-command-contract-v1 | **Date**: 2026-06-07 | **Constitution**: v3.0.1

## Does the artifact set honor the constitution?

Yes. The plan's Constitution Check covers all 14 principles with PASS verdicts.
The load-bearing risks are handled correctly:
- sec.IX (source-of-truth / no-outbound-HTTP): the sale fact is never mutated;
  only the 015 posting status advances. The no-outbound invariant is preserved by
  the connector-initiated command; the inversion (genuine push) was OQ-1 and was
  **REJECTED by the owner 2026-06-07**, NOT adopted.
- sec.IV (contract-first / additive): new operationIds + new path segment; the
  012 feed is untouched; conformance test required; explicit wire projections.
- sec.XI / sec.XII / sec.III (idempotency, object safety, money): reused verbatim
  from 012 — required Idempotency-Key, scope-from-principal, exact-decimal string
  money. No new primitive.
- Gate A.5 (Payment Entry deferral) and gate A.6 (no float money) both held.

## Is it no-implement?

Yes. No application code, no DB schema, no migration, no OpenAPI YAML, no
package.json/lockfile, no CI, no connector code was authored. The eventual
contract YAML + conformance test are described in prose and every task touching
them carries [GATED] and is explicitly NOT executed in this pass.

## Does it avoid gated surfaces?

Yes. Nothing was written under packages/contracts/openapi/**, packages/db/**,
.github/**, package.json, or pnpm-lock.yaml. All seven artifacts live under
specs/023-sales-posting-command-contract-v1/.

## Is it a coherent, buildable spec?

Yes — once the two owner gates clear. The spec/plan/tasks/research/data-model are
mutually consistent (analysis.md cross-checks pass; every FR maps to >=1 task;
every user story maps to a phase; no orphan implementation tasks). The contract
is a thin, additive, well-grounded mirror of the shipped 012 transport, so the
implementation risk is low.

## Residual risks

1. (RESOLVED 2026-06-07) OQ-1 — genuine DP2->connector push vs connector-initiated
   command. **Owner resolved → connector-initiated; genuine push rejected** (it
   would invert sec.IX and need its own decision record + separate spec). No longer
   a residual risk; T006 is closed. The YAML auth/path design is unblocked under
   the connector-initiated model.
2. (MEDIUM, owner) The "if needed" justification — the concrete need for a command
   transport over the working pull feed is an unvalidated assumption. If no need
   is confirmed, 023 stays planning-only (gated, T005). This is the right posture
   for an "if needed" handoff but means the contract slice may never run.
3. (LOW) Command-fetch verb (GET vs POST-to-claim) deferred to the contract slice;
   both preserve the invariant.

## Single recommended next action

Take the **need-confirmation (T005)** to the owner — OQ-1 (transport direction) is
already resolved (connector-initiated). If the owner confirms a concrete need,
record the sec.VIII [GATED] approval (T007) and run the 023-CONTRACT implementation
slice (RED conformance test -> additive posting-command.yaml -> GREEN). Genuine
push is rejected and out of scope for 023.
Until then, 023 is a complete, parked planning spec.
