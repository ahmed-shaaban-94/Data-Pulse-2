# P4 Observability Closeout Report

**Feature**: 004-platform-production-readiness
**Phase**: P4 (Track B Observability instrumentation)
**Status**: Closeout-ready
**Date**: 2026-05-17
**Owner**: Track B Observability owner
**Main SHA**: `c2d6aa6` — Merge pull request #226 from ahmed-shaaban-94/feat/004-observability-worker-queue-metrics

> **Documentation-only artifact.** This report records the outcome of the
> P4 closeout validation wave. It introduces no source, test, contract,
> schema, migration, CI, package, or lockfile changes.

---

## 1. Scope

004 Track B / P4 Observability instrumentation closeout. This report
covers the four closeout tasks defined in
`specs/004-platform-production-readiness/tasks.md`:

- **T480** — All P4 tests (T460–T466) pass GREEN.
- **T481** — Existing cross-tenant + cross-store regression sweeps still
  pass.
- **T482** — No `package.json` / `pnpm-lock.yaml` drift.
- **T483** — Operator validation: a local `/metrics` scrape exposes
  every signal without PII.

---

## 2. Completed implementation slices

All four P4 instrumentation slices have shipped to `main` as gated,
scoped PRs:

| Slice | Surface | Reference |
|---|---|---|
| **Slice 1** | Redaction, structured logging, cardinality guard | PR #222 |
| **Slice 2** | API / Auth metrics | PR #223 |
| **Slice 3** | DB / RLS + cross-tenant metrics | PR #224 |
| **Slice 4** | Worker / Queue metric definitions | PR #226 |

Slice 4 added `apps/worker/src/observability/metrics/worker.metrics.ts`
(seven emit-now signals + three Track C outbox placeholders) and
`apps/worker/test/observability/worker-signals.spec.ts` (114 tests
covering signal presence, label policy, bounded enums, error-class
sanitization, and helper callability).

---

## 3. T480 — P4 GREEN sweep

**Result**: **GREEN**.

### Commands run

```
pnpm --filter @data-pulse-2/api    test  -- --testPathPattern="observability/"
pnpm --filter @data-pulse-2/worker test  -- --testPathPattern="observability/"
pnpm --filter @data-pulse-2/shared test
pnpm --filter @data-pulse-2/api    build
pnpm --filter @data-pulse-2/worker build
pnpm --filter @data-pulse-2/shared build
```

### Evidence

| Surface | Suites | Tests | Result |
|---|---:|---:|---|
| API observability (`apps/api/test/observability/`) | 6 | 197 | pass |
| Worker observability (`apps/worker/test/observability/`) | 2 | 120 | pass |
| Shared full suite (`packages/shared/__tests__/`) | 12 | 204 | pass |
| **Aggregate** | **20** | **521** | **pass** |

### Builds

| Package | Result |
|---|---|
| `@data-pulse-2/api` (`tsc -p tsconfig.build.json`) | exit 0 |
| `@data-pulse-2/worker` (`tsc -p tsconfig.build.json`) | exit 0 |
| `@data-pulse-2/shared` (`tsc -p tsconfig.build.json`) | exit 0 |

### Suite-level breakdown (API observability)

| Suite | Tests |
|---|---|
| `apps/api/test/observability/api-signals.spec.ts` | T460 — API signal presence |
| `apps/api/test/observability/auth-failure-signals.spec.ts` | T466 — auth failure cause coverage |
| `apps/api/test/observability/cardinality.spec.ts` | T461 — forbidden-label tripwire |
| `apps/api/test/observability/cross-tenant-signals.spec.ts` | T464 — cross-tenant rejection signal |
| `apps/api/test/observability/db-rls-signals.spec.ts` | T463 — DB / RLS signals |
| `apps/api/test/observability/redaction.spec.ts` | T462 — PII canary redaction |

### Suite-level breakdown (Worker observability)

| Suite | Tests |
|---|---|
| `apps/worker/test/observability/otel-propagation.spec.ts` | trace-context propagation contract |
| `apps/worker/test/observability/worker-signals.spec.ts` | T465 — worker / queue signal presence |

No skips. No failures.

---

## 4. T481 — Regression sweep

**Result**: **GREEN**.

### Command run

```
MIGRATION_TEST_ALLOW_SKIP=1 \
  pnpm --filter @data-pulse-2/api test -- --testPathPattern="cross|tenant|store|rls"
```

### Evidence

- **21 suites / 407 tests pass / 0 failures.**
- 58 test files matched the `cross-tenant | cross-store | RLS |
  TenantContextGuard | tenant context` discovery grep across
  `apps/api/test`.
- Canonical sweeps covered:
  - `apps/api/test/authz/cross-tenant.sweep.spec.ts`
  - `apps/api/test/authz/cross-store.sweep.spec.ts`
  - `apps/api/test/authz/no-unscoped-tenant-query.spec.ts`
  - `apps/api/test/authz/frontend-bypass.spec.ts`
  - `apps/api/test/context/tenant-context.guard.spec.ts` and
    `tenant-context.guard.unit.spec.ts`
  - `apps/api/test/db/db-context.middleware.spec.ts`

### Docker / Testcontainers availability

Docker was **not available** in the validation environment (`docker`
not on PATH). The documented `MIGRATION_TEST_ALLOW_SKIP=1` escape
hatch was honoured by every Testcontainers-gated suite:

- Each gated suite emitted an explicit
  `console.warn("[<file>] skipping (Docker unavailable)")` and
  returned early from its `maybeSkip()` guard.
- Non-Docker assertions in the same files still ran and passed.
- No suite errored; no suite failed.

