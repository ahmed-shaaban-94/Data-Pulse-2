# Tasks: Platform Production Readiness

**Feature ID**: 004
**Feature name**: Platform Production Readiness
**Source artifacts**:
- [spec.md](./spec.md) (clarified 2026-05-16)
- [plan.md](./plan.md)
- [research.md](./research.md)
- [checklists/requirements.md](./checklists/requirements.md)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md)) — every task respects principles §II, §III, §V, §VII, §VIII, §XI, §XII, §XIII, §XIV
**Status**: Draft — planning artifact only; **NO implementation in this task list**
**Created**: 2026-05-16
**Owner**: Ahmed Shaaban
**Parallel-safe with**: 003-catalog-foundation

> **PLANNING-ONLY NOTE**: This `tasks.md` is a **planning artifact**, not an
> implementation roster. **Listing a task here is not approval to execute it.**
> Every task that touches production source code (`apps/**`, `packages/**`),
> package files (`package.json`, `pnpm-lock.yaml`), DB schema, SQL migrations,
> OpenAPI contracts under `packages/contracts/openapi/`, CI workflows, or any
> generated file is marked **`[GATED]`** and requires an explicit, separate
> approval PR per `plan.md §5`. Reviewers MUST reject any PR that executes a
> `[GATED]` task without that approval recorded in the PR description.

---

## 1. Header

### 1.1 Constitution alignment
Every track operationalizes one or more Core Principles:

