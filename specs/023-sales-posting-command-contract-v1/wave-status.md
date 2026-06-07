# Wave Status — `023-sales-posting-command-contract-v1`

> Human-readable summary of where the spec stands. 023 is the **"sales-posting
> command, *if needed*"** arc handoff named by 018: a command-style (per-work-item,
> imperative) `[GATED]` DP2↔connector contract — an **additive, parallel, optional**
> alternative to the shipped 012/015 pull/feed transport.

**Last updated:** 2026-06-07 by Ahmed Shaaban — **planning chain MERGED to `main`** via PR #525 (squash `75d9967`).
**Spec:** `023-sales-posting-command-contract-v1` (`specs/023-sales-posting-command-contract-v1/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch, since deleted).
**Status:** 📋 **PLAN-ONLY — implement in the future ONLY if a concrete need is confirmed.** Full SpecKit artifact set on `main`. **NOT scheduled for implementation.** No `execution-map.yaml`, no slice ledger. **Docs-only** — the command-contract YAML is described in prose only and is a future `[GATED]` slice.

### Why PLAN-ONLY
The shipped pull/feed transport (012 contract + 015) already posts sales end-to-end and is sufficient for the pilot. 023's command transport earns implementation **only if a concrete need is later confirmed** (low-latency single-sale posting / operator "post this sale now" repair flow / cursor-less connector runtime). That need-confirmation is **task T005, an explicit owner gate** — the `[GATED]` contract slice MUST NOT run until it clears. If no need materialises, 023 stays planning-only indefinitely.

### Artifacts on `main`
`spec.md` (3 US, 17 FR, 6 SC; prominent PLAN-ONLY banner) · `plan.md` (14-principle Constitution Check, PASS) · `research.md` (D-1..D-7) · `data-model.md` (wire shapes; **no new DB schema** — reuses 015/017) · `tasks.md` (21 tasks; owner gates T005/T006/T007) · `analysis.md` · `review.md`.

### Key resolved design decisions
- **OQ-1 RESOLVED by owner 2026-06-07: connector-initiated command.** DP2 stays the HTTP server; genuine DP2→connector **push REJECTED** (it would invert the §IX no-outbound-HTTP invariant and need its own decision record + separate spec). T006 closed.
- **Additive only:** new `operationId`s + new path segment; 012's `posting-feed.yaml` byte-unchanged (§IV).
- Reuses 012 vocabulary verbatim (money / idempotency / error envelope / sale projection); `connectorBearer` machine auth; **NO new schema** (reuses 015 posting-status + 017 recon); Payment-Entry deferral (gate A.5) holds.

### Deferrals / blockers
- **MED finding F-02 (BLOCKS implementation):** the "if needed" need is unvalidated — owner must confirm at **T005** before the contract slice runs. Tracked as **issue #521**.
- Contract YAML authoring is a future `[GATED]` slice (out of scope of this planning pass).

### Next recommended action
Take the **need-confirmation (T005)** to the owner — OQ-1 (transport direction) is already resolved (connector-initiated). If a concrete need is confirmed, record the §VIII `[GATED]` approval (T007) and run the 023-CONTRACT slice (RED conformance test → additive `posting-command.yaml` → GREEN, leaving `posting-feed.yaml` byte-unchanged). Until then, 023 is a complete, parked planning spec.
