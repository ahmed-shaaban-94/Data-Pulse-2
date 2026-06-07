# Wave Status — `025-console-sync-ops-read-model-v1`

> Human-readable summary of where the spec stands. 025 is a **read-model /
> projection** for the Retail Tower Console (sibling admin-UI repo) aggregating the
> ERPNext sync-ops surface — 015 posting status, 017 reconciliation, 020 connector
> health, 021 product-master reconciliation — into a console-facing read API.

**Last updated:** 2026-06-07 by Ahmed Shaaban — **planning chain MERGED to `main`** via PR #525 (squash `75d9967`).
**Spec:** `025-console-sync-ops-read-model-v1` (`specs/025-console-sync-ops-read-model-v1/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch, since deleted).
**Status:** **PLANNING-COMPLETE — NOT dispatched for implementation.** Full SpecKit artifact set on `main` (plus a prose `contracts/console-sync-ops.contract.md`). No `execution-map.yaml`, no slice ledger yet. **Docs-only** — the console read-model OpenAPI contract is described in **prose only** and is a future `[GATED]` slice.

### Artifacts on `main`
`spec.md` (3 US, 16 FR, 8 SC) · `plan.md` (14-row Constitution Check, PASS/N-A-by-class) · `research.md` (R1–R8) · `data-model.md` (projection wire shapes; **no persistence**) · `contracts/console-sync-ops.contract.md` (prose `[GATED]` contract description, 3 GET ops, cookieAuth) · `tasks.md` (30 tasks, `[GATED]` on T003) · `analysis.md` (0 CRITICAL / 0 HIGH / 2 MED / 4 LOW) · `review.md`.

### Key resolved design decisions
- **Compute-on-read projection, no persistence, no new authority, no mirror, no write surface**; cookieAuth/DashboardAuthGuard **human-only** (console = human operator).
- Defines the **full four-domain shape** but v1 populates only the buildable **015 + 017** domains; the **020/021** domains report an explicit `not_available` status until those specs are *implemented* (forward-compat stub — their data sources are not yet built).
- Money pass-through at source precision; structured logs carry `request_id`/`tenant_id`; reuses the shared `apps/api/src/observability/metrics/api.metrics.ts` (no per-feature metrics file).

### Deferrals / blockers
- **MED finding F1:** the real 015/017 source column + enum names are indicative — must be **pinned at impl time**. Tracked as **issue #522**.
- **MED finding F2:** the 020/021 forward-compat stubs stay `not_available` until 020/021 are implemented (those specs are themselves planning-only — this same wave).

### Next recommended action
Dispatch the `[GATED]` foundational task **T003** (author the console read-model OpenAPI contract) for owner approval first — all conformance tests + routes depend on it — and pin the real 015/017 source column/enum names at the same time (resolves MED finding F1 / issue #522). US1 (posting-health + reconciliation summary over 015/017) is the first independently shippable MVP.
