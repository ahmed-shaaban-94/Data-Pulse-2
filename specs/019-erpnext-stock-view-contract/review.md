# Self-Review: 019 — ERPNext live stock-view (Bin) read contract

**Date**: 2026-06-07 · **Constitution**: v3.0.1

## Does the artifact set hold up?

- **Honors the constitution** — YES. §IX is the principle this spec most directly
  serves: reconcile-not-merge, no read-down of valuation, **no standing Bin
  mirror** (the signed 014 OQ-1). §II/§XII (non-disclosing isolation), §III
  (exact-decimal, no float), §IV (contract-first, stable operationIds, strict wire
  projections), §X (connector `readAt` preserved, server `recordedAt`), §XI
  (Idempotency-Key reuse), §XIV (no PII/money on the surface) all PASS. §V's
  async-run concern is deferred, not violated.
- **Stays no-implement** — YES. Only markdown planning artifacts authored under
  `specs/019-erpnext-stock-view-contract/`. No code, no YAML, no migration.
- **Avoids gated surfaces** — YES. No file created/edited under
  `packages/contracts/openapi/**`, `packages/db/**`, `.github/**`, `package.json`,
  or `pnpm-lock.yaml`. The future contract YAML is described in prose and flagged
  `[GATED]` (tasks T010). FR-009's no-standing-mirror decision deliberately keeps
  019 off `packages/db` entirely (no migration even proposed).
- **Coherent + buildable** — YES. The two operations mirror the shipped 012
  pull/report idiom; the conformance-test convention mirrors `posting-feed`. Every
  FR maps to ≥1 task; every user story is independently testable; the analysis
  found no CRITICAL/HIGH.

## Residual risks

1. **(MEDIUM, F-03) The contract is inert until the 017-rewire ships.** 019 pins a
   correct surface (unblocking the connector repo) but nothing consumes it until a
   separate slice makes the 017 run lifecycle async + report-backed (replacing
   `EMPTY_BIN_VIEW`). This is deliberate scope discipline (the 012 precedent: ship
   the contract, build the runtime later) but the owner should track the follow-up.
2. **(LOW) Async run-lifecycle redesign is non-trivial.** When T041 is specced, the
   017 run can no longer complete in one transaction — request→await→report→complete
   likely needs a `[GATED]` outbox event-type + `worker.module.ts` wiring. Named,
   not designed here.
3. **(EXTERNAL) Live cross-system validation is still gated** on the connector
   repo's live ERPNext-Bin reader + a staging ERPNext — the same gate 017 carried.
   019 authoring is not blocked by it (FR-011 version-independence + A-2).
4. **(LOW) ERPNext major unconfirmed** (A-1) — mitigated by version-independence
   (FR-011); the `erpnextWarehouseRef`/`erpnextItemRef` strings are opaque.

## Single recommended next action

**Obtain explicit `[GATED]` approval for tasks T010** (author
`packages/contracts/openapi/erpnext-connector/stock-view.yaml` + its conformance
spec), then dispatch the CONTRACT slice (US1 MVP first). That is the only buildable,
in-repo deliverable of 019; it pins the surface and unblocks the connector repo,
exactly as 012's contract slice did — while the DP2-facing runtime (T040) and the
017-rewire (T041) follow as separate, approval-gated slices.
