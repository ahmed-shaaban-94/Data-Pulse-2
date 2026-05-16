# P4 API Observability Instrumentation — Pre-Flight Plan

**Feature**: 004-platform-production-readiness
**Phase**: P4 (Track B instrumentation, all `[GATED]`)
**Lane**: A — API observability instrumentation pre-flight
**Status**: Approval-ready plan. **DOCS-ONLY**. No runtime code, no tests, no
package changes authored by this PR.
**Constitution**: v3.0.0 (Principles II, VI, VII, VIII)
**Created**: 2026-05-16
**Owner**: Track B Observability owner

> **Planning artifact only.** This document records the exact files, hooks,
> signals, and validation steps the future P4 API-instrumentation slice will
> touch. Listing a future file here is **not approval to write it**. Per
> `specs/004-platform-production-readiness/plan.md §5` and `tasks.md §1.2`,
> every task this plan references is `[GATED]` and requires a separate,
> scoped, named approval PR before any commit lands.

---

## 1. Scope and tasks covered

This plan covers the API-side and DB-side subset of P4. Worker-side P4 work
(T465, T472 worker portion) lives in the companion **Lane C — Worker /
queue observability pre-flight** plan. Redaction, cardinality-static-check,
and structured-log-field wiring (T461, T462, T473, T474, T482, T483) live
in the companion **Lane B — Redaction + cardinality pre-flight** plan.

### Tasks covered by this plan

| Task | Description | Status |
|---|---|---|
| **T460** | Author signal-presence integration test for every API metric in `docs/observability/signals.md` | Planned — file path locked |
| **T463** | Author RLS-context-failure signal test (Testcontainer DB) | Planned — file path locked |
| **T464** | Author cross-tenant rejection signal test (extends 001 RLS bypass probe) | Planned — file path locked |
| **T466** | Author auth-failure-by-cause test | Planned — file path locked |
| **T470** | Register API metric definitions in `apps/api/src/observability/metrics/api.metrics.ts` | Planned — file path locked |
| **T471** | Register DB metric definitions in `apps/api/src/observability/metrics/db.metrics.ts` | Planned — file path locked |
| **T475** | Emit `cross_tenant_rejection_total` from `TenantContextGuard` rejection path | Planned — emission site identified |
| **T476** | Emit `db_rls_context_failure_total` from a low-level DB instrumentation hook | Planned — emission site identified |
| **T480 (API subset)** | Validate all listed P4 API tests pass GREEN | Validation method documented |
| **T481 (API subset)** | Validate cross-tenant + cross-store sweep tests from 001 still pass | Existing sweep files identified |
| **T482 (API subset)** | Validate no `package.json` change unless separately approved | Risk-assessed (see §10) |
| **T483 (API subset)** | Operator validation: local `/metrics` exposes every API signal | Validation script documented |

Tasks deferred to other lanes are listed in §11 explicitly so the reviewer
can see this plan stops at its boundary.

---

## 2. Source-of-truth references

These files are the canonical sources this plan defers to. Any divergence
between this plan and those files is a defect in this plan, not in them.

- **Signal catalogue**: `docs/observability/signals.md` §1 (API), §2 (DB)
- **Redaction policy**: `.specify/memory/redaction-matrix.md` (Lane B owns
  the call-site wiring; this lane consumes the policy as a constraint)
- **Spec**: `specs/004-platform-production-readiness/spec.md` §7.3, §7.4,
  §7.7
- **Plan**: `specs/004-platform-production-readiness/plan.md` §3.2.1,
  §3.2.4, §5
- **Research**: `specs/004-platform-production-readiness/research.md` §4
  (Observability vendor & exporter target)
- **Constitution**: `.specify/memory/constitution.md` §VII (Observable
  Systems), §II (Multi-Tenant SaaS by Default), §VIII (Reproducible &
  Versioned Releases)
- **Existing P3 docs**: `docs/observability/dashboards/README.md`,
  `docs/observability/alerts/README.md` — every dashboard/alert that ships
  in `ops/` reads from the signals this slice wires up.

---

## 3. Existing API observability hooks (discovered, do not edit)

The platform already has substantial observability bones. The P4 slice
**plugs into** these — it does not rewrite them. The plan below names each
hook the future slice will touch and the role it plays.

### 3.1 Cross-cutting interceptor chain

The Nest interceptor pipeline (composed in `apps/api/src/app.module.ts`)
runs in this order on every request:

