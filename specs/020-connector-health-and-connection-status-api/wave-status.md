# Wave Status — `020-connector-health-and-connection-status-api`

> Human-readable summary of where the spec stands. 020 is the **connector
> health / connection-status** surface named by 018 as a future arc handoff: it
> exposes the liveness / last-seen / connection state of a registered connector
> instance (built over 018's `connector_registration` identity + the
> `connector_lifecycle_total` signal).

**Last updated:** 2026-06-08 by Ahmed Shaaban — **SHIPPED via PR #534 (`6dac49f`)**, merged to `main`.
**Spec:** `020-connector-health-and-connection-status-api` (`specs/020-connector-health-and-connection-status-api/`)
**Base:** `main` (planning produced in an isolated worktree off `cfbf0a4`; merged via the combined `docs/019-025-planning-wave` branch; implementation on `feat/wave-020-021-025-impl`, merged via PR #534).
**Status:** **CLOSED — all tasks complete. Full implementation shipped via PR #534 (`6dac49f`, 2026-06-08).** The `[GATED]` migration `0022` `connector_health` table + `[GATED]` `connector-health.yaml` contract are on `main`.

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

---

## Implementation — MERGED via PR #534 (`6dac49f`, 2026-06-08)

**Gate PRE-APPROVED** for the 020/021/025 wave; all `[GATED]` surfaces authored and shipped. The full feature (US1 + US2 + US3 + foundational + polish) is on `main`, GREEN on Testcontainers (WSL).

**Migration number resolved:** 020 took **`0022_connector_health`** (authored first in the wave); 021 takes `0023` (the #520 collision is resolved by authoring order — each `EXPECTED_MIGRATIONS` append is a tail/lex append, avoiding the #447-class mid-array insert).

### Tasks completed (T001–T032)
- **Setup (T001–T002):** `apps/api/src/connector-health/` module + `apps/api/test/connector-health/` seed helper (`seed-connector-health.ts`, reuses the 003 isolation-harness IDs; A-healthy / A-never / A-disabled / B-cross-tenant).
- **Foundational (T003–T008):** `[GATED]` Drizzle schema `packages/db/src/schema/connector-health.ts`; `[GATED]` migration `0022_connector_health.sql` (+ `.down.sql`) — FK→`connector_registration` ON DELETE CASCADE, UNIQUE on `connector_registration_id`, NO `version` column, fail-closed empty-GUC RLS (SELECT/INSERT/UPDATE, no DELETE) mirroring 0019/0020/0021; allowlist regression (EXPECTED_MIGRATIONS + barrel export); `[GATED]` contract `connector-health.yaml`; pure `deriveLiveness` helper + its unit RED→GREEN (9/9).
- **US1 (T009–T016):** `ConnectorHealthView` projection, service `listHealth`/`getHealth` (LEFT JOIN registration ⟕ health + read-derived verdict via `runWithTenantContext`), the session-only read controller. Cross-tenant → safe 404.
- **US2 (T017–T026):** strict `.strict()` heartbeat DTO (self-reported fields only), `recordHeartbeat` LWW upsert (`last_seen_at = now()` server clock, identity from the 018 guard context — NEVER the body), the `connectorBearer` heartbeat route. NO per-beat audit row.
- **US3 (T027–T028):** single-instance detail over the shared `getHealth` + view (incl. `reportedFieldsAt`).
- **Polish (T029–T032):** unlabeled `connector_heartbeat_total` counter (3-place register in `api.metrics.ts` + `ALLOWED_METRIC_LABELS` + the cardinality drift list); coverage via the integration/contract/unit suites; this doc.

### Tests — RED→GREEN (Testcontainers, WSL)
- `liveness.spec.ts` — 9/9 (pure, ran anywhere).
- `contract/connector-health.contract.spec.ts` — 15/15 (structural, no Docker).
- `cardinality.spec.ts` (shared allowlist drift) — 53/53; worker-signals — 161/161 (registry edits consistent).
- `read.spec.ts` (US1/US3 + RLS bypass probe) — GREEN.
- `heartbeat.spec.ts` (US2 LWW / convergence / provenance) — GREEN.
- `authz.spec.ts` (controller authz + mass-assignment ban) — 9/9.
- `signals.spec.ts` (heartbeat counter emission) — GREEN.
- **`test/connector-health` suite: 49/49 across 6 suites.**
- `packages/db` `0022-connector-health.spec.ts` round-trip — 12/12; `cli/migrate.spec.ts` full-chain UP/DOWN with 0022 — 10/10.

### Boundary note (🔶 cross-system, deferred)
DP2 makes **NO outbound ERPNext HTTP** anywhere in 020 (arc boundary): heartbeat processing is a single DB upsert; ERPNext-reachability is the connector's self-report only. The live connector→DP2 heartbeat leg is a 🔶 deferred cross-system validation (separate connector repo). Proactive dark-detection / scheduled stale-sweep remains deferred (#523; v1 verdict is read-derived, no worker).

### Perf (T032 — report-only, no perf env)
Heartbeat write = single-row O(1) upsert (UNIQUE conflict target); operator list = bounded per tenant by the number of registrations (small, indexed by `idx_connector_health_tenant`). Report-only, consistent with the 008/009/010/017 precedent.
