# 004 Platform Production Readiness — Closeout Status

**Feature ID**: 004
**Feature name**: Platform Production Readiness
**Date**: 2026-05-21 (P7 exit-gate update — see Changelog)
**Author**: Ahmed Shaaban
**Constitution**: v3.0.0

## Changelog

- **2026-05-21** (T483 P4 addCallback wiring — PRs #270 and #271) —
  Four previously-unwired ObservableGauge instruments are now wired.
  PR #270 (W1+W2): `ApiDbPoolGaugeRegistrar` (API) and `WorkerDbPoolGaugeRegistrar`
  (worker) wire `db_pool_in_use` + `db_pool_waiters` against their respective
  pg.Pool instances; `QueueLagGaugeRegistrar` wires `queue_lag_seconds` against
  5 BullMQ queue readers in the worker. PR #271 (W3): `ApiDbMigrationStatusGaugeRegistrar`
  wires `db_migration_status` querying `_drizzle_migrations COUNT(*)` at scrape
  time, with filesystem-resolved total migration count and `Number.MAX_SAFE_INTEGER`
  fallback on discovery error. All four signals move from "Unwired / deferred" to
  "addCallback wired; not yet live-scraped". `redis_command_duration_seconds`
  remains the last unwired instrument in the P4 catalogue.
- **2026-05-21** (T483 operator evidence — status correction 2026-05-21) —
  T483 live `/metrics` scrape validation recorded against commit `678baa47`
  (see `docs/observability/operator-validation-report.md`). Verdict:
  **PASS for exercised API/worker/outbox paths only**. The run proves OTel
  SDK wiring, metric registration order, and emission call-sites for the
  subset of signals whose code paths were touched by representative traffic.
  It does **not** prove full signal-catalogue live-scrape coverage. P4
  status is therefore **PARTIAL** — not DONE. Unwired and unexercised
  signals (DB pool, DB migration, Redis, idempotency, auth-failure,
  RLS-failure, cross-tenant, suspicious-login) remain a backlog item.
  P7 outbox observability scope is **DONE**; Spec 004 P4 full-catalogue
  coverage remains PARTIAL pending a future operator-validation slice.
- **2026-05-21** — P7 closeout. T565 (PR #255), T595 PR-B-1 (PR #253) and
  PR-B-2 (PR #259), T596 (PR #251) all merged; Codecov upload flake removed
  by PR #257. T597–T600 exit-gate validation recorded in §3 and §11. P7
  status moves PARTIAL → **DONE for the in-scope items**, with T483 (live
  `/metrics` operator scrape) and T591 admin write endpoints documented
  as separately tracked operator / future-slice work.
- **2026-05-19** — Initial closeout status doc.

---

## 1. Purpose and Scope

This document is the **runtime closeout and evidence log** for Spec 004 Platform
Production Readiness. It records which planned tasks have been executed, which
are partial, and which remain in the backlog, based on merged PR evidence.

**Relationship to other artifacts**:

- **`docs/production-readiness/004-cross-track-validation.md`** (PR #212,
  2026-05-16): That report performed the P9 cross-track validation check against
  the planning-phase docs PRs (#200, #201, #206, #207, #211) and declared GREEN.
  It remains correct for the scope it covered. This document **supersedes its
  runtime-status interpretation only** — it does not delete, rewrite, or
  invalidate the P9 findings. Both documents coexist.

- **`specs/004-platform-production-readiness/tasks.md`**: Remains a
  **planning artifact only**. Task checkboxes are intentionally left unchecked.
  Listing a task in `tasks.md` is not approval to execute it; executing a task
  does not retroactively justify checking it off. This document is the evidence
  log; `tasks.md` is the planning intent.

---

## 2. Current Overall Status

| Phase | Track | Status | Summary |
|---|---|---|---|
| P1 — Planning closeout | — | **DONE** | tasks.md, spec, plan, research, and checklist all present and cross-referenced. |
| P2 — k6 load testing | A | **DONE** (T437 needs operator validation) | Scripts and README merged; live smoke-run against non-prod not yet recorded. |
| P3 — Observability docs | B | **DONE** | Redaction matrix and signal catalogue merged; signal-label drift documented as non-blocking. |
| P4 — Observability instrumentation | B | **PARTIAL** | Redaction and structured logging wired (T473/T474). API custom metrics emitting for exercised paths (PR #248). Worker job + queue metrics emitting (PR #251 / T596). Outbox metrics emitting (PR #253 PR-B-1 + PR #259 PR-B-2 / T595). T483 exercised-path operator scrape **PASSED** 2026-05-21 for API/worker/outbox signals. `db_pool_in_use`, `db_pool_waiters`, `queue_lag_seconds`, `db_migration_status` addCallbacks wired (PRs #270/#271). Only `redis_command_duration_seconds` remains unwired. Full signal-catalogue live-scrape evidence (all four newly-wired signals + Redis, idempotency, auth-failure, RLS-failure, cross-tenant, suspicious-login) remains PARTIAL — see §4.C and `docs/observability/operator-validation-report.md`. |
| P5 — Idempotency | D | **DONE** | Strategy docs and full implementation for `POST /api/v1/memberships/invite` merged. |
| P6 — Outbox design validation | C | **DONE** | All four outbox design docs merged; spike branches not merged to main (correct). |
| P7 — Outbox first slice | C | **DONE / OPEN: future admin writes** | Schema, drainer, producer, consumer, retention, DI swap, outbox metrics emission (T595 PR-B-1/-B-2, T596), worker logger redaction (T565), exit-gate validation (T597–T600) all complete. T483 exercised-path operator scrape evidence (PASS, 2026-05-21) confirms P7 outbox observability is live — this is P7 scope, not full P4 signal-catalogue scope. Per-consumer dedup projection and T591 admin write endpoints (retry/requeue/acknowledge) remain explicitly deferred to future slices. |
| P8 — SDK strategy | E | **DONE** | Strategy and handoff docs merged; no `packages/sdk` or generated files introduced. |
| P9 — Cross-track validation | — | **SUPERSEDED / STALE for runtime status** | Planning-phase report (PR #212) does not cover PRs #222–#242. This document is the authoritative runtime status. |

---

## 3. Task-to-PR Reconciliation

### P1 — Planning Closeout (T400–T410)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P1 | T400–T410 | Spec/plan/research/checklist cross-reference; no active markers; gating table verified | tasks.md merge PR | DONE | No separate exit-gate PR; tasks.md review served as the gate. |

### P2 — Track A k6 Load Testing (T420–T437)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P2 | T420–T431 | `loadtests/k6/README.md`, smoke/baseline/stress/regression scripts, shared lib helpers, synthetic-tenant fixture doc | #200 | DONE | All files under `loadtests/k6/**` confirmed present. No `package.json`, CI, `apps/**`, or `packages/**` changes. |
| P2 | T432–T436 | Validation: no package/CI/apps/packages drift | #200 | DONE | Explicit scope notes in PR #200 body confirm clean diff. |
| P2 | T437 | Smoke-run validation against live non-prod stack | #200 (operator-side) | NEEDS OPERATOR VALIDATION | Cannot be verified from repo files alone; must be run by an operator against a live non-production environment using `grafana/k6:0.50.0`. |

### P3 — Track B Observability Docs (T440–T454)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P3 | T440–T443 | Redaction matrix at `.specify/memory/redaction-matrix.md` | #201 | DONE | [GATED] T440 approval recorded in PR #201 body. |
| P3 | T444–T449 | Signal catalogue `docs/observability/signals.md` — API, DB, Redis/BullMQ/worker signals; cardinality rule; structured-log fields; slow-query threshold | #201 | DONE | Signal-label drift from plan §3.2.1 documented as non-blocking: `reason` vs `cause`, `job_name` vs `job_type`, `field_class` omitted from `validation_failure_total`. |
| P3 | T450–T451 | Dashboards/alerts placeholder docs | #201 | DONE | |
| P3 | T452–T454 | Validation: no runtime change; signal drift recorded | #201 | DONE | T453 drift findings recorded in PR #201 body for future cleanup. |

### P4 — Track B Observability Instrumentation (T460–T483)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P4 | T461 | Cardinality test | #222 | DONE | |
| P4 | T462 | Redaction test | #222 | DONE | |
| P4 | T473 | Logger-boundary redaction wiring (API) | #222 | DONE | Worker equivalent deferred per PR #222 scope. |
| P4 | T474 | Structured-log fields (`request_id`, `tenant_id`, `store_id`, `actor_id`, `correlation_id`) | #222 | DONE | |
| P4 | T460, T463–T466 | Signal-presence, RLS-failure, cross-tenant, worker, auth-failure signal tests | #222, #229 | PARTIAL | Not all test suites explicitly confirmed in PR evidence; T465 worker signals covered by PR #229 worker observability tests. |
| P4 | T470–T472 | Metric definitions registered (API, DB, worker) | #229 | PARTIAL | PR #229 wires OTel metrics SDK and exposes `/metrics`; metric family definitions registered. Actual emission from DB and drainer call-sites still pending. |
| P4 | T475–T476 | Emit `cross_tenant_rejection_total` and `db_rls_context_failure_total` | Not confirmed | PARTIAL | Not explicitly referenced in merged PR bodies. |
| P4 | T480–T482 | P4 validation suite GREEN | #227 | DONE | PR #227 closeout report at `docs/observability/p4-closeout-report.md` confirms T480–T482 GREEN. |
| P4 | T483 | Live `/metrics` operator scrape validation | #229 (unblocks), PR #265 | **PASS (exercised paths) / PARTIAL (full catalogue)** | Operator-side run on 2026-05-21 against commit `678baa47`. Exercised API/worker/outbox metrics present in live scrape with expected label shapes. Verdict **PASS for exercised paths**. Full signal-catalogue coverage (DB pool, DB migration, Redis, idempotency, auth-failure, RLS-failure, cross-tenant, suspicious-login) **not yet live-proven** — see §4.C backlog and `docs/observability/operator-validation-report.md`. |
| P4 | T483 addCallback wiring (W1–W3) | `db_pool_in_use`, `db_pool_waiters`, `queue_lag_seconds`, `db_migration_status` ObservableGauge addCallback wiring | #270 (W1+W2), #271 (W3) | **DONE (wired; not yet live-scraped)** | PR #270: `ApiDbPoolGaugeRegistrar` + `WorkerDbPoolGaugeRegistrar` (pool counters); `QueueLagGaugeRegistrar` (5 BullMQ queues, clamped lag, re-entrancy guard). PR #271: `ApiDbMigrationStatusGaugeRegistrar` (applied/pending/failed state logic, `Number.MAX_SAFE_INTEGER` fallback on filesystem error). Unit tests for all four wiring paths. `redis_command_duration_seconds` ioredis hook remains the last unwired instrument. |

### P5 — Track D Idempotency (T500–T534)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P5 | T500–T506 | Idempotency strategy docs (`docs/idempotency/strategy.md`) | #206 | DONE | Covers `Idempotency-Key` semantics, 425/409 behavior, Redis `SET NX EX 60` marker, 72h replay retention, decorator design, client-side retry guidance. |
| P5 | T510–T518 | All 9 test suites: replay, conflict, in-progress, cross-tenant, TTL, expiry, missing-header, signals, authorization-preservation | #228 | DONE | 44 tests across 9 suites confirmed in PR #228 body. |
| P5 | T520–T523 | `IdempotencyInterceptor`, `@Idempotent` decorator, in-progress marker (Redis `SET NX EX`), controller wiring for `POST /api/v1/memberships/invite` | #228 | DONE | |
| P5 | T524 | OpenAPI `x-idempotency: required` on invite endpoint | #228 | DONE (PATH DRIFT) | Confirmed at `packages/contracts/openapi/memberships.openapi.yaml:15`. tasks.md §8.3 references `packages/contracts/openapi/foundation/memberships.yaml` — path drift documented; functionally complete. |
| P5 | T525 | `IdempotencyKeyStore` TTL updated 24h → 72h via runtime config | #228 | DONE | |
| P5 | T530–T534 | Validation: test suite pass, cross-tenant sweep, contract test, single-endpoint check, no double-emission | #228 | DONE | All 5 validations confirmed in PR #228 body. |

### P6 — Track C Outbox Design Validation (T540–T556)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P6 | T540–T549 | `docs/outbox/lifecycle.md`, `event-types.md`, `drainer-design.md`, `dead-letter-triage.md` | #207 | DONE | All four docs files present. First event type `audit.event.created` recorded; `FOR UPDATE SKIP LOCKED` drainer design documented; 90d/365d retention documented; dead-letter triage UX documented. |
| P6 | T550–T552 | Spike tasks (concurrent drainers, retry/backoff, poison-event validation) | NOT merged (correctly) | DEFERRED BY DESIGN | Spike-only tasks; correct that they do not appear on main. Empirical findings incorporated into docs. |
| P6 | T555–T556 | Validation: no runtime change on main | #207 | DONE | PR #207 scope notes confirm docs-only diff. |

### P7 — Track C Outbox First Slice (T560–T600)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P7 | T570–T572 | Drizzle schema (`outbox_events.ts`), SQL migration `0006_outbox_events`, migration safety checklist | #233 | DONE | PR #233 is the outbox **persistence/RLS foundation** (Slice 1A). Not idempotency. |
| P7 | T566 | RLS privilege test: runtime role does not bypass RLS | #233 | DONE | Testcontainers RLS coverage in Slice 1A. |
| P7 | T560–T563 | Repository tests (insert/claim/deliver/dead-letter, concurrent drainer race), tenant-context test, retry-budget test, idempotent-consumer test | #233 (partial), #234 | PARTIAL | PR #233 deferred runtime happy-path tests to Slice 1B; PR #234 covers T560–T563. T563 per-consumer `(consumer_id, event_id)` projection deferred — only row-level idempotency via `delivery_state` currently enforced. |
| P7 | T580–T582 | Producer `emit()`, drainer worker (`FOR UPDATE SKIP LOCKED`, 30s/2m/10m/1h backoff, 8-attempt budget), consumer interface | #234 | DONE | PR #234 is the outbox **runtime drainer and audit consumer** (Slice 1B). Retention was **explicitly deferred** by this PR to Slice 1C. |
| P7 | T584 | `audit.event.created` consumer + worker wiring | #234 | DONE | `audit-event-created.consumer.ts` present. |
| P7 | T583 | Wire audit pipeline to outbox producer (live DI swap) | #237 | DONE | Feature-flagged via `OUTBOX_AUDIT_ENABLED=1`; default OFF for safe rollout. PR #238 carries CodeRabbit hardening follow-up (whitespace-tolerant flag parser, structured-logging boundary, pool-leak fix in tests). |
| P7 | T564 | Retention purge eligibility tests (90d/365d windows, audit immutability, right-to-erasure, pending/claimed never-purge) | #235 | DONE | 14 tests, 5 suites pinning the SQL predicate. |
| P7 | T565 | Worker logger redaction test | #235, #255 | DONE | PR #235 landed 10 passing + 5 `it.todo`. PR #255 closed all 5 todos and added 6 further cases (RD-4f full envelope + RD-5 `*.metadata.X` defense), backed by a redaction-matrix amendment (matrix §3.2 `actor_label` row + §4.3 wildcard-depth subsection, 2026-05-21). Total: 21 passing, 0 todo. |
| P7 | T590 | Retention cleanup processor (daily, batch 1000, 90d/365d) | #236 | DONE | `retention.processor.ts`, `retention.policy.ts`, `drizzle-outbox-retention.repository.ts`, `retention.worker.ts`, `retention.scheduler.ts` all present. |
| P7 | T591 | Dead-letter triage admin endpoint | #240 | PARTIAL | Read-only `GET /api/v1/admin/outbox/dead-letters` (list + detail) done. Payload column never projected. `last_error` exposed only as sanitized `last_error_class`. `@PlatformAdminOnly()` gate enforced. **Retry/requeue (1C-C2), acknowledge (1C-C3), and dedicated `platform:operator` role all deferred**. |
| P7 | T596 | Emit `queue_failed_total`, `queue_retry_total`, `queue_dead_letter_total`, `worker_job_duration_seconds`, `worker_processing_failure_total` from worker job + drainer paths | #251 | DONE | EmailProcessor / AuditFanoutProcessor wrapped in try/catch/finally; drainer queue-decision branches emit BEFORE persistence (D4). Bounded labels honored; no allowlist change. |
| P7 | T595 PR-B-1 | Emit `outbox_dead_letter_total`, `outbox_drain_duration_seconds` from `DrainerProcessor.processRow` | #253 | DONE | Per-row try/finally emits drain duration; existing DLQ branch emits dead-letter BEFORE `safeMarkDeadLettered`. `event_type` label only. |
| P7 | T595 PR-B-2 | Emit `outbox_pending_total` via ObservableGauge `addCallback` | #259 | DONE | `registerOutboxPendingGauge` runs `SELECT event_type, COUNT(*) FROM outbox_events WHERE delivery_state = ANY('{pending,claimed,failed}'::text[]) GROUP BY event_type` under platform-admin tenant context at scrape time. Re-entrancy guard, throws-safe callback, no-DB-path no-op. Nest-aware `OutboxPendingGaugeRegistrar` lifecycle. |
| P7 | T597 | Validate: all P7 tests (T560–T566) pass GREEN | THIS PR | DONE | See §11.1. Worker observability + outbox + db outbox suites all GREEN under `MIGRATION_TEST_ALLOW_SKIP=1`. Integration suites validated via real Postgres (WSL Docker). |
| P7 | T598 | Validate: cross-tenant + cross-store sweep tests from 001 still pass | THIS PR | DONE | See §11.2. `apps/api/test/authz/cross-tenant.sweep.spec.ts` — 10 / 10 passed against real Postgres. Outbox layer's RLS path is the same `runWithTenantContext` plumbing 001 covers; PRs #251 / #253 / #255 / #259 did not touch any route the sweep exercises. |
| P7 | T599 | Validate: no catalog-specific event types added; only `audit.event.created` | THIS PR | DONE | See §11.3. `OUTBOX_EVENT_TYPES` const in `packages/db/src/outbox/producer.ts:51` has exactly one entry; locked at compile time by `OutboxEventType` union and pinned at runtime by new `packages/db/__tests__/outbox/event-types-registry.spec.ts` (6 cases). |
| P7 | T600 | Validate: no `BYPASSRLS` privilege granted to any runtime role | THIS PR | DONE | See §11.4. `app_role` (and `app_test`) verified `rolbypassrls=false` by `repository.dead-letter.spec.ts` DL-6 (3 / 3 BYPASSRLS-tagged tests passed against real Postgres) and `migration/0001-catalog.spec.ts:317`. Migration `0006_outbox_events.sql:178` source comment locks the contract. |

### P8 — Track E SDK Strategy (T620–T634)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P8 | T620–T626 | `docs/sdk/strategy.md` and `docs/sdk/handoff.md` | #211 | DONE | `openapi-typescript` + `openapi-fetch` locked; downstream-first generation; rejected alternatives documented; drift-detection and generated-file policy documented. |
| P8 | T630–T634 | Validation: no `packages/sdk`, no `package.json` change, no generated files, no CI workflow | #211 | DONE | |
| P8 | T640–T642 | GATED-deferred future work (`packages/sdk` intro, in-repo CI drift detection, downstream generation) | None (correctly absent) | DEFERRED BY DESIGN | |

### P9 — Cross-Track Validation (T650–T659)

| Phase | Task ID(s) | Summary | Evidence PR(s) | Status | Notes |
|---|---|---|---|---|---|
| P9 | T650–T659 | Parallel-safe with 003, no catalog/POS/dashboard scope creep; foundation-endpoint and foundation-event-type choices confirmed | #212 | SUPERSEDED / STALE FOR RUNTIME STATUS | PR #212 is correct for the planning phase it covered (PRs #200–#211). It does not cover PRs #222–#242. This document is the authoritative runtime closeout. |

### Emergent PRs (no T### task mapping)

| PR | Title | Classification | Notes |
|---|---|---|---|
| #241 | `fix(api): close BullMQ queues on module destroy` | EMERGENT — lifecycle hardening | Fixes a pre-existing architectural gap: `AuditQueueProducer` and `EmailQueueProducer` lacked `OnModuleDestroy`, leaving background ioredis clients and reconnect timers open on shutdown. Discovered while stabilizing PR #240's CI db-integration runs. Not a regression introduced by #240. |
| #242 | `fix(api): defer BullMQ Queue construction in audit + email factories` | EMERGENT — override-orphan leak fix | Closes the override-orphan leak class that PR #241's `OnModuleDestroy` hook could not fix. Both producer factories now use a lazy `() => Queue` thunk instead of eagerly constructing at module-init time. Also discovered while stabilizing PR #240. |

---

## 4. Confirmed Remaining Backlog

### A — Operator Validation Only

These require a human operator running against a live (non-production) environment.
No code change is needed to unblock them.

1. **T437** — k6 smoke-run validation: execute
   `docker run --rm -v "$PWD/loadtests/k6:/scripts" grafana/k6:0.50.0 run /scripts/smoke.js --vus 1 --duration 5s`
   against a live non-prod stack and record the result.

*(T483 — Exercised-path operator evidence recorded in PR #265 against commit
`678baa47`. Verdict: **PASS for exercised API/worker/outbox paths**.
Full signal-catalogue live-scrape coverage remains open — see §4.C for the
explicit backlog. `docs/observability/operator-validation-report.md` holds
the scrape evidence and honest absences.)*

### B — Docs-Only Cleanup

These require only documentation changes; no source, schema, or contract changes.

1. **T524 path drift** — `tasks.md §8.3` references
   `packages/contracts/openapi/foundation/memberships.yaml` as the OpenAPI file
   for the idempotency contract. The actual file is
   `packages/contracts/openapi/memberships.openapi.yaml`. The contract itself is
   correct; only the task description is stale. Cleanup is a separate
   `docs(spec)` PR.

2. **T453 metric-label drift** — `plan.md §3.2.1` uses label names that differ
   from those in `docs/observability/signals.md`: `cause` vs `reason` (for
   `auth_failure_total`), `job_type` vs `job_name`, and `field_class` absent
   from `validation_failure_total`. Documented as non-blocking in PR #201 and
   PR #212. Cleanup is a separate `docs(spec)` PR; intentionally deferred from
   this PR.

3. **P9 report stale for runtime status** — `docs/production-readiness/004-cross-track-validation.md`
   covers the planning phase only. This document supersedes it for runtime
   status; no rewrite of the P9 report is required.

*(T565 redaction `it.todo` closure — closed by PR #255 on 2026-05-21; see §3 P7 / T565 row.)*

### C — Future Gated Runtime Implementation

These require a separate approval PR per `plan.md §5` and touch `apps/**`,
`packages/**`, DB schema, or OpenAPI contracts.

*(T595 / T596 — closed by PRs #251, #253, #259; see §3 P7 rows.)*
*(T597–T600 — closed by PR #262; see §11.)*

1. **T591 retry/requeue endpoint (1C-C2)** — Deferred by PR #240. Requires a
   `delivery_state` enum extension and a new `manual.outbox.replay` event-type
   registry entry.

2. **T591 acknowledge endpoint (1C-C3)** — Deferred by PR #240. Requires
   `acknowledged` as a new terminal state in the `delivery_state` enum.

3. **P4 full signal-catalogue live-scrape coverage (PARTIAL — explicit backlog)**

   The T483 exercised-path run (2026-05-21) proved a subset of signals. The
   following signals from `docs/observability/signals.md` have **not yet been
   live-proven** in a Prometheus scrape. They are categorised below by their
   current maturity tier:

   **Maturity tiers used in this table:**

   | Tier | Meaning |
   |---|---|
   | Registered | Instrument family created and bound to the OTel MeterProvider (definition only). |
   | Unit/allowlist-tested | Covered by a unit test or an allowlist-presence test; no live emission confirmed. |
   | Production-emitting | Emission call-site exists in merged source (PRs #248 / #251 / #253 / #259); exercised by real traffic in T483 run. |
   | Live-scraped (exercised) | Observed in a real `/metrics` scrape during the T483 operator run. |
   | Unwired / deferred | No `addCallback` or emission call-site wired yet; future slice required. |

   **P4 signal backlog — not yet live-scraped:**

   | Signal | Current tier | Blocker / note |
   |---|---|---|
   | `db_migration_status` | addCallback wired (PR #271) | `ApiDbMigrationStatusGaugeRegistrar` queries `_drizzle_migrations COUNT(*)` at scrape time; applied/pending/failed states; not yet live-scraped. |
   | `db_pool_in_use` | addCallback wired (PR #270) | `ApiDbPoolGaugeRegistrar` (API) + `WorkerDbPoolGaugeRegistrar` (worker) read synchronous pool counters; not yet live-scraped. |
   | `db_pool_waiters` | addCallback wired (PR #270) | Same registrars as `db_pool_in_use`; not yet live-scraped. |
   | `redis_command_duration_seconds` | Unwired / deferred | No ioredis instrumentation hook; last unwired instrument in the P4 catalogue. |
   | `queue_lag_seconds` | addCallback wired (PR #270) | `QueueLagGaugeRegistrar` wired against 5 BullMQ queues in worker; re-entrancy guard; lag clamped ≥ 0; not yet live-scraped. |
   | `db_slow_query_total` | Registered | No slow-query hook wired; threshold 500ms; not exercised in T483 run. |
   | `auth_failure_total` | Unit/allowlist-tested | Emission call-site exists; not live-proven — requires seeded user + specific failure path. |
   | `suspicious_login_total` | Unit/allowlist-tested | Emission call-site exists; not live-proven in T483 (requires multi-attempt suspicious pattern with seeded users). |
   | `tenant_context_failure_total` | Unit/allowlist-tested | Emission call-site exists; not live-proven — requires authenticated request with bad tenant context. |
   | `cross_tenant_rejection_total` | Unit/allowlist-tested (T475 PARTIAL) | Emission from `TenantContextGuard` not confirmed in merged PR evidence; not live-proven. |
   | `db_rls_context_failure_total` | Unit/allowlist-tested (T476 PARTIAL) | Emission from DB instrumentation hook not confirmed in merged PR evidence; not live-proven. |
   | `idempotency_replay_total` | Unit/allowlist-tested | Requires `POST /api/v1/memberships/invite` with `Idempotency-Key` + real authenticated context; out of scope for T483. |
   | `idempotency_conflict_total` | Unit/allowlist-tested | Same as above. |
   | `idempotency_in_progress_total` | Unit/allowlist-tested | Same as above. |

   A future operator-validation slice must exercise these paths and record scrape
   evidence to move P4 to DONE.

### D — Future Schema / Migration Work

These require a migration and explicit schema approval.

1. **Per-consumer `processed_events` projection table** — The `(consumer_id, event_id)`
   uniqueness constraint was deferred from Slice 1B (PR #234 design notes) and
   remains absent. Currently only row-level idempotency via `delivery_state =
   'delivered'` is enforced. A separate migration PR is required.

2. **Dedicated `platform:operator` role** — PR #240 uses `@PlatformAdminOnly()`
   as an interim gate. The dedicated `platform:operator` role requires schema-table
   changes excluded from T591's hard constraints. Deferred to a future
   role-foundation slice.

3. **`delivery_state` enum extension** — Required before retry/acknowledge
   endpoints (1C-C2, 1C-C3) can land. Adds `acknowledged` and/or a
   `manual_replay` state.

---

## 5. Emergent PRs — Context

PRs #241 and #242 were not part of any planned T### task in `tasks.md`.

While stabilizing PR #240 (T591 dead-letter triage endpoint, Slice 1C-C1),
CI db-integration runs failed with `worker process has failed to exit gracefully`.
The root cause was traced to a pre-existing architectural gap: the BullMQ
`Queue` instances backing `AuditQueueProducer` and `EmailQueueProducer` were
never closed on module teardown, leaving background ioredis clients and
reconnect timers open indefinitely.

**PR #241** (`fix(api): close BullMQ queues on module destroy`) added
`OnModuleDestroy` hooks to both producers. This fixed the graceful-exit failure
but not the override-orphan leak class — where a new `Queue` was constructed
eagerly at module-init time and then silently orphaned if the factory ran more
than once.

**PR #242** (`fix(api): defer BullMQ Queue construction in audit + email
factories`) closed that second class by converting both producer factories to
use a lazy `() => Queue` thunk, deferring construction to the first `enqueue()`
call. This resolved PR #240's CI db-integration failures definitively.

Neither PR introduced new feature surface, schema changes, OpenAPI changes, or
package changes. Both are independently revertable. They are recorded here
because they represent architectural hardening that postdates the tasks.md
planning artifact.

---

## 6. Next Recommended Slices

After the 2026-05-21 P7 closeout and T483 exercised-path operator evidence,
two operator-validation slices remain open, plus the P4 full-catalogue
coverage work:

### Option A — Operator Validation: k6 Smoke-Run (T437)

**Recommended when a live non-prod environment is available.**

Perform and record:
1. T437 — k6 smoke-run (5s, 1 VU, `grafana/k6:0.50.0`) against a live non-prod stack.

Deliverable: append a T437 subsection to
`docs/observability/operator-validation-report.md` recording the run
timestamp, environment, pass/fail, and any latency observations. No source
changes required.

### Option B — P4 Full Signal-Catalogue Live-Scrape (new slice)

P4 is **PARTIAL**. To move P4 to DONE, a future operator-validation slice
must live-exercise every signal in `docs/observability/signals.md` and
record scrape evidence for each. This requires:

1. **Wiring unwired instruments** (source change, separate gated PR):
   - ~~`db_migration_status` `addCallback`~~ — done (PR #271)
   - ~~`db_pool_in_use` / `db_pool_waiters` `addCallback`~~ — done (PR #270)
   - ~~`queue_lag_seconds` `addCallback`~~ — done (PR #270)
   - `redis_command_duration_seconds` ioredis hook — **remaining**

2. **Exercising unexercised paths** (operator run against a seeded environment):
   - Auth failures (seeded user + wrong password / blocked IP / expired token)
   - Suspicious login patterns
   - Authenticated cross-tenant request (exercises `cross_tenant_rejection_total`)
   - DB call missing `runWithTenantContext` (exercises `db_rls_context_failure_total`)
   - `POST /api/v1/memberships/invite` with `Idempotency-Key` (exercises `idempotency_*`)
   - Slow query exceeding 500ms threshold (exercises `db_slow_query_total`)

3. **Route label fix on exception-filter path** (`route="unknown"` follow-up).

Deliverable: a new section in `docs/observability/operator-validation-report.md`
(or a separate `operator-validation-report-p4-full.md`) recording scrape evidence
for each previously-absent signal. No source changes for items in (2) and (3)
above; gated source changes required for (1).

---

## 11. P7 Exit Gate Evidence (T597–T600)

This section records the empirical evidence supporting the T597–T600
exit-gate validation. Each subsection lists the invariant text from
`tasks.md`, the artifact(s) that prove it, and the command used to verify.

### 11.1 T597 — all P7 tests (T560–T566) pass GREEN

**Invariant**: every test under the T560–T566 task scope passes against a
live Postgres container and against the Docker-free fallback.

**Evidence**:
- Worker observability + outbox suites (Docker-free):
  `MIGRATION_TEST_ALLOW_SKIP=1 pnpm --filter @data-pulse-2/worker exec jest test/observability/ test/outbox/`
  → **9 suites, 198 passed, 0 todo, 0 failed**.
- Worker full suite (Docker-free):
  `MIGRATION_TEST_ALLOW_SKIP=1 pnpm --filter @data-pulse-2/worker test`
  → **23 suites, 486 passed, 0 todo, 0 failed**.
- API observability suite (Docker-free):
  `pnpm --filter @data-pulse-2/api exec jest test/observability/`
  → **8 suites, 215 passed, 0 failed**.
- Outbox Testcontainers suites (real Postgres via WSL Docker):
  - `apps/worker/test/outbox/retry-budget.spec.ts` — **12 / 12 passed**
    (verified in PR #259 validation).
  - `packages/db/__tests__/outbox/repository.dead-letter.spec.ts -t 'BYPASSRLS'`
    — **3 / 3 BYPASSRLS-tagged passed** (see §11.4).
- T565 redaction closure: `apps/worker/test/outbox/redaction.spec.ts`
  → **21 passing, 0 todo** (PR #255).

### 11.2 T598 — cross-tenant + cross-store sweep from 001 still passes

**Invariant**: the FR-ISO-4 cross-tenant probe suite from spec 001 returns
the same GREEN result after the P7 work as it did before — no outbox-path
introduces a cross-tenant read or write that the sweep would surface.

**Evidence**:
- `apps/api/test/authz/cross-tenant.sweep.spec.ts` against real Postgres
  via WSL Docker — **10 / 10 passed** (run on 2026-05-21).
- Outbox additions (PR #251, #253, #255, #259) touched only:
  - Worker-side processors with try/catch/finally around existing logic
    (no new HTTP routes).
  - Drainer's existing decision branches (no new SQL surface).
  - ObservableGauge addCallback running under platform-admin
    `runWithTenantContext` — identical RLS contract to the drainer's
    existing `claimBatch`.
  - Logger redaction (`packages/shared/src/logger/pino.ts` add-only paths).
  None of these reach the API routes the cross-tenant sweep exercises.

### 11.3 T599 — no catalog-specific event types added; only `audit.event.created`

**Invariant**: the outbox event-type registry has exactly one entry, the
canonical `audit.event.created`. No catalog-adjacent event types (e.g.
`catalog.product.created`) have been introduced.

**Evidence**:
- Single source of truth: `packages/db/src/outbox/producer.ts:51`
  ```ts
  export const OUTBOX_EVENT_TYPES = {
    AUDIT_EVENT_CREATED: "audit.event.created",
  } as const;
  export type OutboxEventType =
    typeof OUTBOX_EVENT_TYPES[keyof typeof OUTBOX_EVENT_TYPES];
  ```
- `OutboxEmitInput.eventType: OutboxEventType` — producer-side compile-time
  guard. A catalog event type cannot be emitted without first widening
  this const.
- Consumer-side literal pin:
  `apps/worker/src/outbox/consumers/audit-event-created.consumer.ts:110`
  `readonly eventType = "audit.event.created";`
- Retention policy literal pin: `apps/worker/src/outbox/retention.policy.ts:53`.
- Grep across `packages/db/src/`, `apps/api/src/`, `apps/worker/src/` finds
  zero `catalog.*` event-type strings.
- Runtime guard test: `packages/db/__tests__/outbox/event-types-registry.spec.ts`
  (NEW in THIS PR) — **6 cases passing**, asserting:
  - `Object.values(OUTBOX_EVENT_TYPES)` has exactly one entry,
  - the single value is `"audit.event.created"`,
  - the key set is exactly `{ AUDIT_EVENT_CREATED }`,
  - explicit "no catalog.* event types" defensive check against the
    five most-plausible catalog-adjacent names.

### 11.4 T600 — no `BYPASSRLS` privilege granted to any runtime role

**Invariant**: the runtime DB role (`app_role` in production, `app_test`
in Testcontainers) MUST NOT hold the `BYPASSRLS` privilege.
Cross-tenant access for the drainer / outbox retention is gained via
GUC-based platform-admin context (`app.is_platform_admin = 'true'`), not
by role privilege.

**Evidence**:
- Migration `packages/db/drizzle/0006_outbox_events.sql:178` source comment:
  `-- No BYPASSRLS is granted to any role by this migration (T600 /
  Constitution II).`
- Runtime probe (real Postgres via WSL Docker):
  `packages/db/__tests__/outbox/repository.dead-letter.spec.ts -t 'BYPASSRLS'`
  → **3 / 3 BYPASSRLS-tagged passed** (suite DL-6). Includes:
  - `it("app_role does NOT hold BYPASSRLS (probes pg_roles)")` at line 855.
- Catalog migration probe: `packages/db/__tests__/migration/0001-catalog.spec.ts:317`
  → `expect(bypassCheck.rows[0]?.rolbypassrls).toBe(false);`
- T566 RLS privilege test (Slice 1A, PR #233) — same surface.

### 11.5 P7 exit-gate verdict

All four T597–T600 invariants are **satisfied** against a real Postgres
container as of 2026-05-21. T483 exercised-path operator evidence was
recorded on the same day — scrape evidence in
`docs/observability/operator-validation-report.md` with verdict **PASS for
exercised API/worker/outbox paths**. This closes every in-scope item under
Spec 004 **P7 (outbox first slice)**. P4 full signal-catalogue live-scrape
coverage remains **PARTIAL** — see §4.C for the explicit backlog.

---

*End of closeout status.*