1. **`apps/api/src/common/request-id.interceptor.ts`** — assigns `request.requestId`. **Existing.** P4 reuses this id as the `request_id` log field (delegated to Lane B for log-side wiring).
2. **`apps/api/src/common/logging.interceptor.ts`** — emits one structured pino line per request. **Existing.** The log already carries `method`, `route`, `status`, `latency_ms`. P4 will pair this with `http_request_count` / `http_request_duration_seconds` *metric* emission. The interceptor itself is the natural place for the histogram observation since it already measures `latency_ms` via `process.hrtime.bigint()`.
3. **`apps/api/src/auth/auth.guard.ts`** — authentication boundary. **Existing.** Emits no metric today; P4 wires `auth_failure_total{cause}` here for the **non-credential failure path** (missing/expired/bad-token). Specifically `bad_password` lives in `apps/api/src/auth/auth.service.ts` (which compares the argon2id hash); both paths emit through a shared counter in `api.metrics.ts`.
4. **`apps/api/src/auth/rate-limit.ts`** — rate limiter. **Existing.** Emits the `auth_failure_total{cause="rate_limited"}` counter from its rejection path.
5. **`apps/api/src/context/tenant-context.guard.ts`** — tenant/store context resolution. **Existing.** This is the emission site for **`cross_tenant_rejection_total{route}`** (T475) and **`tenant_context_failure_total{reason}`**. Today this guard returns `UnauthorizedException` for missing-tenant, `NotFoundException` for cross-tenant attempts (FR-ISO-4). The P4 instrumentation adds counters at the same throw points; **no behavior change**, only an emission side-effect that fires before the throw.
6. **`apps/api/src/context/context.interceptor.ts`** + **`apps/api/src/context/context.als.ts`** — bridges resolved context into `AsyncLocalStorage`. **Existing.** P4 does not modify these; it reads from ALS to attach `tenant_id` / `store_id` / `actor_id` to **logs** (Lane B), never to metric labels.
7. **`apps/api/src/db/db-context.middleware.ts`** + **`apps/api/src/db/db-context.ts`** — sets `app.current_tenant` / `app.is_platform_admin` GUCs before the work function runs. **Existing.** This is the natural detection site for `db_rls_context_failure_total` (T476). See §5.2.
8. **`apps/api/src/common/exception.filter.ts`** — uniform error envelope. **Existing.** Maps thrown exceptions to HTTP status codes (`statusToCode`). P4 wires `http_error_4xx_total{route,status}` and `http_error_5xx_total{route,status}` at the same site (the filter sees every error), avoiding the need to instrument every controller individually. **Note**: 4xx caused by validation also increments `validation_failure_total` from the `ZodError` branch — the metric emission lives in the filter, not in the Zod pipe, because the filter is the single boundary.

### 3.2 Shared observability primitives (already in `packages/shared`)

The shared package already exposes everything except the metrics path:

- **`packages/shared/src/observability/otel.ts`** — `startOtel({ serviceName, ... })` returns a singleton `NodeSDK` with `HttpInstrumentation`, `PgInstrumentation`, `RedisInstrumentation` registered. **Currently trace-only.** BullMQ instrumentation is deferred (see file header comment).
- **`packages/shared/src/observability/bullmq-propagation.ts`** — W3C trace-context inject/extract helpers used by `injectTraceContext(carrier)` / `extractTraceContext(carrier)`. **Existing.** Workers already use this (`apps/worker/test/observability/otel-propagation.spec.ts` proves the contract).
- **`packages/shared/src/logger/pino.ts`** — `createLogger({ service, redactPaths? })` with `DEFAULT_REDACT_PATHS` covering `req.headers.authorization`, `req.headers.cookie`, `password`, `password_hash`, `token`, `access_token`, `refresh_token`, `session_token`, `api_key`, `secret` (+ `*.password` etc.). `withRequestContext(logger, ctx)` produces a child logger with `request_id`, `tenant_id`, `user_id`, `store_id`. **Existing.** P4 augments structured-log fields via Lane B; no change in this lane.

### 3.3 Existing test harness (similar pattern P4 follows)

These prove the harness P4 inherits — Testcontainers, supertest, anonymous-actor patterns, etc.:

- `apps/api/test/audit/redaction.spec.ts` — Testcontainers integration test pattern (Postgres container + supertest + DB read-back). P4 redaction tests (Lane B's T462) follow this layout.
- `apps/api/test/audit/anonymous-actor.spec.ts` — anonymous-actor sentinel verification (Principle XIII pattern).
- `apps/api/test/authz/cross-tenant.sweep.spec.ts` — the **existing RLS bypass probe** that T464 extends. **This file MUST keep passing after P4 instrumentation lands** (T481).
- `apps/api/test/authz/cross-store.sweep.spec.ts` — the existing cross-store sweep. Same regression-protection role.
- `apps/api/test/authz/no-unscoped-tenant-query.spec.ts` — static check for queries that bypass `runWithTenantContext`. Important context for T476 — the **runtime** RLS-context-failure signal complements this **static** check.
- `apps/api/test/common/logging.interceptor.spec.ts` — proves the existing logger interceptor contract; P4 must keep it green.

---

## 4. Future test files (T460, T463, T464, T466)

> **Test-first per Constitution §VI.** These tests MUST be written and
> MUST be RED before any T470–T476 instrumentation lands. The order in
> each future PR is: write test → confirm RED → write minimum
> instrumentation → confirm GREEN.

### 4.1 `apps/api/test/observability/signal-presence.spec.ts` — T460

Asserts every API metric from `docs/observability/signals.md` §1 and every
DB metric from §2 is **registered** in the platform-wide OTel meter and is
**exposed** at the API process's `/metrics` endpoint (Prometheus scrape
adapter per research §4).

