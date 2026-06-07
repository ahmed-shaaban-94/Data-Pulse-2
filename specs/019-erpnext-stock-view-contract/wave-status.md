# Wave Status — `019-erpnext-stock-view-contract`

> Human-readable summary of where the spec stands. 019 is the 017-deferred
> **`017-STOCK-VIEW-CONTRACT`** named by 018 as a future arc handoff: a `[GATED]`
> DP2↔connector **READ** contract for DP2 to read the connector's ERPNext-Bin
> (live on-hand) view, consumed by 017 stock reconciliation (which today runs over
> `EMPTY_BIN_VIEW`).

**Last updated:** 2026-06-07 by Ahmed Shaaban — **planning chain MERGED to `main`** via PR #525 (squash `75d9967`).
**Spec:** `019-erpnext-stock-view-contract` (`specs/019-erpnext-stock-view-contract/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch, since deleted).
**Status:** **PLANNING-COMPLETE — NOT dispatched for implementation.** The full SpecKit artifact set is on `main` (spec / plan / research / data-model / tasks / analysis / review). No `execution-map.yaml`, no slice ledger yet: implementation has not started. This is **docs-only** — no code, no OpenAPI YAML, no schema, no migration authored.

### Artifacts on `main`
`spec.md` · `plan.md` (Constitution Check, all PASS) · `research.md` (R1–R9) · `data-model.md` (wire entities; **no new table, no migration** — read-only view) · `tasks.md` (`[GATED]` on T010) · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 5 LOW / 1 INFO) · `review.md`.

### Key resolved design decisions
- Connector is the HTTP **client**; DP2 is the **server** (§IX no-outbound-HTTP invariant).
- **Pull-request + report** idiom mirroring 012's `connectorPullPostings` / `connectorAckOutcome`.
- **NO standing Bin mirror** (signed 014 stock-impact decision — DP2 = operational on-hand authority, ERPNext = valuation); run-scoped evidence lives in 017 `result.detail`, so 019 touches **no `packages/db` surface** and needs **no migration**.
- Items keyed by `erpnextItemRef`, DP2-side-translated to `tenant_product_ref` via the confirmed 013 map.
- The 017 sync→async run-lifecycle rewire is **out of scope** (FR-018; future 017-rewire slice).

### Deferrals / blockers (not blockers to *this* planning spec)
- **Cross-system / external (BLOCKS implementation):** authoring + exercising the contract needs the connector repo (`Retail-Tower-ERP-Next-Connector`) + a staging ERPNext. Tracked under the **live-leg frontier epic, issue #524**.
- **MED finding F-03:** the contract is correct but inert until a separate 017-rewire consumes it — owner to track.

### Next recommended action
Obtain explicit `[GATED]` approval for **task T010** (author `packages/contracts/openapi/erpnext-connector/stock-view.yaml` + its conformance spec), then dispatch the CONTRACT slice US1-first — the only buildable in-repo deliverable; it pins the surface and unblocks the connector repo, exactly as 012's contract slice did. Blocked on the live-leg frontier (#524) for actual exercise.
