# Wave Status — `020-connector-health-and-connection-status-api`

> Human-readable summary of where the spec stands. 020 is the **connector
> health / connection-status** surface named by 018 as a future arc handoff: it
> exposes the liveness / last-seen / connection state of a registered connector
> instance (built over 018's `connector_registration` identity + the
> `connector_lifecycle_total` signal).

**Last updated:** 2026-06-07 by Ahmed Shaaban — **planning chain MERGED to `main`** via PR #525 (squash `75d9967`).
**Spec:** `020-connector-health-and-connection-status-api` (`specs/020-connector-health-and-connection-status-api/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch, since deleted).
**Status:** **PLANNING-COMPLETE — NOT dispatched for implementation.** Full SpecKit artifact set on `main`. No `execution-map.yaml`, no slice ledger yet. **Docs-only** — the new `connector_health` table/migration and `connector-health.yaml` contract are described in **prose only** and flagged `[GATED]`.

### Artifacts on `main`
`spec.md` · `plan.md` (Constitution Check, all PASS) · `research.md` (D1–D7) · `data-model.md` (`connector_health`, one row per registration, FK to 018 `connector_registration`; **prose-only `[GATED]`**) · `tasks.md` (`[GATED]` on T003/T004/T006) · `analysis.md` (0 CRITICAL / 0 HIGH / 1 MED / 6 LOW) · `review.md`.

### Key resolved design decisions
- New `connector_health` table (one row per `connector_registration`), fail-closed RLS; **NO money / NO PII** (observational BUSINESS-class only).
- Indicative migration **`0022`** — **collides with 021's indicative `0022`** (see #520); whichever SCHEMA slice authors second takes the next free number.
- New `[GATED]` `connector-health.yaml` contract (vs extending 018's cookieAuth-only `connector-admin.yaml`); auth posture resolved in research D6/D7.
- Staleness threshold ~5 min; signal = unlabeled `connector_heartbeat_total` counter (registered in the shared `apps/api/src/observability/metrics/api.metrics.ts`, not a per-feature file).

### Deferrals / blockers
- **MED finding F4:** no v1 proactive dark-detection — v1 is **operator-poll-only**. Proactive alerting via a scheduled sweep is deferred — tracked as **issue #523**.
- **Migration-number collision** with 021 — tracked as **issue #520**.

### Next recommended action
Submit the planning chain for human gate review of the two `[GATED]` surfaces (the `connector_health` schema/migration and the new `connector-health.yaml` contract). On approval, dispatch Foundational T003–T006 first, then the P1 MVP (operator connection-status read) as the first independently shippable slice.