This matches the project's documented dev-without-Docker workflow
(see `apps/api/test/_helpers/postgres-container.ts` and the per-suite
`maybeSkip()` patterns).

---

## 5. T482 — Package / lockfile drift

**Result**: **GREEN**.

### Command run

```
git diff -- package.json pnpm-lock.yaml
```

### Evidence

- Output: **empty**.
- No `package.json` changes.
- No `pnpm-lock.yaml` changes.
- No new dependencies added by any of the four P4 slices.

---

## 6. T483 — Operator `/metrics` validation

**Result**: **BLOCKED-GATED** (by package approval).

> **This is not a test failure.** T483 is structurally blocked on a
> separately-gated package addition and runtime wiring slice. Every
> instrumentation slice (1–4) explicitly deferred T483 to this gate;
> the planning documents
> (`docs/observability/p4-redaction-cardinality-plan.md §10`,
> `docs/observability/p4-worker-instrumentation-plan.md §11–§12`,
> `docs/observability/p4-api-instrumentation-plan.md`) name it as a
> follow-up.

### Findings

| Component | State |
|---|---|
| First-party `MeterProvider` registration | **Absent.** `packages/shared/src/observability/otel.ts` registers only `OTLPTraceExporter` + `NodeSDK` (trace exporter only). No `MeterProvider`, no `MetricReader`. |
| `PrometheusExporter` import or instantiation | **Absent.** No first-party `.ts` file imports `@opentelemetry/exporter-prometheus`. |
| First-party `/metrics` HTTP endpoint | **Absent.** Neither `apps/api/src/main.ts` nor `apps/worker/src/main.ts` exposes a `/metrics` route or HTTP listener. |
| `@opentelemetry/sdk-metrics` declared as direct dep | **No.** Appears in `pnpm-lock.yaml` only as a transitive dep under `@opentelemetry/sdk-node`'s tree. |
| `@opentelemetry/exporter-prometheus` declared as direct dep | **No.** Same — transitive only. |
| `getMeter()` runtime behaviour | **No-op meter.** Without a registered `MeterProvider`, every `record*` helper in `api.metrics.ts`, `db.metrics.ts`, and `worker.metrics.ts` is a no-op. The label policy + typed helpers are exercised; the instruments themselves emit no values. |

### Why a separate slice is required

To unblock T483 without violating the closeout PR's docs-only scope,
the following changes are needed (all explicitly forbidden in the
closeout wave; reserved for a future gated slice):

1. Add `@opentelemetry/sdk-metrics` as a direct dependency of
   `packages/shared`.
2. Add `@opentelemetry/exporter-prometheus` as a direct dependency of
   `apps/api` and `apps/worker`.
3. Register a `MeterProvider` with a `PrometheusExporter` reader in
   `packages/shared/src/observability/otel.ts` (or a new
   `metrics.ts` shared module), reached by `startOtel(...)` callers.
4. Mount a `/metrics` HTTP endpoint on `apps/api` (via the existing
   Express adapter) and add a minimal HTTP listener to
   `apps/worker/src/main.ts` (the worker has no HTTP surface today).

Each of those four changes requires the separately-gated approval
described in `specs/004-platform-production-readiness/plan.md §5`
and the per-lane pre-flight plans.

---

## 7. Docker note

Docker is **not required** for this closeout wave.

- T480 ran entirely against in-process modules — no DB, no Redis,
  no Postgres, no Testcontainers.
- T481 honoured the documented `MIGRATION_TEST_ALLOW_SKIP=1` escape
  hatch; the regression sweeps' non-Docker assertions ran and passed.
- T482 is a pure `git diff` check.
- T483's blocker is package/exporter approval, not Docker
  availability.

Future enhancement (out of scope for this closeout): installing
Docker (Desktop with WSL2 backend, or Docker Engine inside WSL)
would unlock the Testcontainers-gated branches in
`stores.controller.spec.ts`, `db-context.middleware.spec.ts`,
`audit.repository.spec.ts`, and similar — strengthening real-RLS
evidence for T481 in subsequent waves. It does not affect T483.

---

## 8. Closeout decision

**P4 is closeout-ready** under the decision rubric agreed at task
sign-off:

| Task | Result |
|---|---|
| T480 | GREEN |
| T481 | GREEN |
| T482 | GREEN |
| T483 | BLOCKED-GATED by package approval |

Per the rubric ("GREEN if T480 / T481 / T482 pass and T483 is
completed or explicitly BLOCKED-GATED by package approval"), the P4
instrumentation surface is closeout-ready.

---

## 9. Recommended follow-up

Two paths are open, to be chosen at owner discretion:

1. **Keep T483 as a separate gated exporter / package pre-flight.**
   A docs-only pre-flight PR (paralleling the existing
   `p4-*-plan.md` artifacts) records the exact package additions,
   `MeterProvider` wiring shape, and `/metrics` endpoint surface
   for review before any source change.

2. **Open a future implementation slice** for
   `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`
   + `MeterProvider` registration + `/metrics` endpoint design,
   following the slice discipline that delivered Slices 1–4.

Either path is consistent with the project's gating policy; neither
is authorised by this closeout report.

---

## 10. Scope confirmation

This closeout PR is **docs-only**.

- Changed files: exactly one — `docs/observability/p4-closeout-report.md`.
- No `apps/**` changes.
- No `packages/**` changes.
- No `package.json` change.
- No `pnpm-lock.yaml` change.
- No OpenAPI changes.
- No DB schema or migration changes.
- No CI workflow changes.
- No generated files.
- No catalog, POS, dashboard UI, billing, reports, analytics, dbt,
  ClickHouse, Dagster, or deployment work.

---

*End of P4 closeout report.*