| What | How |
|---|---|
| Test type | Integration; Testcontainers Postgres + Nest test app bootstrap; no Redis dependency (signal-presence test does not exercise BullMQ). |
| Boot strategy | `Test.createTestingModule({ imports: [AppModule] })` then `app.init()`; OTel metrics SDK started in the same lifecycle as the API. |
| Scrape strategy | `supertest(app.getHttpServer()).get('/metrics')` returns Prometheus text format; assert each canonical signal name is present in the response body. |
| Signal list source | Test imports a single source-of-truth array from `apps/api/src/observability/metrics/api.metrics.ts` (the registration module from T470) and from `apps/api/src/observability/metrics/db.metrics.ts` (T471). The test is structurally tied to the registration — if a signal is added to the catalogue but not to the registration module, the test fails at module load, not at runtime. |
| Allowed labels | The test asserts the *names* exist; per-label cardinality static check is **Lane B / T461** (separate file). |
| Stop condition | If `/metrics` is not exposed (e.g., the Prometheus exporter is not wired in the API bootstrap), this test stays RED and instrumentation does not proceed until the exporter is added. **The exporter wiring is part of T470 — it is the gate, not an external precondition.** |

### 4.2 `apps/api/test/observability/rls-context-failure.spec.ts` — T463

Crafts a DB call that bypasses `runWithTenantContext` and asserts
`db_rls_context_failure_total` increments and a WARN/ERROR log entry
exists with redaction honored.