| Principle | Tracks that operationalize it |
|---|---|
| §II Multi-Tenant SaaS by Default | A (cross-tenant load), B (cross-tenant rejection signal, RLS-context-failure signal), C (workers establish tenant ctx before DB), D (per-tenant key scoping, `425` MUST NOT leak cross-tenant info) |
| §III Backend Authority & Data Integrity | D (HTTP-layer retry safety), C (durable event emission), B (uniform error envelope preservation) |
| §V Async Work Belongs in Workers | C (outbox drainer is a worker; consumers establish tenant ctx), B (queue/worker signals) |
| §VII Observable Systems | B (the operationalization), C (drainer signals), D (idempotency counters) |
| §VIII Reproducible & Versioned Releases | All `[GATED]` tasks enforce this |
| §XI Idempotency & External IDs | D (HTTP-layer); C (consumer idempotency, `event_id` as dedup key) |
| §XII Authorization & Object Safety | D (replay preserves *original* authorization decision, not retrier's) |
| §XIII Auditability & Provenance | C (first event = `audit.event.created`); B (`correlation_id` end-to-end) |
| §XIV PII & Data Lifecycle Discipline | B (redaction matrix as single source of truth), C (90d/365d retention defers to right-to-erasure) |

### 1.2 Planning-only note
This task list MUST NOT be interpreted as authorization to write runtime
code, migrations, contracts, or CI changes. Each implementation phase
opens with a documentation slice; only after that slice merges may any
`[GATED]` task be sequenced into a real PR — and even then, only with the
gate-clearing approval recorded.

### 1.3 Tasks are not implementation approval
Reviewer obligation (spec §5.4, plan §5):
- A PR that executes a `[GATED]` task without an approval reference fails
  review regardless of code quality.
- A PR that introduces catalog implementation, POS implementation,
  dashboard UI, billing, reports, analytics, dbt, ClickHouse, Dagster, or
  deployment infrastructure under cover of a 004 task fails review.
- A PR that bundles multiple `[GATED]` tasks across tracks fails review —
  one slice at a time per `plan.md §8`.

---

## 2. Dependency graph

The recommended execution order is the rollout sequence from `plan.md §8`,
expanded across nine phases:

```
P1  Planning closeout (this tasks.md PR)
       │
       ▼
P2  Track A — k6 first slice (loadtests/k6/, no package changes)
       │
       ▼  [P2 and P3 may proceed in parallel — different files, different tracks]
P3  Track B docs — redaction matrix + signal catalogue
       │
       ▼
P4  Track B instrumentation [GATED]
       │
       ▼  [P5 may overlap with P6; both depend on P3 for redaction policy]
P5  Track D idempotency design + first endpoint [GATED on source/contract]
       │
       ▼
P6  Track C outbox design validation (docs + spike on a branch, no migration merged)
       │
       ▼
P7  Track C outbox first slice [GATED — schema, migration, drainer worker]
       │
       ▼
P8  Track E SDK research close-out + downstream-repo handoff (no in-repo code)
       │
       ▼
P9  Cross-track validation (parallelism with 003 preserved; no scope creep)
```

Within phases, parallel opportunities are marked **`[P]`** when tasks
touch different files and have no shared dependency.

---

## 3. Task format

```
- [ ] T### [P{phase}] [Track {X}] [P? parallel] [GATED?] Description with concrete file path when known
```

- `T###` — three-digit task ID (T400 onward, non-overlapping with 001/002/003).
- `[P{phase}]` — phase number from §2 (`P1`..`P9`).
- `[Track {X}]` — Track letter (A/B/C/D/E) when applicable; omitted for cross-track tasks.
- `[P]` — parallelizable with other tasks in the same phase that touch different files.
- **`[GATED]`** — requires separate approval PR; touches `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, DB schema, SQL migration, OpenAPI contracts, CI workflows, generated files, or constitution-adjacent artifacts.

---

## 4. Phase 1 — Planning closeout

> Scope: verify spec/plan/research/checklist consistency before any
> implementation phase opens. No production change.

- [ ] **T400** [P1] Verify `specs/004-platform-production-readiness/spec.md`, `plan.md`, `research.md`, and `checklists/requirements.md` are all present and cross-referenced — file existence + internal links resolve.
- [ ] **T401** [P1] [P] Confirm spec contains **zero active** `[NEEDS CLARIFICATION:` markers (3 resolved in §1.5, none remaining) — verified by grep against `specs/004-platform-production-readiness/spec.md`.
- [ ] **T402** [P1] [P] Confirm plan contains zero active markers — verified by grep against `specs/004-platform-production-readiness/plan.md`.
- [ ] **T403** [P1] [P] Confirm research contains zero active markers — verified by grep against `specs/004-platform-production-readiness/research.md`.
- [ ] **T404** [P1] Confirm `.specify/feature.json` points at `specs/004-platform-production-readiness`.
- [ ] **T405** [P1] Confirm checklist `requirements.md` items are all checked; iteration log records the 2026-05-16 clarification integration.
- [ ] **T406** [P1] Confirm constitution alignment: each Core Principle in `.specify/memory/constitution.md` is referenced at least once in plan §9.
- [ ] **T407** [P1] Verify the three locked decisions (Q1 `425 Too Early`, Q2 90d/365d outbox retention, Q3 `openapi-typescript`+`openapi-fetch`/no `packages/sdk`) appear in:
  - `spec.md §1.5` (clarifications section)
  - `plan.md §3.3.4 / §3.4 / §3.5.1`
  - `research.md §2 / §3 / §5`
  - `tasks.md §6.6 / §7.3 / §8.3` (this file)
- [ ] **T408** [P1] Verify gating table in `plan.md §5` covers every forbidden-path class enumerated in spec §3.1.
- [ ] **T409** [P1] Verify §5 reviewer obligation (parallelism with 003) appears in spec, plan, and tasks.
- [ ] **T410** [P1] Confirm planning PR diff scope: `git status --short` shows only `.specify/feature.json` and `specs/004-platform-production-readiness/**` — no `apps/**`, no `packages/**`, no `package.json`, no `pnpm-lock.yaml`, no migrations, no OpenAPI, no CI, no generated files.

**Exit gate for P1**: T400–T410 all checked. Only then may P2 open.

---

## 5. Phase 2 — Track A k6 load testing (first safe slice)

> Scope: k6 scripts under `loadtests/k6/`, external Docker/CLI execution,
> **no `package.json` change**, **no CI wiring**, **no `apps/**` /
> `packages/**` change**, foundation endpoints only (no catalog).

### 5.1 Documentation tasks (slice 2)

- [ ] **T420** [P2] [Track A] Create `loadtests/k6/README.md` documenting: execution mode (Docker image `grafana/k6:0.50.0` recommended; bare CLI fallback), synthetic-tenant assumptions (`tenant-load-A/B/C`), environment boundaries (non-prod only; production forbidden per FR-A-007), result artifact format (JSON), and pass/fail gating rules for smoke/baseline/stress/regression.
- [ ] **T421** [P2] [Track A] [P] In `loadtests/k6/README.md`, document the six candidate first-slice flows from plan §3.1.3 with their expected RPS bands and which Track B signals operators MUST observe alongside each run.
- [ ] **T422** [P2] [Track A] [P] In `loadtests/k6/README.md`, document required success measures (p50/p95/p99 latency; 4xx/5xx rate; RPS sustained + peak; DB pool / slow-query / rollback; Redis p50/p95; BullMQ queue lag; worker job duration p50/p95) and where each is reported (k6 = HTTP; Track B = everything else).
- [ ] **T423** [P2] [Track A] [P] In `loadtests/k6/README.md`, document the synthetic data fixture contract: number of tenants (≥3), stores per tenant (2/8/50 profiles), membership counts, pre-provisioned test tokens, and rebuild cadence (recommendation: weekly).
- [ ] **T424** [P2] [Track A] [P] In `loadtests/k6/README.md`, document regression delta budget per research §1 — `+10% p95 / +20% p99 / +0.5pp error rate` — and how regression runs compare against the stored prior baseline JSON.

### 5.2 Script tasks (slice 2, future PR)

These tasks create JS files **outside `apps/**` and `packages/**`**. They
introduce **zero** `package.json` changes. Operators run via Docker image.

- [ ] **T425** [P2] [Track A] Author `loadtests/k6/smoke.js` — one auth + tenant-context flow at minimal RPS (~5 RPS for 30s); must complete without errors; no latency gating.
- [ ] **T426** [P2] [Track A] Author `loadtests/k6/baseline.js` — all six candidate flows (auth login, auth refresh, GET `/v1/tenants/me`, GET `/v1/memberships`, membership invite+accept, role grant/revoke) at expected production load for 5–15 min; emits p95/p99/error-rate thresholds defined per release.
- [ ] **T427** [P2] [Track A] Author `loadtests/k6/stress.js` — same six flows ramped to breakpoint; on-demand only; produces a breakpoint report, not a release gate.
- [ ] **T428** [P2] [Track A] Author `loadtests/k6/regression.js` — replays baseline against a stored prior baseline JSON; fails if any tracked metric exceeds the regression delta budget from T424.
- [ ] **T429** [P2] [Track A] Author `loadtests/k6/lib/auth.js` — shared helper that exchanges synthetic-tenant credentials for tokens via the real `POST /v1/auth/login` path; MUST NOT bypass `AuthGuard`, `TenantContextGuard`, or `RolesGuard` (FR-A-010).
- [ ] **T430** [P2] [Track A] Author `loadtests/k6/lib/tenants.js` — shared helper that establishes tenant/store context for a synthetic tenant; exercises ≥3 concurrent tenants per run (FR-A-009).
- [ ] **T431** [P2] [Track A] Author `loadtests/k6/fixtures/synthetic-tenants.md` — documentation-only description of expected tenant/store/member row counts for the load env; **no fixture data files in this repo** (operator-side concern).

### 5.3 Validation tasks (slice 2 close-out)

- [ ] **T432** [P2] [Track A] Validate: no new entry in `package.json`. Run `git diff package.json` → empty.
- [ ] **T433** [P2] [Track A] Validate: no new entry in `pnpm-lock.yaml`. Run `git diff pnpm-lock.yaml` → empty.
- [ ] **T434** [P2] [Track A] Validate: no `loadtests/k6/**` file requires `npm install` to run — scripts are valid k6 ES modules consumed directly by the k6 runtime.
- [ ] **T435** [P2] [Track A] Validate: no file under `apps/**` or `packages/**` is changed by this slice. `git diff apps/ packages/` → empty.
- [ ] **T436** [P2] [Track A] Validate: no CI workflow added or changed. `git diff .github/workflows/` → empty.
- [ ] **T437** [P2] [Track A] Smoke-run validation: `docker run --rm -v "$PWD/loadtests/k6:/scripts" grafana/k6:0.50.0 run /scripts/smoke.js --vus 1 --duration 5s` against a local dev env completes without errors (operator-side validation).

**Exit gate for P2**: T420–T437 complete; all validation tasks green.

---

## 6. Phase 3 — Track B observability docs (no instrumentation)

> Scope: redaction matrix and signal catalogue **as documentation only**.
> NO runtime instrumentation in this phase. May proceed in parallel with
> Phase 2.

### 6.1 Redaction matrix

- [ ] **T440** [P3] [Track B] [GATED] Author `.specify/memory/redaction-matrix.md` using the existing `.specify/templates/redaction-matrix-template.md` template. (Gated because it lives in `.specify/memory/` — constitution-adjacent; requires explicit approval per plan §5.) Matrix MUST be add-only by default (FR-B-005) and MUST be referenced from every track that emits logs.
- [ ] **T441** [P3] [Track B] In `.specify/memory/redaction-matrix.md`, enumerate the redaction classes from spec §7.6: passwords (raw/hashed), bearer tokens, API keys, session cookies, refresh tokens, DB/Redis/queue credentials, webhook signing keys, PII (email, phone, address, name fields), full request bodies, full response bodies.
- [ ] **T442** [P3] [Track B] In `.specify/memory/redaction-matrix.md`, document the boundary rule (FR-B-005, §7.6): redaction happens at the logger boundary, not at call sites. Add-only by default.
- [ ] **T443** [P3] [Track B] In `.specify/memory/redaction-matrix.md`, embed a changelog block at the top so policy changes are auditable inline (matches the constitution's pattern).

### 6.2 Signal catalogue

- [ ] **T444** [P3] [Track B] [P] Create `docs/observability/signals.md` enumerating all API signals from plan §3.2.1: `http_request_count`, `http_request_duration_seconds`, `http_error_4xx_total`, `http_error_5xx_total`, `auth_failure_total` (labeled by `cause`), `tenant_context_failure_total`, `validation_failure_total`, `suspicious_login_total`, `cross_tenant_rejection_total`, plus Track D's `idempotency_replay_total`, `idempotency_conflict_total`, `idempotency_in_progress_total`. Define type (counter/histogram), permitted labels, and OTel-native names.
- [ ] **T445** [P3] [Track B] [P] In `docs/observability/signals.md`, enumerate DB signals from plan §3.2.1: `db_pool_in_use`, `db_pool_waiters`, `db_slow_query_total` (labeled by `query_class`, no values), `db_rls_context_failure_total` (no per-tenant labels — alertable), `db_migration_status` (labeled by `state`).
- [ ] **T446** [P3] [Track B] [P] In `docs/observability/signals.md`, enumerate Redis / BullMQ / worker signals from plan §3.2.1: `redis_command_duration_seconds`, `queue_lag_seconds`, `queue_failed_total`, `queue_dead_letter_total`, `queue_retry_total`, `worker_job_duration_seconds`, `worker_processing_failure_total`. Add Track C signals: `outbox_pending_total`, `outbox_dead_letter_total`, `outbox_drain_duration_seconds`.
- [ ] **T447** [P3] [Track B] [P] In `docs/observability/signals.md`, document the cardinality rule (FR-B-006, §7.7): `tenant_id`, `store_id`, `user_id`, `actor_id` are NEVER metric labels. Add a "Rejected labels" list with rationale.
- [ ] **T448** [P3] [Track B] [P] In `docs/observability/signals.md`, document the structured-log field requirements (FR-B-004): `request_id`, `tenant_id` (when established), `store_id` (when established), `actor_id` (when authenticated), `correlation_id` (for async work).
- [ ] **T449** [P3] [Track B] [P] In `docs/observability/signals.md`, document the slow-query threshold (research §4 recommendation: **500ms** default; alert at sustained > 5/min over 5-min window).
- [ ] **T450** [P3] [Track B] [P] Create `docs/observability/dashboards/README.md` placeholder documenting the future dashboards-as-code policy: lives in a separate `ops/` repo, not in this monorepo; no dashboards generated in this PR.
- [ ] **T451** [P3] [Track B] [P] Create `docs/observability/alerts/README.md` placeholder documenting future alert rules: live alongside dashboards in the `ops/` repo; no alerts generated in this PR.

### 6.3 Validation

- [ ] **T452** [P3] [Track B] Validate: no change under `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, migrations, or CI. `git diff` against those paths is empty.
- [ ] **T453** [P3] [Track B] Validate: signal names in `docs/observability/signals.md` match the names referenced in plan §3.2.1 and spec §7.3–§7.5 — drift check.
- [ ] **T454** [P3] [Track B] Validate: redaction matrix references every redaction constraint from spec §7.6.

**Exit gate for P3**: T440–T454 complete. Track B docs are the single
source of truth before any instrumentation slice opens.

---

## 7. Phase 4 — Track B observability instrumentation (FUTURE SLICE)

> **All tasks in this phase are `[GATED]`.** They touch `apps/api/**`
> and `apps/worker/**` — explicit approval required per plan §5. Do not
> execute until P3 ships and instrumentation slice is approved.

### 7.1 Test tasks (test-first per Constitution §VI)

- [ ] **T460** [P4] [Track B] [GATED] Author signal-presence integration test in `apps/api/test/observability/signal-presence.spec.ts`: assert each API metric from `docs/observability/signals.md` is exposed when the API serves traffic.
- [ ] **T461** [P4] [Track B] [GATED] Author cardinality test in `apps/api/test/observability/cardinality.spec.ts`: a static check (script + Prometheus metadata) asserts no signal has `tenant_id` / `store_id` / `user_id` / `actor_id` labels.
- [ ] **T462** [P4] [Track B] [GATED] Author redaction test in `apps/api/test/observability/redaction.spec.ts`: a fixture endpoint emits a body containing `pii-canary@example.test`; assert the canary never appears in pino output or metric labels.
- [ ] **T463** [P4] [Track B] [GATED] Author RLS-context-failure signal test in `apps/api/test/observability/rls-context-failure.spec.ts`: craft a DB call without tenant context (Testcontainer DB), assert `db_rls_context_failure_total` increments and a WARN/ERROR log entry exists with redaction honored.
- [ ] **T464** [P4] [Track B] [GATED] Author cross-tenant rejection signal test in `apps/api/test/observability/cross-tenant-rejection.spec.ts`: extend the 001 RLS bypass probe; assert `cross_tenant_rejection_total` increments on attempted cross-tenant access.
- [ ] **T465** [P4] [Track B] [GATED] Author worker signal-presence test in `apps/worker/test/observability/worker-signals.spec.ts`: assert `queue_lag_seconds`, `worker_job_duration_seconds`, `queue_retry_total`, `queue_dead_letter_total` are exposed.
- [ ] **T466** [P4] [Track B] [GATED] Author auth-failure-by-cause test in `apps/api/test/observability/auth-failure.spec.ts`: assert `auth_failure_total` labeled by `cause` (`bad_password`, `bad_token`, `expired`, `missing`, `rate_limited`) increments correctly.

### 7.2 Instrumentation tasks (only after tests RED)

- [ ] **T470** [P4] [Track B] [GATED] Register API metric definitions in the existing interceptor chain under `apps/api/src/observability/metrics/api.metrics.ts` — one file per metric family; no new exporter, OTel SDK reuse from 001.
- [ ] **T471** [P4] [Track B] [GATED] Register DB metric definitions in `apps/api/src/observability/metrics/db.metrics.ts`; wire to Drizzle / pool instrumentation hooks.
- [ ] **T472** [P4] [Track B] [GATED] Register Redis / BullMQ / worker metric definitions in `apps/worker/src/observability/metrics/worker.metrics.ts`.
- [ ] **T473** [P4] [Track B] [GATED] Wire the redaction matrix from T440 into the pino transport at the logger boundary (`apps/api/src/observability/logger.ts` and worker equivalent); reject call-site redaction patterns at review (FR-B-005).
- [ ] **T474** [P4] [Track B] [GATED] Add structured-log fields (`request_id`, `tenant_id`, `store_id`, `actor_id`, `correlation_id`) to the pino logger config; verify via T462 test.
- [ ] **T475** [P4] [Track B] [GATED] Emit `cross_tenant_rejection_total` from the existing `TenantContextGuard` rejection path.
- [ ] **T476** [P4] [Track B] [GATED] Emit `db_rls_context_failure_total` from a low-level DB instrumentation hook (Drizzle middleware or pool listener).

### 7.3 Validation

- [ ] **T480** [P4] [Track B] [GATED] Validate: all P4 tests (T460–T466) pass GREEN.
- [ ] **T481** [P4] [Track B] [GATED] Validate: cross-tenant + cross-store sweep tests from 001 still pass — no regressions.
- [ ] **T482** [P4] [Track B] [GATED] Validate: no `package.json` change unless a pino transport plugin was approved separately (also `[GATED]`).
- [ ] **T483** [P4] [Track B] [GATED] Operator validation: a real local dev run scrapes `/metrics` and shows every signal from `docs/observability/signals.md`.

**Exit gate for P4**: T460–T483 complete with reviewer-recorded approval
of the instrumentation PR. P5 may proceed independently before, in
parallel with, or after P4.

---

## 8. Phase 5 — Track D idempotency design + first endpoint (FUTURE SLICE)

> **All implementation tasks are `[GATED]`.** Builds on the existing
> `packages/shared/src/idempotency/store.ts::IdempotencyKeyStore`. First
> endpoint: **`POST /v1/memberships/invitations`**. Rollout is narrow —
> **NEVER global** (FR-D-007, plan §3.4.5). May overlap with P4.

### 8.1 Design / documentation tasks

- [ ] **T500** [P5] [Track D] Author `docs/idempotency/strategy.md` covering: scope of HTTP idempotency (spec §9.2), `Idempotency-Key` header semantics, methods in scope (POST, PATCH, narrow DELETE), the `(tenantId, route, clientId, key)` dedup tuple (plan §3.4.6), per-endpoint OpenAPI policy contract, and observability emission (replay / 409 conflict / 425 in-progress counters).
- [ ] **T501** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, document the `425 Too Early` response (Q1, spec §1.5): non-blocking, no cross-tenant/cross-store leak, retryable. Reference the uniform error envelope (Constitution §III). Include the `Retry-After`-style header recommendation from research §3 (remaining marker TTL or 2s clamped).
- [ ] **T502** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, document the in-progress marker design (research §3): Redis `SET NX EX 60` default TTL, per-endpoint override, atomic creation, best-effort cleanup on response.
- [ ] **T503** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, document the replay retention window (research §2 recommendation: **72 hours**) and how it relates to the existing 24h default in `IdempotencyKeyStore`.
- [ ] **T504** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, confirm first-endpoint selection: **`POST /v1/memberships/invitations`**, with rationale per research §2 (retry-safe by design, low blast radius, audit-emitting code path validates no double-emission, no POS dependency).
- [ ] **T505** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, document the per-method decorator API design (research §10): `@Idempotent('required'|'optional', { replayTtlSec?, inflightTtlSec? })`; opt-in only; no global registration.
- [ ] **T506** [P5] [Track D] [P] In `docs/idempotency/strategy.md`, document client-side retry guidance: 425 is retryable, 409 is terminal (payload mismatch is a client bug), expired key behaves as new request, missing key follows per-endpoint OpenAPI policy.

### 8.2 Test tasks (test-first, RED before implementation)

- [ ] **T510** [P5] [Track D] [GATED] Author replay test in `apps/api/test/idempotency/replay.spec.ts`: same `(tenant, route, clientId, key)` + same body → identical response status + body; no second side effect (verified via DB state assertion).
- [ ] **T511** [P5] [Track D] [GATED] Author payload-mismatch test in `apps/api/test/idempotency/conflict.spec.ts`: same key, different body → `409 Conflict`; original mutation preserved.
- [ ] **T512** [P5] [Track D] [GATED] Author in-progress test in `apps/api/test/idempotency/in-progress.spec.ts`: parallel duplicate request while original is in flight → `425 Too Early`; response body MUST NOT leak original-request data; retry after original completes → replay.
- [ ] **T513** [P5] [Track D] [GATED] Author cross-tenant isolation test in `apps/api/test/idempotency/cross-tenant.spec.ts`: tenant A + key X + tenant B + key X on same route → both processed independently; no replay; verifies FR-D-002.
- [ ] **T514** [P5] [Track D] [GATED] Author marker-TTL test in `apps/api/test/idempotency/marker-ttl.spec.ts`: in-progress marker expires after 60s; next retry after expiry behaves correctly (replays if original completed; treated as new if original failed).
- [ ] **T515** [P5] [Track D] [GATED] Author expiry test in `apps/api/test/idempotency/expiry.spec.ts`: key past 72h replay window → treated as new request; original response no longer replayed.
- [ ] **T516** [P5] [Track D] [GATED] Author missing-header policy test in `apps/api/test/idempotency/missing-header.spec.ts`: per-endpoint OpenAPI declaration honored — 400 if `required` and missing; pass-through if `optional`.
- [ ] **T517** [P5] [Track D] [GATED] Author observability test in `apps/api/test/idempotency/signals.spec.ts`: replay / 409 conflict / 425 in-progress counters increment per Track B signal catalogue (FR-D-010).
- [ ] **T518** [P5] [Track D] [GATED] Author authorization-preservation test in `apps/api/test/idempotency/authorization.spec.ts`: replay preserves the *original* `actor_id` in the response; replay MUST NOT inherit the retrier's authorization (FR-D-009).

### 8.3 Implementation tasks (only after tests RED)

- [ ] **T520** [P5] [Track D] [GATED] Author NestJS interceptor `apps/api/src/idempotency/idempotency.interceptor.ts` implementing the flow from plan §3.4.3 (route check → header check → fingerprint → in-progress marker → store lookup → handler → save).
- [ ] **T521** [P5] [Track D] [GATED] Author `@Idempotent(...)` decorator at `apps/api/src/idempotency/idempotent.decorator.ts` per research §10; opt-in only; route-level registration.
- [ ] **T522** [P5] [Track D] [GATED] Add in-progress marker support to the idempotency module (Redis `SET NX EX 60`; reuse existing Redis connection from `IdempotencyKeyStore`); no schema change required.
- [ ] **T523** [P5] [Track D] [GATED] Update `POST /v1/memberships/invitations` controller to use `@Idempotent('required')` per plan §3.4.5; emit the three observability counters.
- [ ] **T524** [P5] [Track D] [GATED] Update OpenAPI contract at `packages/contracts/openapi/foundation/memberships.yaml` (or equivalent) to declare `x-idempotency: required` on the invitation endpoint (FR-D-008). This is the **only OpenAPI contract change** required by this slice.
- [ ] **T525** [P5] [Track D] [GATED] Update `IdempotencyKeyStore` default TTL from 24h to 72h via runtime config — no code constant change; reuse `defaultTtlMs` option (research §2).

### 8.4 Validation

- [ ] **T530** [P5] [Track D] [GATED] Validate: all P5 tests (T510–T518) pass GREEN.
- [ ] **T531** [P5] [Track D] [GATED] Validate: cross-tenant + cross-store sweep tests from 001 still pass on the affected route.
- [ ] **T532** [P5] [Track D] [GATED] Validate: OpenAPI contract test fixture is updated and the contract test passes (`x-idempotency: required` is honored by client expectations).
- [ ] **T533** [P5] [Track D] [GATED] Validate: idempotency state is NOT enabled on any other endpoint — `@Idempotent` decorator appears exactly once in this slice.
- [ ] **T534** [P5] [Track D] [GATED] Validate: no audit double-emission. A replayed request MUST NOT emit a second audit event for the same operation.

**Exit gate for P5**: T500–T534 complete with reviewer-recorded approval.
Expansion to additional endpoints is a separate slice per endpoint.

---

## 9. Phase 6 — Track C outbox design validation (docs + spike, no migration on main)

> Scope: outbox design RFC + repository contract tests against a transient
> DB (spike on a branch); **NO migration merged to main**. May proceed in
> parallel with P5; gates open only after this phase.

### 9.1 Design / documentation tasks

- [ ] **T540** [P6] [Track C] Author `docs/outbox/lifecycle.md` covering the full outbox event lifecycle from plan §3.3.1: producer (within transaction) → outbox table → drainer (poll + claim) → consumer (establish tenant ctx → idempotent processing → mark delivered) → retention.
- [ ] **T541** [P6] [Track C] [P] Author `docs/outbox/event-types.md` — initial event type registry. First and only entry: `audit.event.created` (mirroring the existing audit pipeline, FR-C-007). Document the registry contract: every new event type requires a separate approval PR and a documented schema.
- [ ] **T542** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document the durable event field set (plan §3.3.2): `event_id` (UUIDv7), `event_type`, `tenant_id` (NOT NULL), `store_id` (nullable), `payload` (JSONB; subject to redaction), `correlation_id`, `occurred_at`, `delivery_state`, `attempts`, `last_error`.
- [ ] **T543** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document retention (locked by Q2, spec §1.5): **90 days** for `delivered` events, **365 days** for `failed`/`dead_lettered`/`poison`/audit-relevant events. Right-to-erasure overrides both windows (FR-C-004, §12.12).
- [ ] **T544** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document the poison / dead-letter behavior (FR-C-005): bounded exponential backoff (recommended 30s/2m/10m/1h), retry budget of 8 attempts, never silently drop, dead-letter visible with redacted context (no PII / secret payload).
- [ ] **T545** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document the idempotent processing contract (FR-C-005): consumer uses `event_id` as dedup key; per-consumer `processed_events` projection records `(consumer_id, event_id)` with a unique constraint; re-delivery is a no-op.
- [ ] **T546** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document the tenant-context establishment rule (FR-C-003): drainer worker establishes tenant context from the event's `tenant_id` **before** any DB access beyond reading the outbox table itself.
- [ ] **T547** [P6] [Track C] [P] In `docs/outbox/lifecycle.md`, document the redaction obligation (FR-C-008): event payloads MUST NOT be logged in full; defer to the redaction matrix at `.specify/memory/redaction-matrix.md` (from T440).
- [ ] **T548** [P6] [Track C] [P] Author `docs/outbox/drainer-design.md` documenting the storage / drainer mechanism choice (research §9): DB table polling with `SELECT ... FOR UPDATE SKIP LOCKED`; LISTEN/NOTIFY deferred as a later optimization; BullMQ-only and transaction-callback approaches explicitly rejected for losing the durability guarantee.
- [ ] **T549** [P6] [Track C] [P] Author `docs/outbox/dead-letter-triage.md` documenting the operator triage UX (research §8): admin endpoint behind `RolesGuard` with an operator-only role; CLI deferred; direct Postgres access rejected (Constitution §II).

### 9.2 Spike tasks (separate branch, NOT merged to main)

These tasks produce empirical evidence that the design works. They live
on a feature branch and are **NOT merged to main** in this phase. They
inform but do not constitute the implementation in P7.

- [ ] **T550** [P6] [Track C] [GATED] Spike: author a transient outbox repository in a feature branch and validate `FOR UPDATE SKIP LOCKED` semantics with two concurrent drainers — record findings in `docs/outbox/drainer-design.md`. **Do not merge the spike branch.**
- [ ] **T551** [P6] [Track C] [GATED] Spike: validate retry/backoff and dead-letter transitions against a Testcontainer DB — record findings in `docs/outbox/drainer-design.md`. **Do not merge.**
- [ ] **T552** [P6] [Track C] [GATED] Spike: validate that a poison event reaches `dead_lettered` after 8 attempts without leaking PII in logs — record findings. **Do not merge.**

### 9.3 Validation

- [ ] **T555** [P6] [Track C] Validate: no `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, OpenAPI, migration, or CI change has landed on main as part of this phase. Spike branches remain unmerged.
- [ ] **T556** [P6] [Track C] Validate: docs reference Constitution §V (Async Work Belongs in Workers), §VII (Observable Systems), §XIV (PII & Data Lifecycle Discipline).

**Exit gate for P6**: T540–T556 complete. Empirical findings recorded.
Only then may P7 open the gated implementation slice.

---

## 10. Phase 7 — Track C outbox first slice (FUTURE, ALL `[GATED]`)

> **Every task in this phase is `[GATED]`.** First event type:
> `audit.event.created`. No catalog-specific event types. No broader
> rollout in this slice.

### 10.1 Test tasks (test-first)

- [ ] **T560** [P7] [Track C] [GATED] Author repository tests in `packages/db/test/outbox/repository.spec.ts`: insert / claim / mark-delivered / dead-letter happy paths + two concurrent drainers race (verifies `FOR UPDATE SKIP LOCKED`).
- [ ] **T561** [P7] [Track C] [GATED] Author tenant-context test in `apps/worker/test/outbox/tenant-context.spec.ts`: consumer fails RLS if it accesses DB before establishing tenant context (FR-C-003).
- [ ] **T562** [P7] [Track C] [GATED] Author retry-budget test in `apps/worker/test/outbox/retry-budget.spec.ts`: failed event reaches `dead_lettered` after 8 attempts; no 9th attempt.
- [ ] **T563** [P7] [Track C] [GATED] Author idempotent-processing test in `apps/worker/test/outbox/idempotent-consumer.spec.ts`: re-delivering a `delivered` event produces no duplicate side effect; per-consumer uniqueness constraint enforced.
- [ ] **T564** [P7] [Track C] [GATED] Author retention test in `packages/db/test/outbox/retention.spec.ts`: events past 90d (delivered) and 365d (failed) are eligible for purge; PII erasure overrides both windows.
- [ ] **T565** [P7] [Track C] [GATED] Author redaction test in `apps/worker/test/outbox/redaction.spec.ts`: outbox event payloads containing PII never appear in full in pino output; deferred to redaction matrix.
- [ ] **T566** [P7] [Track C] [GATED] Author privilege/RLS test in `packages/db/test/outbox/rls.spec.ts`: runtime DB role does NOT bypass RLS on the outbox table; cross-tenant outbox reads return safe 404 / empty set.

### 10.2 Schema / migration tasks

- [ ] **T570** [P7] [Track C] [GATED] Author Drizzle schema `packages/db/src/schema/outbox_events.ts` with columns from plan §3.3.2: `event_id`, `event_type`, `tenant_id NOT NULL`, `store_id`, `payload JSONB`, `correlation_id`, `occurred_at`, `delivery_state`, `attempts`, `last_error`, `created_at`, `processed_at`.
- [ ] **T571** [P7] [Track C] [GATED] Author SQL migration in `packages/db/migrations/NNNN_outbox_events.sql` creating the table, indexes (`(delivery_state, occurred_at)` for the drainer; partial index on `dead_lettered`), and RLS policies (tenant-scoped reads; insert-only at the application layer).
- [ ] **T572** [P7] [Track C] [GATED] Update migration safety checklist at `.specify/templates/migration-safety-checklist-template.md` instance for this migration: zero-downtime additive change; no constraint added to existing tables.

### 10.3 Producer / drainer / consumer implementation

- [ ] **T580** [P7] [Track C] [GATED] Author producer helper `packages/db/src/outbox/producer.ts` exposing `emit(eventType, tenantId, storeId, payload, correlationId)` that inserts an outbox event in the current transaction.
- [ ] **T581** [P7] [Track C] [GATED] Author drainer worker `apps/worker/src/outbox/drainer.processor.ts` with `SELECT ... FOR UPDATE SKIP LOCKED` claim mechanism, bounded exponential backoff (30s/2m/10m/1h), retry budget 8.
- [ ] **T582** [P7] [Track C] [GATED] Author consumer interface `packages/shared/src/outbox/consumer.ts` defining the `(consumer_id, event_id)` dedup contract.
- [ ] **T583** [P7] [Track C] [GATED] Wire the existing audit pipeline to emit `audit.event.created` via the outbox producer (T580) instead of directly publishing to BullMQ — proof-of-life adoption.
- [ ] **T584** [P7] [Track C] [GATED] Implement the consumer for `audit.event.created` in `apps/worker/src/outbox/consumers/audit-event-created.consumer.ts`; establishes tenant context before any DB read beyond the outbox table.

### 10.4 Retention / cleanup

- [ ] **T590** [P7] [Track C] [GATED] Author retention cleanup job `apps/worker/src/outbox/retention.processor.ts` running periodically (recommendation: daily); purges `delivered` events older than 90 days and `failed`/`dead_lettered` events older than 365 days; respects right-to-erasure overrides.
- [ ] **T591** [P7] [Track C] [GATED] Author dead-letter admin endpoint in `apps/api/src/outbox/admin.controller.ts` behind `RolesGuard` with an operator-only role per research §8; returns redacted dead-letter context (no PII).

### 10.5 Observability emission

- [ ] **T595** [P7] [Track C] [GATED] Emit `outbox_pending_total`, `outbox_dead_letter_total`, `outbox_drain_duration_seconds` per Track B signal catalogue (T446).
- [ ] **T596** [P7] [Track C] [GATED] Emit `queue_retry_total` and `queue_dead_letter_total` from the drainer worker.

### 10.6 Validation

- [ ] **T597** [P7] [Track C] [GATED] Validate: all P7 tests (T560–T566) pass GREEN.
- [ ] **T598** [P7] [Track C] [GATED] Validate: cross-tenant + cross-store sweep tests from 001 still pass — outbox does not regress tenant isolation.
- [ ] **T599** [P7] [Track C] [GATED] Validate: no catalog-specific event types added; only `audit.event.created`.
- [ ] **T600** [P7] [Track C] [GATED] Validate: no `BYPASSRLS` privilege granted to any runtime role (Constitution §II).

**Exit gate for P7**: T560–T600 complete with reviewer-recorded approval.
Subsequent event types are separate per-event slices.

---

## 11. Phase 8 — Track E SDK research close-out + downstream handoff

> Scope: lock the SDK strategy; **NO SDK files generated in this repo**;
> **NO `packages/sdk` introduced**. Downstream-repo generation is the
> first-slice mechanism.

### 11.1 Documentation tasks

- [ ] **T620** [P8] [Track E] Author `docs/sdk/strategy.md` documenting Q3 lock-in: `openapi-typescript` (types) + `openapi-fetch` (client); rationale per research §5; rejected alternatives (`orval`, `openapi-generator`, `hey-api/openapi-ts`).
- [ ] **T621** [P8] [Track E] [P] In `docs/sdk/strategy.md`, document the candidate output locations from plan §3.5.2 with first-slice eligibility: outside this repo (eligible), dashboard repo (eligible), POS repo (eligible), internal `packages/sdk` (**NOT eligible for first slice**, FR-E-007).
- [ ] **T622** [P8] [Track E] [P] In `docs/sdk/strategy.md`, document the drift-detection mechanism (research §6): downstream-repo CI runs the generator and diffs; in-repo CI deferred.
- [ ] **T623** [P8] [Track E] [P] In `docs/sdk/strategy.md`, document the generated-file policy: artifacts MUST NOT be hand-edited (FR-E-005); regeneration MUST be deterministic; OpenAPI source is the only place to fix a contract issue.
- [ ] **T624** [P8] [Track E] [P] In `docs/sdk/strategy.md`, document the `Idempotency-Key` (Track D) and tenant/store context (foundation 001) header handling expectations for the generated client (FR-E-004).
- [ ] **T625** [P8] [Track E] [P] Author `docs/sdk/handoff.md` — a brief, copy-pastable handoff packet for downstream dashboard/POS repo maintainers: where `packages/contracts/openapi/` lives, how to run `openapi-typescript`, how to configure `openapi-fetch`, how to set up drift detection in their own CI.
- [ ] **T626** [P8] [Track E] [P] In `docs/sdk/handoff.md`, document the OpenAPI versioning recommendation (research §5 follow-up): publish tagged contract artifacts (e.g., GitHub releases) for downstream pinning. **Marked as future**; not implemented in this phase.

### 11.2 Validation

- [ ] **T630** [P8] [Track E] Validate: NO new file under `packages/sdk/` in this repo. `ls packages/sdk` returns "no such directory" (FR-E-007).
- [ ] **T631** [P8] [Track E] Validate: NO `package.json` entry for `openapi-typescript` or `openapi-fetch` in this repo. `git diff package.json` empty.
- [ ] **T632** [P8] [Track E] Validate: NO generated `.ts` file under `packages/contracts/` or elsewhere in this repo.
- [ ] **T633** [P8] [Track E] Validate: NO CI workflow change for drift detection. `git diff .github/workflows/` empty.
- [ ] **T634** [P8] [Track E] Validate: `docs/sdk/strategy.md` and `docs/sdk/handoff.md` are the only Track E artifacts modified by this phase.

### 11.3 Tasks explicitly GATED for downstream / future work

- [ ] **T640** [P8] [Track E] [GATED — deferred] Future: introduce `packages/sdk` in this monorepo. Forbidden in the first slice (FR-E-007); revisited only after dashboard/POS contract needs stabilize and explicit approval for `package.json` / `pnpm-lock.yaml` / generated files.
- [ ] **T641** [P8] [Track E] [GATED — deferred] Future: in-repo CI drift-detection workflow. Deferred per research §6; downstream-repo CI is the first-slice mechanism.
- [ ] **T642** [P8] [Track E] [GATED — out-of-repo] Future: downstream dashboard/POS repo executes `openapi-typescript` + `openapi-fetch` against this repo's OpenAPI source. Lives **outside** this repo; not a Data-Pulse-2 task.

**Exit gate for P8**: T620–T642 complete (T640–T642 remain `[GATED]`).

---

## 12. Phase 9 — Cross-track validation

> Scope: confirm parallelism with 003 remains intact and no scope creep
> across the five tracks. Documentation review only.

- [ ] **T650** [P9] Confirm no task in this `tasks.md` touches catalog schema. `grep -ri "catalog" specs/004-platform-production-readiness/tasks.md` returns only references to the parallelism contract / non-goals (no schema/contract/code references).
- [ ] **T651** [P9] [P] Confirm no task touches catalog OpenAPI contracts. `grep "packages/contracts/openapi/catalog" specs/004-platform-production-readiness/tasks.md` returns no matches.
- [ ] **T652** [P9] [P] Confirm no task introduces catalog implementation. No `apps/api/src/modules/catalog/**` or `packages/db/src/schema/catalog/**` reference in any task description.
- [ ] **T653** [P9] [P] Confirm Track D's first endpoint is a **foundation** endpoint (`POST /v1/memberships/invitations`), NOT a catalog endpoint — T504 records the choice.
- [ ] **T654** [P9] [P] Confirm Track C's first event type is `audit.event.created` (foundation pipeline), NOT a catalog event — T541 records the choice.
- [ ] **T655** [P9] [P] Confirm no scope creep into POS implementation, dashboard UI, billing, reports, analytics, dbt, ClickHouse, Dagster, or deployment infrastructure. Grep for those terms in `tasks.md`; only references in non-goals / out-of-scope sections.
- [ ] **T656** [P9] [P] Confirm Constitution Principle alignment in §1.1 of this file is internally consistent with plan §9.
- [ ] **T657** [P9] [P] Confirm every `[GATED]` task explicitly names the artifact it would touch (file path, schema, contract, etc.) — reviewers can grep `[GATED]` and trace to the gate.
- [ ] **T658** [P9] [P] Confirm `git status --short` after each phase commit shows only documentation paths (`specs/004-platform-production-readiness/**`, `docs/observability/**`, `docs/idempotency/**`, `docs/outbox/**`, `docs/sdk/**`, `loadtests/k6/**`, `.specify/memory/redaction-matrix.md`) — nothing else permitted by this feature.
- [ ] **T659** [P9] Final cross-feature sanity: this feature is mergeable independently of 003 catalog work. No PR in 004 blocks a PR in 003 and vice versa, except where catalog explicitly opts into adopting a 004 contract (an opt-in catalog PR is reviewer-flagged but not feature-004-blocking).

**Exit gate for P9**: T650–T659 all green. Feature 004 is operationally
ready as a planning / specification artifact.

---

## 13. Track index (cross-reference)

| Track | Primary phase(s) | Task range | Locked decisions |
|---|---|---|---|
| **A — k6 Load Testing** | P2 | T420–T437 | Docker image `grafana/k6`; foundation endpoints only; synthetic tenants ≥3; regression delta `+10% p95 / +20% p99 / +0.5pp error` (research §1) |
| **B — Observability** | P3 (docs), P4 (instrumentation) | T440–T483 | OTel Collector OTLP/gRPC + Prometheus scrape; slow-query 500ms; redaction matrix at `.specify/memory/redaction-matrix.md`; no `tenant_id`/`store_id`/`user_id` as metric label |
| **C — Outbox** | P6 (design), P7 (impl) | T540–T600 | `audit.event.created` first event; `FOR UPDATE SKIP LOCKED`; retention 90d processed / 365d failed; right-to-erasure overrides |
| **D — Idempotency** | P5 | T500–T534 | `POST /v1/memberships/invitations` first endpoint; `425 Too Early` for in-progress; 72h replay retention; 60s marker TTL; NestJS interceptor + `@Idempotent` decorator |
| **E — SDK Generation** | P8 | T620–T642 | `openapi-typescript` + `openapi-fetch`; downstream-repo generation; NO `packages/sdk` first slice; drift detection in downstream CI |

---

## 14. `[GATED]` categories (consolidated)

Every `[GATED]` task in this file falls into one of these categories. The
reviewer obligation (spec §5.4, plan §5) is to verify each `[GATED]` PR
against its category.

| Category | Tasks | Why gated |
|---|---|---|
| `apps/**` source | T460–T466, T470–T476, T480–T483, T510–T518, T520–T523, T561–T565, T583–T584, T591, T595–T596, T597–T600 | Production source code change |
| `packages/**` source | T570, T580, T582 | Production source code change |
| `package.json` / `pnpm-lock.yaml` | T482 (conditional), T640, T642 | Dependency add/remove |
| DB schema (Drizzle) | T570 | Schema change |
| SQL migrations | T571, T572 | Migration change |
| OpenAPI contracts | T524, T532 | Contract change |
| CI workflows | T641 | CI change |
| Generated files | T642 | Generated artifact |
| `packages/sdk` introduction | T640 | Forbidden in first slice (FR-E-007) |
| Constitution-adjacent (`.specify/memory/`) | T440 | Constitution-level invariant artifact |
| Spike branches (NOT merged to main) | T550–T552 | Experimental code on a branch |

A `[GATED]` task is **NOT** approval to execute. Each `[GATED]` task
requires a separate, scoped, named approval PR before the task can be
sequenced into a real commit.

---

## 15. Parallelism with catalog (003)

This task list runs in parallel with 003-catalog-foundation under the
hard constraints from spec §5 / plan §6:

### 15.1 Hard constraints (verified per phase)
- 004 tasks **MUST NOT** change catalog schema. (T650)
- 004 tasks **MUST NOT** change catalog OpenAPI contracts. (T651)
- 004 tasks **MUST NOT** introduce catalog implementation. (T652)
- Track D's first endpoint is a **foundation** endpoint, NOT catalog. (T653)
- Track C's first event type is `audit.event.created`, NOT catalog. (T654)

### 15.2 Permitted parallel work
- 004 MAY define future expectations that catalog implementation can
  adopt later (the `@Idempotent` decorator, the outbox producer helper,
  the observability signal catalogue).
- Catalog adoption is a **catalog feature task**, not a 004 task. Any
  catalog PR opting into a 004 contract is reviewer-flagged but does not
  block 004.

### 15.3 Reviewer obligation
Reviewers of any PR claiming a 004 slice MUST verify against §15.1
before approving. A PR that sneaks in catalog schema, catalog
contracts, or catalog implementation under cover of a 004 task fails
review regardless of code quality (spec §5.4, plan §6.4).

### 15.4 Conflict resolution
If a 004 slice would force a catalog schema or contract change, that
slice MUST be paused and re-scoped, or deferred until after the
relevant catalog feature lands. Production-readiness work MUST NOT
become a back door for catalog changes (spec §5.3).

---

## 16. Out-of-scope reminders

Restated for explicit reviewer reference; authoritative non-goals list is
spec §3 + plan §3.1.

- No catalog implementation. No POS implementation. No dashboard UI.
- No billing, reports, analytics, dbt, ClickHouse, Dagster.
- No external deployment infrastructure (Kubernetes, Terraform, Helm).
- No vendor lock-in for observability, load testing, or SDK generation
  in any task.
- No global idempotency rollout — one endpoint at a time, opt-in only.
- No `packages/sdk` introduction in the first SDK implementation slice.
- No production load testing (FR-A-007).
- No PII in metric labels (FR-B-006 / §7.7).

---

## 17. Recommended first follow-up PR

After this `tasks.md` is reviewed and merged, the first follow-up PR is:

```
docs(spec): finalize platform production readiness tasks
```

**Scope**:
- `tasks.md` only (this file's review-feedback iteration).
- No implementation.
- No `package.json` change.
- No source change.
- No migrations.
- No OpenAPI change.
- No CI change.

**Reviewer obligation**: confirm the task list is internally consistent
with spec / plan / research; confirm zero `[NEEDS CLARIFICATION:` markers
remain in any of those four artifacts.

---

## 18. Recommended first implementation PR (after approval)

After the planning PR (§17) is merged, the first implementation PR is:

```
test(load): add k6 smoke/baseline scripts without package changes
```

**Scope** (executes P2 tasks T420–T437):
- `loadtests/k6/**` only.
- README documenting external Docker / CLI execution.
- Smoke + baseline + stress + regression scripts.
- Synthetic-tenant assumptions documented (no fixture data files in this repo).
- **No** `package.json` change.
- **No** `pnpm-lock.yaml` change.
- **No** CI wiring.
- **No** change under `apps/**` or `packages/**`.

**Reviewer obligation**: verify the diff is restricted to `loadtests/k6/**`;
verify operator-side smoke validation (T437) passed before merge.

---

## 19. Subsequent implementation order (recommended)

After the first implementation PR (§18), subsequent PRs follow the rollout
sequence from plan §8:

| # | Slice | Tasks | Lead PR title |
|---|---|---|---|
| 1 | P2 — k6 first slice | T420–T437 | `test(load): add k6 smoke/baseline scripts without package changes` |
| 2 | P3 — observability docs + redaction matrix | T440–T454 | `docs(observability): add redaction matrix and signal catalogue` |
| 3 | P4 — observability instrumentation `[GATED]` | T460–T483 | `feat(observability): instrument API/DB/worker signals + redaction` |
| 4 | P5 — idempotency design + first endpoint `[GATED]` | T500–T534 | `feat(idempotency): wrap memberships/invitations with @Idempotent` |
| 5 | P6 — outbox design validation | T540–T556 | `docs(outbox): lifecycle, retention, drainer design` |
| 6 | P7 — outbox first slice `[GATED]` | T560–T600 | `feat(outbox): introduce outbox table + audit.event.created consumer` |
| 7 | P8 — SDK research close-out | T620–T634 | `docs(sdk): lock openapi-typescript + openapi-fetch strategy + downstream handoff` |
| 8 | P9 — cross-track validation | T650–T659 | (no PR — review milestone) |
| 9+ | Track D expansion (per endpoint) `[GATED]` | n/a | One PR per additional idempotent endpoint |
| 10+ | Track C expansion (per event type) `[GATED]` | n/a | One PR per additional outbox event type |
| Future | `packages/sdk` introduction `[GATED]`, IF approved | T640 | Separate gated feature spec required |
| Future | In-repo CI drift detection `[GATED]`, IF approved | T641 | Separate gated CI feature |

Slices 1 and 2 may run in parallel (different files, different tracks).
Slices 4 and 5 may run in parallel (different tracks). Everything else is
sequential within its track.

---

## 20. Counts & summary

- **Total tasks**: 110 (T400–T659)
- **Phases**: 9 (P1–P9)
- **Tracks covered**: A, B, C, D, E (all five)
- **`[GATED]` tasks**: ~55 (every future source / schema / migration / contract / CI / generated-file / package-change task)
- **Spike-only tasks (NOT merged to main)**: 3 (T550–T552)
- **Docs-only tasks**: ~55
- **Active `[NEEDS CLARIFICATION:` markers**: 0
- **Forbidden files touched**: 0

**Next command**: review and merge this `tasks.md`, then open the first
implementation PR per §18.

---

*End of tasks.*
