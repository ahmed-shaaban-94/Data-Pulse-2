# Wave Status — `019-erpnext-stock-view-contract`

> Human-readable summary of where the spec stands. 019 is the 017-deferred
> **`017-STOCK-VIEW-CONTRACT`** named by 018 as a future arc handoff: a `[GATED]`
> DP2↔connector **READ** contract for DP2 to read the connector's ERPNext-Bin
> (live on-hand) view, consumed by 017 stock reconciliation (which today runs over
> `EMPTY_BIN_VIEW`).

**Last updated:** 2026-06-07 by Ahmed Shaaban — **CONTRACT slice BUILT + GREEN** in worktree `dp2-019` (branch `feat/019-stock-view-contract`, off `main` `9f8590e`); owner approved the T010 `[GATED]` file. Not yet committed (stop-before-commit).
**Spec:** `019-erpnext-stock-view-contract` (`specs/019-erpnext-stock-view-contract/`)
**Base:** `main` (planning chain MERGED via PR #525 `75d9967`; contract slice built off `9f8590e`).
**Status:** **CONTRACT SLICE GREEN (uncommitted).** RED→GREEN complete: the conformance spec `apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts` (28 tests) failed with the YAML absent, then passed once `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (`[GATED]` T010, approved) was authored. **59/59** erpnext-connector contract tests green (28 stock-view + 31 posting-feed — no regression); `pnpm -r run build` clean. Downstream/future (NOT in this slice): the DP2-side feed/report **runtime** (T040), the **017-rewire** that replaces `EMPTY_BIN_VIEW` (T041, FR-018), and the live cross-system exercise (T042). **NEW (2026-06-07): a Frappe/ERPNext staging env exists in WSL** — partially discharges the staging half of issue #524; the live legs (T042 / 021 US3 / 020 Phase 2) may now be runnable once the connector is wired to it (to assess post-019).

### Slice ledger (this worktree)
| Slice | Tests | Notes |
|---|---|---|
| SETUP (T001/T002) | — | deps confirmed; posting-feed conventions re-read |
| RED (T011) | 28 fail | conformance spec fails for the right reason: contract absent (`loaded ids: [posting-feed]`) |
| `[GATED]` CONTRACT (T010) + US1/US2/US3 (T012/13, T020-22, T030/31) | 28/28 GREEN | `stock-view.yaml` authored; exact-decimal quantity, NO valuation, connectorBearer, closed error set incl. `snapshot_required`, `runRef` correlation, `readAt`/`recordedAt` split, idempotent-replay header |
| T090 | OK | contract self-documents §IX/OQ-1/013-translation/O-6/017-rewire (11 refs) |
| T092 | OK | build clean; no regression (posting-feed 31/31) |

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
