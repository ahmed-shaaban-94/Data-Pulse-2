# Wave Status — `019-erpnext-stock-view-contract`

> Human-readable summary of where the spec stands. 019 is the 017-deferred
> **`017-STOCK-VIEW-CONTRACT`** named by 018 as a future arc handoff: a `[GATED]`
> DP2↔connector **READ** contract for DP2 to read the connector's ERPNext-Bin
> (live on-hand) view, consumed by 017 stock reconciliation (which today runs over
> `EMPTY_BIN_VIEW`).

**Last updated:** 2026-06-08 — **CONTRACT SLICE CLOSED. MERGED to `main` via PR #526 (`88562af`, 2026-06-07).** Owner approved T010 `[GATED]`; RED→GREEN complete; PR opened + merged same day.
**Spec:** `019-erpnext-stock-view-contract` (`specs/019-erpnext-stock-view-contract/`)
**Base:** `main` (planning chain MERGED via PR #525 `75d9967`; contract slice merged via PR #526 `88562af`).
**Status:** **CLOSED.** RED→GREEN complete: the conformance spec `apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts` (29 tests) failed with the YAML absent, then passed once `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (`[GATED]` T010, approved) was authored. **60/60** erpnext-connector contract tests green (29 stock-view + 31 posting-feed — no regression); `pnpm -r run build` clean. Downstream/future (NOT in this slice): the DP2-side feed/report **runtime** (T040), the **017-rewire** that replaces `EMPTY_BIN_VIEW` (T041, FR-018), and the live cross-system exercise (T042). **A Frappe/ERPNext staging env exists in WSL** (`devcontainer-frappe-1`, `retail.localhost`) — partially discharges the staging half of issue #524; the live legs (T042 / 021 US3 / 020 Phase 2) may now be runnable once the connector is wired to it (to assess post-019).

### Slice ledger
| Slice | Tests | Notes |
|---|---|---|
| SETUP (T001/T002) | — | deps confirmed; posting-feed conventions re-read |
| RED (T011) | 29 fail | conformance spec fails for the right reason: contract absent (`loaded ids: [posting-feed]`) |
| `[GATED]` CONTRACT (T010) + US1/US2/US3 (T012/13, T020-22, T030/31) | 29/29 GREEN | `stock-view.yaml` authored; exact-decimal quantity, NO valuation, connectorBearer, closed error set incl. `snapshot_required`, `runRef` correlation, `readAt`/`recordedAt` split, idempotent-replay header; HIGH fix: `BinViewItemWindow` (≤500-item window, truncation-safe); MED fixes: `erpnextWarehouseRef`+`readAt` echoed on `RecordedBinView`; `stockUom` on `BinEntry` |
| T090 | OK | contract self-documents §IX/OQ-1/013-translation/O-6/017-rewire (11 refs) |
| T092 | OK | build clean; no regression (posting-feed 31/31) |

### Artifacts on `main` (PR #526)
`spec.md` · `plan.md` (Constitution Check, all PASS) · `research.md` (R1–R9) · `data-model.md` (wire entities updated; **no new table, no migration** — read-only view) · `tasks.md` (all CONTRACT-slice tasks terminal) · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 5 LOW / 1 INFO) · `review.md` · **`packages/contracts/openapi/erpnext-connector/stock-view.yaml`** (`[GATED]`, 629 lines) · **`apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts`** (544 lines, 29 tests).

### Key resolved design decisions
- Connector is the HTTP **client**; DP2 is the **server** (§IX no-outbound-HTTP invariant).
- **Pull-request + report** idiom mirroring 012's `connectorPullPostings` / `connectorAckOutcome`.
- **NO standing Bin mirror** (signed 014 stock-impact decision — DP2 = operational on-hand authority, ERPNext = valuation); run-scoped evidence lives in 017 `result.detail`, so 019 touches **no `packages/db` surface** and needs **no migration**.
- Items keyed by `erpnextItemRef`, DP2-side-translated to `tenant_product_ref` via the confirmed 013 map.
- The 017 sync→async run-lifecycle rewire is **out of scope** (FR-018; future 017-rewire slice).

### Deferrals / open follow-ups
- **Cross-system / external:** the live-leg exercise (T042) needs the connector repo wired to the WSL staging ERPNext (`retail.localhost`). Tracked under issue #524.
- **MED finding F-03:** the contract is correct but inert until the separate **017-rewire** slice (T041) replaces `EMPTY_BIN_VIEW` and the connector builds against this surface — owner to track.
- **T040** (DP2-side feed/report runtime) + **T041** (017-rewire) remain future slices, not dispatchable until separately approved.

### Next recommended action
019-CONTRACT is **CLOSED**. The connector repo can now build against the pinned `stock-view.yaml` surface. Next in-repo work: **T041 (017-rewire)** to replace `EMPTY_BIN_VIEW` with the report-backed implementation, or **T040 (DP2 runtime)** — both need their own approval. The live exercise (T042) is unblocked once the connector wires to the WSL staging ERPNext.
