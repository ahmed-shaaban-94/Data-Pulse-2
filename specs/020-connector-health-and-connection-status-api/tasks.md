---
description: "Task list — 020 Connector Health and Connection-Status API"
---

# Tasks: Connector Health and Connection-Status API

**Input**: Design documents from `specs/020-connector-health-and-connection-status-api/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Tests**: REQUIRED (§VI test-first). RED tasks precede their GREEN implementation.

**Organization**: Grouped by user story. P1 (operator read) is the MVP and is independently shippable before P2 (heartbeat) lands — P1 reads a possibly-empty health read-model and returns `never_seen`.

**`[GATED]`**: any task touching `packages/db/**` (schema + migration) or `packages/contracts/openapi/**`. These require explicit gate approval before authoring; the planning chain only describes them.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1 / US2 / US3 (or SETUP / FND / POLISH)

---

## Phase 1: Setup

- [ ] T001 [SETUP] Create the `apps/api/src/connector-health/` module skeleton (`connector-health.module.ts`) wired into the api app module; no routes yet. Confirm 018 guards (`ConnectorAuthGuard`, session-only admin guard, `RolesGuard`, `TenantContextGuard`) are importable from their shipped locations.
- [ ] T002 [P] [SETUP] Add the feature test directory `apps/api/test/connector-health/` and a seed helper modeled on the 017/018 isolation-harness seed (two tenants, each with ≥1 `connector_registration`, one with a controllable `last_seen_at`). Do NOT modify the shared isolation-harness file.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: the gated schema + contract block all story work that touches them. P1 read can begin against the schema once the migration lands.

- [ ] T003 [GATED] [FND] Author the `connector_health` Drizzle schema in `packages/db/src/schema/connector-health.ts` per data-model.md (FK to `connector_registration` ON DELETE CASCADE, UNIQUE on `connector_registration_id`, `tenant_id` NOT NULL, nullable telemetry columns, no `version` column). **Gate approval required before authoring.**
- [ ] T004 [GATED] [FND] Author the migration `packages/db/drizzle/00NN_connector_health.sql` (number confirmed at gate time, expected `0022`): create table + indexes + fail-closed RLS policies (empty-GUC CASE, SELECT/INSERT/UPDATE; no DELETE policy) mirroring `0019`/`0020`/`0021`. Paired DOWN. **Gate approval required.**
- [ ] T005 [GATED] [FND] Migration-allowlist regression: append `00NN` to `EXPECTED_MIGRATIONS` in `cli/migrate.spec`; add the new schema module to the barrel allowlist; ensure `ensureAppRole` is re-called after the migration in the harness. (Hard-CI-break class if skipped — reference-migration-test-gotchas.)
- [ ] T006 [GATED] [FND] Author the `[GATED]` OpenAPI contract `packages/contracts/openapi/erpnext-connector/connector-health.yaml`: `connectorReportHeartbeat` (POST, `connectorBearer`), `listConnectorHealth` (GET, `cookieAuth`), `getConnectorHealth` (GET `/{registrationId}`, `cookieAuth`); `ConnectorHealthView` + `HeartbeatAck` schemas; canonical error envelope; documented error responses. **Gate approval required.**
- [ ] T007 [P] [FND] Implement the pure verdict-derivation helper `connector-health.liveness.ts` (`deriveLiveness(last_seen_at, now, threshold, disabled_at)`) with the documented precedence (disabled → never_seen → healthy → stale) and the 5-minute constant. No DB, no DI — pure function.
- [ ] T008 [P] [FND] RED: unit tests for `deriveLiveness` covering all four verdicts + the strict threshold boundary (`<=` healthy / `>` stale) + disabled-precedence-over-healthy.

**Checkpoint**: schema + migration + contract approved and landed; verdict helper green. Story work can begin.

---

## Phase 3: User Story 1 - Operator reads connector connection status (P1) 🎯 MVP

**Goal**: a tenant_admin (session only) lists + reads connector connection status with a read-derived verdict; no heartbeat needed (returns `never_seen`).

**Independent Test**: seed two registrations (one with `last_seen_at` in-window, one with none), call list with a tenant_admin cookie session, assert verdicts `healthy` + `never_seen`, no secret, cross-tenant invisible, non-admin + `dashboard_api` bearer denied.

### Tests for US1 (RED first)

- [ ] T009 [P] [US1] RED: contract-conformance test for `listConnectorHealth` + `getConnectorHealth` against `connector-health.yaml` (response shape = `ConnectorHealthView`).
- [ ] T010 [P] [US1] RED: integration — list returns each registration with identity + derived verdict + `secondsSinceLastSeen`; empty collection when no registrations; no secret in any field.
- [ ] T011 [P] [US1] RED: authz sweep — non-admin session denied; `dashboard_api` bearer denied (018 session-only); cross-tenant registration returns safe 404 / absent from list; unannotated access fails closed.
- [ ] T012 [P] [US1] RED: RLS bypass probe on `connector_health` (wrong `app.current_tenant` → 0 rows); cross-tenant isolation sweep.

### Implementation for US1

- [ ] T013 [US1] Implement `ConnectorHealthView` wire projection (`dto/connector-health-view.dto.ts`) — `toBody()` joining registration identity + health row + derived verdict; omits health-row `id`, `tenant_id`, all secrets.
- [ ] T014 [US1] Implement `connector-health.service.ts` read methods: `listHealth()` + `getHealth(registrationId)` using `runWithTenantContext` (GUC RLS); left-join `connector_registration` ⟕ `connector_health`; apply `deriveLiveness`; cross-tenant → safe 404.
- [ ] T015 [US1] Implement `connector-health.controller.ts` read routes guarded by the 018 session-only admin guard + `RolesGuard @Roles("owner","tenant_admin")` + `TenantContextGuard`. Default-deny posture.
- [ ] T016 [US1] GREEN: make T009–T012 pass; structured logs + `request_id` on the read path (§VII).

**Checkpoint**: P1 fully functional and independently testable. Shippable MVP.

---

## Phase 4: User Story 2 - Connector reports liveness via heartbeat (P2)

**Goal**: a connector (machine `connectorBearer`) POSTs a heartbeat; DP2 upserts `last_seen_at = now()` + self-reported fields (LWW); operator read flips to `healthy`.

**Independent Test**: with a usable 018 credential, POST a heartbeat → health row upserted with server-clock `last_seen_at`, body identity ignored, self-reported fields stored bounded; disabled/revoked/expired credential → non-disclosing 401, no state change.

### Tests for US2 (RED first)

- [ ] T017 [P] [US2] RED: contract-conformance test for `connectorReportHeartbeat` (request `.strict()`, response `HeartbeatAck`).
- [ ] T018 [P] [US2] RED: integration — usable credential → `last_seen_at = now()` (server clock) on the registration's health row; first beat creates the row, subsequent beats update it.
- [ ] T019 [P] [US2] RED: malicious-override — body with `tenant_id`/`registration_id`/`last_seen_at` is ignored; identity taken from the 018 guard-attached context (§XII).
- [ ] T020 [P] [US2] RED: usability-predicate — disabled-registration / revoked / expired credential → non-disclosing 401, no health row, no last-seen update.
- [ ] T021 [P] [US2] RED: convergence — two concurrent heartbeats → one row, latest `last_seen_at` (LWW); idempotent re-run.
- [ ] T022 [P] [US2] RED: no-outbound-ERPNext guard — assert heartbeat processing makes no outbound HTTP (no ERPNext client in the feature surface).

### Implementation for US2

- [ ] T023 [US2] Implement `dto/connector-heartbeat.dto.ts` — Zod `.strict()` accepting ONLY self-reported fields (`connectorVersion?`, `backlogIndicator?`, `erpnextReachable?`, `sourceClockAt?`); rejects unknown keys and all identity fields.
- [ ] T024 [US2] Implement the heartbeat write in `connector-health.service.ts`: `recordHeartbeat(ctx)` — identity from the guard-attached `{ registrationId, tenantId }`; upsert `ON CONFLICT (connector_registration_id)` setting `last_seen_at = now()`, self-reported fields, `reported_fields_at = now()`; `runWithTenantContext`. LWW, no version check.
- [ ] T025 [US2] Add the heartbeat route to `connector-health.controller.ts` guarded by the 018 `ConnectorAuthGuard` (full usability predicate). Returns `HeartbeatAck`.
- [ ] T026 [US2] GREEN: make T017–T022 pass; `request_id`/`correlation_id` + redacted structured logs; NO per-beat audit row (FR-017 cardinality discipline).

**Checkpoint**: US1 + US2 both work; operator read now reflects live heartbeats.

---

## Phase 5: User Story 3 - Operator inspects single connector health detail (P3)

**Goal**: drill-down detail read over the same read-model. (Largely covered by T014/T015 `getHealth`; this phase hardens the detail-specific projection + tests.)

### Tests for US3 (RED first)

- [ ] T027 [P] [US3] RED: integration — single-instance detail returns identity + verdict + most-recent self-reported fields + `reportedFieldsAt`; cross-tenant → safe 404.

### Implementation for US3

- [ ] T028 [US3] GREEN: confirm/extend `getHealth` detail projection to include the self-reported fields + `reportedFieldsAt`; ensure the detail view shares `ConnectorHealthView` and exposes no secret.

**Checkpoint**: all three stories independently functional.

---

## Phase 6: Observability & Polish

- [ ] T029 [POLISH] Add the unlabeled counter `connector_heartbeat_total` to the shared `apps/api/src/observability/metrics/api.metrics.ts` (3-place register: declare + register + export accessor), mirroring 018 `connector_lifecycle_total`. Increment per accepted heartbeat in the service. NO per-instance/tenant/secret label.
- [ ] T030 [P] [POLISH] Verify ≥80% line coverage for the `connector-health` module; fill gaps (verdict helper, projection, service paths).
- [ ] T031 [P] [POLISH] Update the spec dir docs (wave-status / execution-map if used) + confirm the boundary note: DP2 makes no outbound ERPNext HTTP; the live connector→DP2 leg is a 🔶 deferred cross-system validation (separate connector repo).
- [ ] T032 [POLISH] Report-only perf note (no perf env): heartbeat upsert O(1), operator list bounded per tenant — consistent with 008/009/010 report-only precedent.

---

## Dependencies & Execution Order

- **Setup (T001–T002)**: no deps.
- **Foundational (T003–T008)**: T003→T004→T005 sequential (schema→migration→allowlist); T006 contract independent ([P] with T003-line once gated); T007/T008 pure helper, parallel and gate-independent. **BLOCKS** story work that touches the table/contract.
- **US1 (T009–T016)**: after T004 (table) + T006 (contract) + T007 (helper). The MVP — shippable before US2.
- **US2 (T017–T026)**: after T004 + T006. Independent of US1 at the write layer; shares the read-model.
- **US3 (T027–T028)**: after US1 (reuses `getHealth`).
- **Polish (T029–T032)**: after the stories it measures.

### Parallel opportunities

- T007 + T008 (verdict helper) run parallel to the gated T003–T006.
- All RED test tasks within a story marked [P] run together.
- US1 and US2 can be staffed in parallel once Foundational lands (US1 = read path, US2 = write path, different files).

## Notes

- `[GATED]` tasks (T003–T006) MUST NOT be authored until the gate is explicitly approved; the spec/plan only describe them.
- RED before GREEN within each story (§VI).
- `main` is unprotected — verify `db-integration` manually per PR.
- No worker module in v1 (verdict is read-derived); the scheduled stale-sweep is a named future follow-up.
- Avoid: trusting body identity on the heartbeat; per-beat audit rows; per-instance metric labels; any outbound ERPNext call.
