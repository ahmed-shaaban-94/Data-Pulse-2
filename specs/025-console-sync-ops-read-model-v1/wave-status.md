# Wave Status — `025-console-sync-ops-read-model-v1`

> Human-readable summary of where the spec stands. 025 is a **read-model /
> projection** for the Retail Tower Console (sibling admin-UI repo) aggregating the
> ERPNext sync-ops surface — 015 posting status, 017 reconciliation, 020 connector
> health, 021 product-master reconciliation — into a console-facing read API.

**Last updated:** 2026-06-08 by Ahmed Shaaban — **CLOSED.** Implementation shipped via
**PR #527 (`a3ccb4a`)**; Phase 6 polish/closeout reconciled on the shared
`feat/wave-020-021-025-impl` impl branch.
**Spec:** `025-console-sync-ops-read-model-v1` (`specs/025-console-sync-ops-read-model-v1/`)
**Base:** `main`.
**Status:** **CLOSED — all 30 tasks complete.** The `[GATED]` console read-model OpenAPI
contract + the `erpnext-sync-ops` api sub-module (read-model service + 3 read verticals)
are on `main`. Read-only, compute-on-read, no persistence, no migration, no write surface.

### What shipped (PR #527 `a3ccb4a`)

- **`[GATED]` contract** `packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml` —
  OpenAPI 3.1, 3 read-only GET operationIds (`consoleGetSyncOpsSummary`,
  `consoleListPostingBacklog`, `consoleListReconciliationRuns`) under
  `/api/v1/catalog/erpnext-sync-ops`, `cookieAuth` (human-only), canonical Error envelope,
  strict (`additionalProperties: false`) wire schemas, NO money/valuation field.
- **`apps/api/src/catalog/erpnext-sync-ops/`** — `erpnext-sync-ops.module.ts` (registered
  in `app.module.ts`), `erpnext-sync-ops.read-model.service.ts` (compute-on-read over the
  015 `erpnext_posting_status` + 017 `erpnext_reconciliation_run`/`_result` tables under
  `runWithTenantContext`, READ-NOT-MIRROR), `erpnext-sync-ops.controller.ts`
  (`DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard`/`@Roles`, `toBody`
  projections, non-disclosing 404 on out-of-scope `store_id`), and the strict Zod
  `dto/sync-ops-query.dto.ts`.
- **Tests** `apps/api/test/catalog/erpnext-sync-ops/` — 4 specs, **42 tests**: contract
  conformance (23), US1 summary (8), US2 posting-backlog (6), US3 reconciliation-runs (5).

### Polish / closeout (Phase 6 — this reconciliation, 2026-06-08)

- **T027 / FR-015 — observability by REUSE (no new metric; `api.metrics.ts` NOT touched).**
  FR-015 forbids a per-feature metrics *file*, not a signal — but a new instrument here
  would be redundant or vacuous: read-model **usage** is already on the shared global
  `http_request_count{route}` + `http_request_duration_seconds{route}` (+ 4xx / validation
  / cross-tenant counters), which fire on the three routes via the global interceptors;
  **source-availability** is static in v1 (020/021 always `not_available`, 015/017 always
  available) and is surfaced by the feature itself via `DomainSummary.status`. 015/017/018
  each *named* a §VII counter; 025 names none (a read path emits no domain event).
  Structured `request_id`/`tenant_id` logs cover the routes. Deliberate, documented.
- **T028 — no-mirror posture VERIFIED.** `git diff origin/main...HEAD` shows 025 adds NO
  migration, NO schema, NO `package.json`/`pnpm-lock` change (SC-007).
- **T029 — coverage + perf.** Suite **42/42 GREEN** (WSL Testcontainers, run-in-band, on
  the shared impl branch). Functional coverage: read-model service **100% lines**, DTO
  **100%**, controller **93.75%** — the only sub-80 file is `erpnext-sync-ops.module.ts`
  (pure DI-decorator wiring, not exercised by `Test.createTestingModule`). **Perf note
  (report-only):** the US2 dead-letter backlog scan
  (`status='permanently_rejected'`) is deliberately **un-indexed** — the only 015 index is
  `WHERE status='pending'` (SC-007); adding one is a gated `packages/db` change SC-007
  forbids. Acceptable at v1 volumes; future `[GATED]` index slice if a backlog grows.
- **T030 — closeout CONFIRMED.** 3 operationIds conform; isolation + non-disclosing-404
  cross-store sweeps green; `not_available` for connector_health (020) + product_master
  (021) asserted in the summary.

### Key resolved design decisions

- **Compute-on-read projection, no persistence, no new authority, no mirror, no write
  surface**; cookieAuth/DashboardAuthGuard **human-only** (rejects `connectorBearer`
  machine + `clerkJwt` POS device + `dashboard_api` bearer). `tenant_id` from the session
  principal, never query/body (§XII; strict Zod DTOs reject smuggled keys → 400).
- Defines the **full four-domain shape** but v1 populates only the buildable **015 + 017**
  domains; **020/021** report `not_available` (forward-compat stub) until those specs are
  *implemented* — populated additively then, no breaking contract change.
- No money/valuation field anywhere (the 015/017 source tables carry none — both
  BUSINESS-class: refs/counts/qty/classes only; the contract banned-field scan enforces it).
  Structured logs carry `request_id`/`tenant_id`.

### Deferrals / blockers — RESOLVED

- **F1 / issue #522 (pin real 015/017 column + enum names) — RESOLVED.** The integration
  tests pass against the real migrated schema, so `rejection_category`, `result_state`,
  `run.summary`, `trigger`, and the `permanently_rejected` status value are validated at
  runtime, not "indicative".
- **F2 (020/021 forward-compat stubs stay `not_available`) — by design.** Those specs are
  built in parallel (this same wave) and not merged; 025 must NOT wire them. A future
  additive slice populates them when 020/021 land.
- **F3 (money pass-through) — vacuously satisfied** (no monetary field on this surface).

### Notes

- No `execution-map.yaml` was authored for 025 (none existed at planning; the spec is a
  single-PR read-model, reconciled via `tasks.md` checkboxes + this file).
- Cross-agent note: verifying the suite on the shared impl branch surfaced that a parallel
  agent (020) had registered `connector_heartbeat_total` in both `api.metrics.ts` and
  `packages/shared/src/observability/metrics-labels.ts` but had not rebuilt the shared
  dist; rebuilding `@data-pulse-2/shared` dist restored the 2 guard-importing suites.
  025 itself touched NO shared registry file.

### Next recommended action

None for 025 — CLOSED. When 020/021 are implemented, dispatch a small additive follow-up
to populate the `connector_health` + `product_master` domains (replacing `not_available`).
