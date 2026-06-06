# Tasks: Connector Boundary Hardening v1

**Feature**: `018-connector-boundary-hardening` | **Branch**: `feat/018-connector-boundary-hardening`
**Input**: [spec.md](./spec.md) (+ clarifications), [plan.md](./plan.md), [data-model.md](./data-model.md), [research.md](./research.md), [contracts/connector-boundary.md](./contracts/connector-boundary.md)

**Gates**: the two `[GATED]` thresholds (`packages/db` migration `0021`; `packages/contracts` admin OpenAPI iff REST) are **owner-approved 2026-06-06**. They remain explicitly marked and the **preflight stop-on-stray-rows discipline (research R3) still applies at SCHEMA time** — a stray/legacy scope or connector-token row is STOP-and-raise, not auto-normalize.

**Tests**: TDD per Constitution §VI (RED→GREEN). DB-backed specs are WSL Testcontainers (`reference_007_test_env`); `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs.

**Conventions**: `[P]` = parallelizable (different files, no incomplete-task dependency). `[US#]` labels on user-story tasks only.

---

## Phase 1 — Setup

- [ ] T001 Record the `018-SIGNOFF` decisions in [wave-status.md](./wave-status.md): Approach-A identity model, immediate-revoke at-most-one-active rotation, preflight-gated CHECKs, cookieAuth human-only admin surface, gates owner-approved 2026-06-06 (mirror the 015/017 SIGN-OFF section).
- [ ] T002 Create the empty `apps/api/src/connector/connector.module.ts` and register it in `apps/api/src/app.module.ts` (mirror the `erpnext-posting`/`erpnext-reconciliation` module wiring); no routes yet. Verify `pnpm --filter @data-pulse-2/api build` GREEN.

## Phase 2 — Foundational (GATED; block all user stories)

### 2.1 `[GATED]` Schema + migration `0021` (owner-approved)

- [ ] T010 **Preflight** (research R3 + finding GUARD-TIGHTENING-IS-BREAKING-FOR-LEGACY-TOKENS) in `packages/db/__tests__/migration/0021-connector-registration-preflight.spec.ts`: assert the distinct `auth_tokens.scope` values are within the known set AND enumerate **every** existing `scope='connector'` row (per environment). If stray scope values OR **any** pre-existing connector token exists → STOP and report. **This finding gates `018-US4-GUARD`, not just T012's CHECK** — the guard rejects unlinked connector tokens independently of the DB CHECK, so a live connector token would be cut off by US4. Safe remediation if found: backfill a registration → link/reissue → reconfigure the connector, before US4 reaches that environment.
- [ ] T011 [P] [GATED] Add the `connector_registration` Drizzle schema in `packages/db/src/schema/connector_registration.ts` (columns + CHECKs per [data-model.md](./data-model.md): environment enum, non-empty display_name, unique `(tenant_id, environment, erpnext_site_ref)`; fail-closed RLS; no DELETE policy; no money/PII).
- [ ] T012 [GATED] Add `connector_registration_id uuid NULL` FK (RESTRICT) to `packages/db/src/schema/auth_tokens.ts`; add the at-most-one-unrevoked partial-unique `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL`; add the scope enum + connector-token consistency CHECKs **only if T010 preflight is clean** (else carry as a named follow-up).
- [ ] T013 [GATED] Author migration `packages/db/drizzle/0021_connector_registration.sql` + paired `0021_connector_registration.down.sql` (UP→DOWN→UP clean); re-call `ensureAppRole` after the migration in its spec.
- [ ] T014 Update `packages/db/src/schema/index.ts` barrel re-export AND append `0021` to `cli/migrate.spec` `EXPECTED_MIGRATIONS` + the new module to the schema barrel allowlist (the #447/#487-class two-allowlist regression).
- [ ] T015 [P] Migration round-trip spec `packages/db/__tests__/migration/0021-connector-registration.spec.ts` (WSL Testcontainers): table + FK + CHECKs + partial-unique created; UP→DOWN→UP clean.
- [ ] T016 [P] Docker-free schema-shape spec `apps/api/test/connector/schema/connector-registration-schema-shape.spec.ts` (Drizzle introspection).

### 2.2 `[GATED]` Boundary contract + admin contract (owner-approved)

- [ ] T020 [P] [GATED] Finalize the boundary-of-record doc `specs/018-connector-boundary-hardening/contracts/connector-boundary.md` (already drafted) — confirm it documents the existing 012 feed/ack rules (auth/idempotency/replay/error/non-disclosure) + the A–E ownership table, without redesigning `posting-feed.yaml` (FR-023/024).
- [ ] T021 [GATED] **Decision point (research R6)**: choose REST admin OpenAPI vs CLI/seed for the admin surface. If REST → author `packages/contracts/openapi/connector/connector-admin.yaml` (cookieAuth; register/list/disable + issue/rotate/revoke; raw secret returned once on issue/rotate only; canonical error envelope; strict bodies) + its conformance spec `apps/api/test/connector/contract/connector-admin.contract.spec.ts`. If CLI → document the operator-tool contract in the boundary doc and skip the OpenAPI.

### 2.3 Isolation harness (blocking — serves the user stories)

- [ ] T030 Add the connector seed helper `apps/api/test/connector/__support__/seed-connector.ts` (registrations + credentials via the admin pool; mirror `seed-posting-status.ts`; do NOT touch the 003-owned isolation-harness.ts) + the RLS sweep `apps/api/test/connector/isolation/connector-sweep.spec.ts` (wrong `app.current_tenant` → 0 rows; cross-tenant registration invisible; INSERT denied on empty GUC).

## Phase 3 — User Story 1: Register an instance + issue first credential (P1) 🎯 MVP

**Goal**: a Tenant Admin registers a connector instance and issues its first usable credential (raw secret shown once).
**Independent test**: register → issue → a test client authenticates on the connector feed with the raw secret; the secret never reappears in any list/get/log.

- [ ] T040 [US1] RED: write `apps/api/test/connector/registration/register-and-issue.spec.ts` (WSL Testcontainers) — register (strict DTO, mass-assignment ban §XII), duplicate `(env, site_ref)` → clear error (FR-005a), issue returns raw secret once, list/get never expose secret/hash; bounded expiry default 90d (FR-012). **Authorization (FR-005b): a non-admin authenticated principal AND a `dashboard_api` bearer are DENIED (default-deny → 404) on register/list/issue; only owner/tenant_admin succeed** — cover both the negative and positive role cases.
- [ ] T041 [US1] Add strict DTOs `apps/api/src/connector/dto/register-connector.dto.ts` + `issue-credential.dto.ts` + the response wire shapes (`toBody` projections — no raw row, no hash, §IV).
- [ ] T042 [US1] Implement `apps/api/src/connector/connector-credential.repository.ts` (connector-only credential writes/lookups; raw secret hashed via the existing opaque-bearer path; expiry default 90d + ceiling).
- [ ] T043 [US1] Implement register + issue in `apps/api/src/connector/connector-registration.service.ts` (runWithTenantContext; in-tx audit `connector.registration.created` / `connector.credential.issued`; lifecycle counter).
- [ ] T044 [US1] Wire the admin routes (`register` / `list` / `issue`) in `apps/api/src/connector/connector-registration.controller.ts` behind **`DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` with `@Roles("owner","tenant_admin")`** (the 014/017 controller precedent; default-deny → 404; cookieAuth; tenant from session, never body — §XII / FR-005b). `DashboardAuthGuard` alone is INSUFFICIENT — credential issuance is privileged. GREEN.

## Phase 4 — User Story 4: Enforce only connector credentials reach connector endpoints (P1)

**Goal**: the connector posting endpoints accept only an active, instance-linked, non-disabled connector credential; everything else → non-disclosing 401; the calling instance is identified.
**Independent test**: present each disallowed credential/condition → identical non-disclosing 401; a valid one → accepted + instance identified; dashboard/POS unaffected.

> US4 is P1 (security backbone) but depends on the schema (link) + at least one issued credential (US1) to test against. Sequenced after US1; both are MVP-critical.

- [ ] T050 [US4] RED: `apps/api/test/connector/guard/connector-auth-guard.spec.ts` — the full usability predicate (data-model §Usability): expired/revoked/unlinked/disabled-instance/cross-tenant/human-session/POS all → identical non-disclosing 401; valid → allow + `request.connector` identity attached.
- [ ] T051 [US4] Add `findActiveConnectorCredentialByRawToken` (connector-only path) in `apps/api/src/auth/auth-token.repository.ts` — does NOT alter the generic dashboard/POS lookup.
- [ ] T052 [US4] Tighten `apps/api/src/auth/connector-auth.guard.ts`: resolve the registration link + full predicate, attach `{ registrationId, tenantId, environment }`, non-disclosing 401 on any failure (FR-015/016/017/018).
- [ ] T053 [US4] Regression: assert dashboard + POS auth behavior unchanged (FR-019) via the existing auth guard specs (extend, don't rewrite). GREEN.

## Phase 5 — User Story 2: Rotate + revoke a credential safely (P2)

**Goal**: atomic immediate-revoke rotation (at-most-one-active); revoke one credential leaving identity intact.
**Independent test**: rotate → old rejected next call, new accepted, never two valid; issue-fail → rollback, old stays; revoke → rejected, registration stays; concurrent rotate → one active.

- [ ] T060 [US2] RED: `apps/api/test/connector/lifecycle/rotate-revoke.spec.ts` — atomic rotate (old revoked + new issued in one tx), rollback-on-issue-failure leaves old active, raw secret once, revoke one credential, concurrent rotation → exactly one active (partial-unique serializes).
- [ ] T061 [US2] Implement rotate + revoke in `apps/api/src/connector/connector-registration.service.ts` (one transaction: verify registration not-disabled → revoke unrevoked connector creds → insert new → in-tx audit `connector.credential.rotated` / `.revoked` + counter).
- [ ] T062 [US2] Wire the `rotate` / `revoke` routes in the controller (same `DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` `@Roles("owner","tenant_admin")` gate as US1; `@Idempotent('required')` on rotate — reuse the existing interceptor, no new primitive). GREEN.

## Phase 6 — User Story 3: Disable a connector instance (P2)

**Goal**: logical disable of a whole instance makes all its credentials unusable at the guard, without deleting rows.
**Independent test**: disable → credential rejected next call; instance + credential rows still present.

- [ ] T070 [US3] RED: `apps/api/test/connector/lifecycle/disable-instance.spec.ts` — disable sets `disabled_at`/`disabled_by`; the linked credential is rejected (predicate clause 7); no rows deleted (FR-014); idempotent re-disable.
- [ ] T071 [US3] Implement `disable` in the service (set disabled_at/by; in-tx audit `connector.registration.disabled` + counter; issuing a credential for a disabled instance is rejected). Wire the `disable` route behind the same `DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` `@Roles("owner","tenant_admin")` gate (FR-005b). GREEN.

## Phase 7 — User Story 5: Boundary-of-record doc (P3)

**Goal**: a reader can determine auth/replay rules + future-surface ownership from the doc alone.
**Independent test**: a reader states how a connector authenticates, what a replayed ack does, and which spec owns 019 vs 020 — from the doc.

- [ ] T080 [US5] Finalize + cross-link `contracts/connector-boundary.md` (T020 drafted it): confirm the 012 rules + A–E table; cross-link from the 017 wave-status that **019 = `017-STOCK-VIEW-CONTRACT`**.

## Phase 8 — Polish & cross-cutting

- [ ] T090 [P] Register the unlabeled `connector_lifecycle_total` counter in the shared `apps/api/src/observability/metrics/api.metrics.ts` (3-place register) + append to `ALLOWED_METRIC_LABELS` cardinality drift list (lockstep); assert no per-instance/tenant/secret label (FR-022a, SC-011) via `apps/api/test/connector/observability/signals.spec.ts`.
- [ ] T091 [P] Coverage ≥80% for the connector module (`pnpm --filter @data-pulse-2/api test -- connector --coverage`); raw secret never in any log/response except the one issue/rotate body (SC-002/007).
- [ ] T092 Reconcile [execution-map.yaml](./execution-map.yaml) + [wave-status.md](./wave-status.md) to terminal; CLAUDE.md Active-feature note updated (done in plan); closeout.

---

## Dependencies & order

- **Setup (T001–T002)** → **Foundational (T010–T030)** blocks all user stories.
- **T010 preflight** gates T012's CHECKs (STOP on stray rows).
- **US1 (T040–T044)** 🎯 MVP → then **US4 (T050–T053)** (needs an issued credential to enforce against) → **US2 (T060–T062)** → **US3 (T070–T071)** → **US5 (T080)** → **Polish (T090–T092)**.
- US1–US3 share `connector-registration.service.ts`/`.controller.ts` → serialize through them (US1 first).

## Parallel opportunities

- T011 ‖ T015 ‖ T016 (schema vs round-trip vs shape — distinct files, after T010/T013 ordering for the migration pair).
- T020 ‖ the schema slice (contracts vs db — disjoint, the 015/017 GATED-pair precedent).
- T090 ‖ T091 (metrics vs coverage — distinct files).

## Implementation strategy

**MVP = US1 (register + issue) + US4 (guard enforcement)** — together they make a connector provisionable AND the boundary provably tight. US2/US3 complete safe operation; US5 is the documented boundary. Ship US1+US4 first as the demonstrable, independently-testable core.

## Task count

23 tasks: Setup 2, Foundational 10 (incl. 2 GATED slices + preflight + isolation), US1 5, US4 4, US2 3, US3 2, US5 1, Polish 3 — minus overlap. All gated tasks owner-approved; preflight discipline applies.