| What | How |
|---|---|
| Test type | Integration; **Testcontainers Postgres required** (the GUC + RLS interaction is what's under test). |
| Setup | Boot the app; acquire a `Pool` directly from the test harness's `pg` client; run a raw `SELECT * FROM memberships LIMIT 1` against the `app_test` role **without** setting `app.current_tenant`. Per the existing `packages/db/src/middleware/tenant-context.ts` design, this should fail RLS (the GUC defaults to empty, the `::uuid` cast fails). |
| Assertion 1 (metric) | After the failure, `db_rls_context_failure_total` (no labels) has incremented by 1. Read via an in-process OTel metric reader (the same one the test harness uses for T460). |
| Assertion 2 (log) | A pino log line at WARN/ERROR was emitted referencing the failure. The log line **MUST NOT** contain the rendered query text or parameter values (per `.specify/memory/redaction-matrix.md` §3.3 "Validation error context" — Lane B's policy; this lane consumes it as a constraint). The log line MUST carry `request_id`, `route`, `method`, and `query_class` (parameterized SHA prefix — not the raw query). |
| Stop condition | If a code-side hook into Drizzle / pg pool error handling is not feasible without exposing query parameters, the slice STOPS and re-evaluates. Emission at `apps/api/src/db/db-context.middleware.ts` (catching the `runWithTenantContext` error path) is the recommended emission site — it has the request shape but not the query. See §5.2. |
| Tenant safety | The test runs against the test DB only; it does NOT introduce a `BYPASSRLS` privilege to any role (Constitution §II). |

### 4.3 `apps/api/test/observability/cross-tenant-rejection.spec.ts` — T464

Extends the existing 001 cross-tenant RLS bypass probe
(`apps/api/test/authz/cross-tenant.sweep.spec.ts`) to assert
`cross_tenant_rejection_total{route}` increments on attempted cross-tenant
access.

| What | How |
|---|---|
| Test type | Integration; Testcontainers; supertest. **Reuses** the sweep test's fixture (two tenants, one cross-tenant request). |
| Setup | Provision tenant A and tenant B per the sweep's existing fixture; authenticate as tenant A; attempt to access a tenant B resource via a route that goes through `TenantContextGuard`. |
| Assertion 1 (metric) | After the response (which is a 404 per FR-ISO-4), `cross_tenant_rejection_total{route=<route template>}` has incremented by 1. |
| Assertion 2 (status) | Response remains 404. **The instrumentation MUST NOT change the response status, body, or envelope.** The metric emission is a side-effect of the existing throw path. |
| Assertion 3 (log) | A WARN-level log line was emitted with `request_id`, `tenant_id` (the attacker's tenant — established, so log-safe per `.specify/memory/redaction-matrix.md` §3.4), `route`, and `reason: "cross_tenant"`. The log MUST NOT include the **target** tenant's id (that would leak the existence of tenant B — Principle II safe-404 rule). |
| Boundary | The test asserts the **route template** value (`/v1/tenants/:tenant_id/members`), not the rendered path. Rendered paths are PII-suspect because they carry tenant IDs in the URL. The metric label is `route`, not `path`. |
| Stop condition | If the rejection emission site (the `TenantContextGuard` throw branches) cannot be reached without changing the existing throw semantics, STOP. The guard already throws `UnauthorizedException` / `NotFoundException`; the emission is a pre-throw side-effect, not a behavior change. |

### 4.4 `apps/api/test/observability/auth-failure.spec.ts` — T466

Asserts `auth_failure_total{cause}` increments correctly across all five
documented causes.

| What | How |
|---|---|
| Test type | Integration; Testcontainers; supertest. |
| Cause matrix | Five sub-tests, one per cause: `bad_password` (POST /v1/auth/signin with wrong password), `bad_token` (any authenticated endpoint with a malformed bearer), `expired` (an authenticated endpoint with a known-expired token — fixture seeds an expired session), `missing` (an authenticated endpoint with no `Authorization` header on a route that requires auth), `rate_limited` (signin attempts past the rate-limit threshold). |
| Emission sites referenced | `apps/api/src/auth/auth.service.ts` (bad_password), `apps/api/src/auth/auth.guard.ts` (bad_token, expired, missing), `apps/api/src/auth/rate-limit.ts` (rate_limited). |
| Assertion (each sub-test) | The corresponding label value increments; siblings do not. |
| Log redaction constraint | Logs for `bad_password` MUST NOT contain the attempted email or password (Lane B; this test asserts the cause label is set, redaction is asserted in Lane B's T462). |
| Stop condition | If an `auth_failure_total` cause cannot be emitted without inspecting the credential material, STOP and revise — `cause` is derived from **outcome**, not from the credential. |

---

## 5. Future implementation files (T470, T471, T475, T476)

> Authored only **after** the T460–T466 tests are RED. Each file is the
> minimum surface required to flip its test GREEN.

### 5.1 `apps/api/src/observability/metrics/api.metrics.ts` — T470

Registers the API metric family with the OTel Meter and exposes typed
helpers. Pattern: one file per *layer* (api, db, worker), not one file per
metric.

| Concern | Decision |
|---|---|
| Meter source | A platform-wide meter obtained from a future `packages/shared/src/observability/metrics.ts` factory (see §10 — the factory introduces `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-prometheus`; **this is the package-change site**, gated separately). |
| Registration target | The OTel SDK started by `startOtel({ serviceName: 'api', ... })` from `packages/shared/src/observability/otel.ts`. **The SDK constructor in `otel.ts` is extended in the same PR** to accept an optional `metricsExporter` argument; trace behavior is unchanged. |
| Emission API | Counters/histograms exported as typed helpers, e.g. `recordHttpRequest({ route, method, status_class })`, `recordCrossTenantRejection({ route })`, `recordAuthFailure({ cause })`. The helper is the **only** public surface; raw `meter.createCounter(...)` calls are not exposed to call sites (call sites would otherwise be tempted to attach forbidden labels). |
| Forbidden-label guardrail | The helpers' TypeScript signature accepts only the documented label keys. A call site cannot pass `tenant_id` because the helper's parameter type doesn't admit it (compile-time enforcement of FR-B-006). This is the type-system arm of the cardinality discipline. Lane B's T461 is the static / runtime arm. |
| Endpoint exposure | A Prometheus scrape endpoint at `/metrics` is wired by the shared metrics factory (§10). This is the only new HTTP route in the slice. |

Emission call sites (this file does not own them; it provides the helper):

| Helper | Called from | Per |
|---|---|---|
| `recordHttpRequest({route, method, status_class})` + duration histogram | `apps/api/src/common/logging.interceptor.ts` (extend the existing `tap({next, error})`) | T470 — wires the histogram measurement to the existing `latency_ms` calculation. |
| `recordHttpError({route, status})` for 4xx and 5xx | `apps/api/src/common/exception.filter.ts` (within `catch`) | T470 — single boundary. |
| `recordAuthFailure({cause})` | `apps/api/src/auth/auth.service.ts` (`bad_password`), `apps/api/src/auth/auth.guard.ts` (`bad_token`/`expired`/`missing`), `apps/api/src/auth/rate-limit.ts` (`rate_limited`) | T470. |
| `recordTenantContextFailure({reason})` and `recordCrossTenantRejection({route})` | `apps/api/src/context/tenant-context.guard.ts` (T475 — see §5.3) | T470 wires the helper, T475 wires the call site. |
| `recordValidationFailure({route})` | `apps/api/src/common/exception.filter.ts` (`ZodError` branch) | T470. **No `field_class` label** — drift from plan §3.2.1 documented in `docs/observability/signals.md` §8 finding 2; the runtime instrumentation slice reconciles with plan/spec, not the other way. |
| `recordSuspiciousLogin({reason})` | `apps/api/src/auth/auth.service.ts` and rate-limit (where the detection lives) | T470. **No tenant/user label** — same FR-B-006 rule. |

### 5.2 `apps/api/src/observability/metrics/db.metrics.ts` — T471

Registers the DB metric family.

| Signal | Emission mechanism |
|---|---|
| `db_pool_in_use` / `db_pool_waiters` (gauges) | OTel `ObservableGauge`. Callback reads from the existing `pg.Pool` instance (the one wired in `apps/api/src/auth/auth.module.ts` as `PG_POOL`): `pool.totalCount - pool.idleCount` (in-use), `pool.waitingCount` (waiters). Sampling driven by the metrics SDK's collection interval; the helper does not maintain a side state. |
| `db_slow_query_total{query_class}` (counter) | Emitted from a Drizzle middleware or `pg` connection-level `query` event listener that times each query against the 500ms threshold (research §4 / `docs/observability/signals.md` §5). `query_class` = SHA-256 prefix of the **parameterized** statement (`SELECT ... WHERE id = $1`), never the rendered query. Threshold is read from a runtime config (no code constant). The hook lives in `packages/db/src/middleware/slow-query.ts` (a new file in `packages/db`) and is imported and registered at API bootstrap. **`packages/db` is gated**; T471 references this file but the file's creation is part of the same gated slice. |
| `db_rls_context_failure_total` (counter, no labels) | Emitted from `apps/api/src/db/db-context.middleware.ts` **error path**. The middleware today wraps every request handler in `runWithTenantContext`; failures (caught by the surrounding try/catch in the middleware) check whether the error is a Postgres RLS-related error (error code `42501 insufficient_privilege` or the `invalid input syntax for type uuid: ""` family). If yes → emit. If no → re-throw without emission. **Alertable per FR-B-009**; no per-tenant label. |
| `db_migration_status{state}` (gauge) | Set at app bootstrap from the migrator's exit state. Today, `packages/db/src/cli/migrate.ts` runs migrations; the API bootstrap calls it (or asserts it has run). The gauge is set once at startup (`applied`/`pending`/`failed`); no runtime updates. |

**Plan §3.2.1 vs signals.md drift findings** (per `docs/observability/signals.md` §8):
- `validation_failure_total` will emit only `route` (no `field_class`). Plan §3.2.1 to be reconciled in P4's instrumentation slice — not in this docs-only lane.
- `suspicious_login_total` uses `reason` (not plan's `pattern`) — same reconciliation note.
- `worker_processing_failure_total` uses `job_name` (not plan's `job_type`) — owned by Lane C.

### 5.3 Emission wiring — T475 (cross-tenant rejection) and T476 (RLS context failure)

| Task | Emission site | Mechanism | Behavior change? |
|---|---|---|---|
| T475 | `apps/api/src/context/tenant-context.guard.ts` lines that throw `notFound()` (cross-tenant) and `unauthorized()` (missing-context) | Add a `this.metrics.recordCrossTenantRejection({ route })` call **immediately before** the throw. The `route` is read from the `ExecutionContext` request via `request.route?.path` (Express) or `request.routerPath` (Fastify) — whichever the existing `LoggingInterceptor` uses (consistency check). | **No.** The throw still happens; the status code, error envelope, and response body are unchanged. The only side-effect is the counter increment. |
| T476 | `apps/api/src/db/db-context.middleware.ts` catch branch around `runWithTenantContext` | Inspect the caught error; if it matches the RLS-failure signature, call `this.metrics.recordDbRlsContextFailure()`. Re-throw the original error in both cases. | **No.** The middleware's external behavior is identical. |

### 5.4 What this slice does NOT instrument

To keep the surface honest, the following sites are **out of scope** for
P4 and are not touched by this plan:

- BullMQ-side instrumentation — Lane C.
- Outbox-side signals — Track C P7.
- Idempotency signals — Track D P5.
- Dashboards / alert rules — `ops/` repo, post-P4.
- `info`-level "request happy-path" log content — already present via the
  existing `LoggingInterceptor`; not extended here.

---

## 6. Allowed labels (low-cardinality only)

Cross-reference: `docs/observability/signals.md` §1, §2, §6.

| Signal | Allowed labels |
|---|---|
| `http_request_count` | `route`, `method`, `status_class` |
| `http_request_duration_seconds` | `route`, `method` |
| `http_error_4xx_total` | `route`, `status` |
| `http_error_5xx_total` | `route`, `status` |
| `auth_failure_total` | `cause` ∈ {`bad_password`, `bad_token`, `expired`, `missing`, `rate_limited`} |
| `tenant_context_failure_total` | `reason` ∈ {`missing`, `invalid`, `cross_tenant`} |
| `validation_failure_total` | `route` |
| `suspicious_login_total` | `reason` ∈ {`rapid_retry`, `geo_anomaly`, `unknown_device`} |
| `cross_tenant_rejection_total` | `route` |
| `db_pool_in_use` / `db_pool_waiters` | (none) |
| `db_slow_query_total` | `query_class` (parameterized SHA prefix) |
| `db_rls_context_failure_total` | (none — alertable) |
| `db_migration_status` | `state` |

---

## 7. Forbidden labels (FR-B-006 — non-negotiable)

These **MUST NOT** appear as labels on **any** API or DB signal:

| Forbidden label | Why | Where it does live |
|---|---|---|
| `tenant_id` | Unbounded cardinality + already a log/trace field; metric breakdowns reconstruct via logs+traces. | Logs (per `withRequestContext`); traces (OTel resource attribute or span attribute). |
| `store_id` | Same as `tenant_id`; multiplies cardinality further. | Logs; traces. |
| `user_id` / `actor_id` | Unbounded cardinality; PII-adjacent. | Logs; traces. |
| Raw email / phone / name | PII (redaction matrix §3.2). | Nowhere — never logged in full. |
| Raw `Authorization` / `Cookie` header values | Credentials (redaction matrix §3.1). | Nowhere; redacted at logger boundary. |
| Raw query text / parameters | PII-suspect + cardinality. | `query_class` (parameterized hash). |
| `error.message` text | PII-suspect + cardinality. | `error_class` (exception class name) for worker signals; the API side uses the HTTP `status` code as the discriminator. |
| `field_name` on validation failures | PII-suspect (validation errors echo user input field paths). | `route` only. |
| Date/time strings | Cardinality explosion. | Built-in timestamp. |
| Rendered URL path (e.g., `/v1/tenants/123/members`) | Unbounded cardinality (tenant id in path). | `route` template (`/v1/tenants/:tenant_id/members`). |

The `api.metrics.ts` helpers' TypeScript signatures enforce this at
compile time. Lane B's T461 enforces it at static-analysis time as a
defense-in-depth check.

---

## 8. `package.json` change assumption

**This lane assumes NO `package.json` change is approved at the same time
as the API instrumentation slice.** Two scenarios:

### 8.1 Scenario A — metrics SDK approved together with this slice

The future P4 slice introduces `@opentelemetry/sdk-metrics` and
`@opentelemetry/exporter-prometheus` (and possibly `@opentelemetry/api`
peer-version bumps) in `packages/shared/package.json`. This is a
**separately gated** approval under T482; reviewer obligation: confirm the
two packages are the **minimum** addition, no `@opentelemetry/auto-instrumentations-node` (rejected — over-broad), no managed-vendor SDK (rejected per FR-B-007).

### 8.2 Scenario B — metrics SDK approval deferred

If T482's package-add is rejected or deferred, this slice CANNOT ship as a
single PR. Options:
1. Split: a smaller PR adds the metrics SDK in `packages/shared` first (own gating, own approval) — then this slice is purely consumer-side.
2. Skeleton-only: register **no-op** counters via a stub that satisfies the test surface, defer the real exporter to a follow-up. This trades coverage for unblockedness; recommended only as a stop-gap if the test surface absolutely cannot wait. The risk is dead code if Scenario A doesn't land soon after.

**Default assumption for this plan**: Scenario A. The instrumentation slice
brings the metrics SDK as part of itself; reviewer approves the
`package.json` delta scoped to the two named packages.

---

## 9. Testcontainers requirement for DB / RLS checks

| Test | Testcontainer needed? | Why |
|---|---|---|
| T460 signal-presence | Yes (Postgres) — but minimal; the test only needs the app to boot. | The existing `apps/api/test/audit/redaction.spec.ts` harness pattern (PostgreSqlContainer) is reused; no new harness. |
| T463 RLS-context-failure | **Yes (Postgres) — mandatory** | The signal exists precisely to detect RLS misconfiguration; the test cannot be unit-mocked because the GUC + RLS interaction is what's under test. |
| T464 cross-tenant rejection | Yes (Postgres) — reuses the existing 001 sweep harness | Multi-tenant fixture is required. |
| T466 auth-failure | Yes (Postgres) — needed for the seeded user/session fixture | Bad-password and expired-token paths need real DB rows. |

Test isolation: every test creates and tears down its own container or
reuses a shared container per file (`beforeAll` / `afterAll`) — same
pattern as `apps/api/test/audit/redaction.spec.ts`. No production DB
contact.

---

## 10. How to prove metrics are exposed

Two validation surfaces:

### 10.1 In-test (CI-runnable)

T460's signal-presence test scrapes `/metrics` from the in-process Nest
app via supertest and asserts the metric **name** appears in the
Prometheus text-format body. This validates registration + exposition.

### 10.2 Operator validation (T483)

A local dev run:

```
pnpm --filter @data-pulse-2/api start:dev   # or production-mode equivalent
curl -s http://localhost:3000/metrics | grep -E '^http_request_count|^db_pool_in_use|^cross_tenant_rejection_total|^db_rls_context_failure_total'
```

Operator confirms every signal from `docs/observability/signals.md` §1
and §2 appears in the curl output. If a signal is missing, the slice fails
operator validation and cannot merge.

> Lane B's T483 owns the broader operator validation (PII canary,
> structured-log fields, redaction proof). This lane's operator validation
> is restricted to the *names* and the `/metrics` endpoint.

---

## 11. How to prove existing RLS / cross-tenant tests still pass (T481)

The P4 slice MUST NOT regress 001's tenant-isolation guarantees. Required
proof:

- `apps/api/test/authz/cross-tenant.sweep.spec.ts` — GREEN.
- `apps/api/test/authz/cross-store.sweep.spec.ts` — GREEN.
- `apps/api/test/authz/no-unscoped-tenant-query.spec.ts` — GREEN.
- `apps/api/test/authz/default-deny.spec.ts` — GREEN.
- `apps/api/test/authz/frontend-bypass.spec.ts` — GREEN.
- Full `pnpm --filter @data-pulse-2/api test` — GREEN.

These are checked by CI on every PR; the slice MUST NOT silence or skip
any. If the new instrumentation changes the throw timing in
`TenantContextGuard`, the sweep tests will catch the regression because
they assert on response status/body, not on metric values.

---

## 12. Stop conditions (do NOT proceed if any of these hold)

The P4 API instrumentation slice STOPS and re-plans if:

1. Adding `@opentelemetry/sdk-metrics` is rejected at review without an
   alternative metrics backend named (Scenario B path).
2. A required emission site requires changing the response status or error
   envelope (e.g., the only way to detect cross-tenant rejection involves
   wrapping the existing throw). The emission must be **pre-throw side
   effect**, never a behavior change.
3. The signal-presence test (T460) cannot be made deterministic without a
   long timeout — indicates the metrics SDK's collection cadence is racing
   the supertest assertion. **Fix**: configure the SDK to use an
   in-process synchronous reader for tests; do not extend the timeout.
4. T463 cannot detect an RLS failure without exposing query parameters in
   the log line. **Fix**: emit at `db-context.middleware.ts` (which has
   only the request shape), not at a `pg` query listener (which has
   parameters).
5. A new `apps/api/**` file would need to be created **outside** the
   `apps/api/src/observability/` and `apps/api/test/observability/`
   subtrees. Any cross-cutting change to existing files (interceptor,
   filter, guard, middleware) is scoped to **emission call additions
   only** — no logic changes.
6. The cardinality static check (Lane B / T461) finds a forbidden label on
   any signal registered by this slice. The slice does not merge until the
   label is removed.
7. The redaction matrix wiring (Lane B's T473) is not yet merged. The
   matrix policy itself (`.specify/memory/redaction-matrix.md`) is already
   live as of P3 / T440; this lane's instrumentation inherits the matrix as
   a constraint, but the per-emit-site **wiring** (Lane B) is the
   precondition for redaction-honoring log emission.

---

## 13. Cross-references to other lanes

| Companion lane | Topic | Why separate |
|---|---|---|
| **Lane B — Redaction + cardinality** | T461 cardinality static test, T462 redaction test, T473 logger-boundary wiring, T474 structured-log fields, T482 package-change validation, T483 operator `/metrics` PII canary | Cross-cutting policy artifact; not API-specific. |
| **Lane C — Worker / queue** | T465 worker signal-presence, T472 worker metrics, queue/Redis emission | Worker-side surface; different process; uses BullMQ. |

This lane's plan stops at the API process boundary. It does not author,
plan, or describe any worker/queue/Redis emission.

---

## 14. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Metrics SDK package add (T482) is rejected | LOW–MEDIUM | Slice blocked | Pre-socialize the 2-package addition with reviewers; have Scenario B fallback documented (§8.2). |
| OTel metrics collection cadence races T460 test assertions | MEDIUM | Flaky test | Use the in-process synchronous metric reader for tests (OTel SDK supports this); do not depend on default 60s collection interval in tests. |
| Cardinality regression introduced by a future call site | MEDIUM | Catastrophic (Prometheus storage explosion) | Compile-time enforcement via typed helpers + Lane B's T461 static check. **Two gates, not one.** |
| Emission timing in `TenantContextGuard` reverses the throw order | LOW | Behavior change → 001 sweep regression | Emission MUST be **synchronous** and **before** the throw; T481 sweep tests catch regressions. |
| RLS-failure detection misses a Postgres error variant | MEDIUM | False negatives (silent RLS failures) | Emission site catches **all** errors from `runWithTenantContext`; only the **classification** decides metric vs no-metric. False positives are preferable to false negatives for an alertable signal. |
| `/metrics` endpoint exposed without auth | MEDIUM | Information leak to LAN | The endpoint is **non-routable from the internet** — bound to localhost or an internal port; ops-side scrape only. **Decision deferred to ops**; the slice exposes the endpoint at a port/path the ops infra terminates internally. Documented in `docs/observability/dashboards/README.md`'s sibling alerts doc. |

---

## 15. Discovered hooks summary (one-line per hook)

| File | Role this slice plays |
|---|---|
| `apps/api/src/common/request-id.interceptor.ts` | Source of `request_id` (already exists). Read-only. |
| `apps/api/src/common/logging.interceptor.ts` | Extend `tap({next, error})` to call `recordHttpRequest` + duration histogram. |
| `apps/api/src/common/exception.filter.ts` | Extend `catch` to call `recordHttpError({route, status})` and `recordValidationFailure({route})`. |
| `apps/api/src/auth/auth.service.ts` | Call `recordAuthFailure({cause: 'bad_password'})` from the password-check failure branch. |
| `apps/api/src/auth/auth.guard.ts` | Call `recordAuthFailure({cause: 'bad_token'|'expired'|'missing'})` from the relevant rejection branches. |
| `apps/api/src/auth/rate-limit.ts` | Call `recordAuthFailure({cause: 'rate_limited'})` from the rate-limit-rejection branch. |
| `apps/api/src/context/tenant-context.guard.ts` | Call `recordCrossTenantRejection({route})` and `recordTenantContextFailure({reason})` pre-throw (T475). |
| `apps/api/src/db/db-context.middleware.ts` | Call `recordDbRlsContextFailure()` from the RLS-failure error branch (T476). |
| `packages/db/src/middleware/tenant-context.ts` | Read-only; the existing GUC contract is what this slice instruments. |
| `packages/db/src/middleware/slow-query.ts` (new — gated) | Hook for `db_slow_query_total{query_class}`. **In `packages/db`; gated.** |
| `packages/shared/src/observability/otel.ts` | Extend to accept a `metricsExporter` argument; trace behavior unchanged. |
| `packages/shared/src/observability/metrics.ts` (new — gated) | Meter factory + Prometheus exporter wiring. **In `packages/shared`; gated.** |

---

## 16. Mergeability of this PR

**This PR (the Lane A pre-flight) is mergeable as docs-only.** It changes
exactly one file (`docs/observability/p4-api-instrumentation-plan.md`) and
introduces no:

- runtime code change,
- test file,
- package.json change,
- pnpm-lock.yaml change,
- OpenAPI contract change,
- DB schema or migration change,
- CI workflow change,
- generated file,
- `apps/**` change,
- `packages/**` change,
- `.specify/**` change,
- `loadtests/**` change.

A reviewer can confirm by running `git diff --name-only` against this PR
and expecting **exactly one path**:
`docs/observability/p4-api-instrumentation-plan.md`.

---

## 17. Recommended commit message (if later approved)

```
docs(observability): pre-flight plan for P4 API instrumentation
```

## 18. Recommended PR title (if later approved)

```
docs(observability): pre-flight plan for P4 API instrumentation
```

---

## 19. Next action

This plan is the approval gate for the future P4 API instrumentation
slice. Recommended sequence:

1. **Now**: review this plan; merge as docs-only after reviewer agreement.
2. **After**: open a separate gated PR per **T470/T471** (instrumentation
   surface) bundled with **T460/T463/T464/T466** (the test files) and the
   approved `package.json` delta from §8.1. T475 and T476 are emission
   wiring within the same PR. The PR title pattern is
   `feat(observability): instrument API + DB signals + emission [GATED]`.
3. **After that**: open the T483 operator validation PR (or include the
   operator-validation evidence in the same PR's description; reviewer
   decision).

This plan does NOT authorize step 2 or 3. It establishes the surface that
those PRs will operate on.

---

*End of Lane A pre-flight plan.*
