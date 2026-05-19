# 004 Platform Production Readiness — Closeout Status

**Feature ID**: 004
**Feature name**: Platform Production Readiness
**Date**: 2026-05-19
**Author**: Ahmed Shaaban
**Constitution**: v3.0.0

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
| P4 — Observability instrumentation | B | **PARTIAL / NEEDS OPERATOR VALIDATION** | Redaction and structured logging wired; metric definitions registered; live `/metrics` scrape not yet operator-validated. |
| P5 — Idempotency | D | **DONE** | Strategy docs and full implementation for `POST /api/v1/memberships/invite` merged. |
| P6 — Outbox design validation | C | **DONE** | All four outbox design docs merged; spike branches not merged to main (correct). |
| P7 — Outbox first slice | C | **PARTIAL** | Schema, drainer, producer, consumer, retention, and DI swap all merged. Metrics emission (T595/T596), per-consumer dedup projection, and admin write endpoints remain open. |
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
| P4 | T483 | Live `/metrics` operator scrape validation | #229 (unblocks), #227 (BLOCKED at time) | NEEDS OPERATOR VALIDATION | PR #229 provides the runtime prerequisite (`/metrics` endpoint wired). Live scrape against API + worker not yet operator-recorded. |

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
| P7 | T565 | Worker logger redaction test | #235 | PARTIAL | 10 passing + 5 `it.todo` — gaps for `actor_label` and `payload.metadata` PII fields documented in PR #235; not yet closed. |
| P7 | T590 | Retention cleanup processor (daily, batch 1000, 90d/365d) | #236 | DONE | `retention.processor.ts`, `retention.policy.ts`, `drizzle-outbox-retention.repository.ts`, `retention.worker.ts`, `retention.scheduler.ts` all present. |
| P7 | T591 | Dead-letter triage admin endpoint | #240 | PARTIAL | Read-only `GET /api/v1/admin/outbox/dead-letters` (list + detail) done. Payload column never projected. `last_error` exposed only as sanitized `last_error_class`. `@PlatformAdminOnly()` gate enforced. **Retry/requeue (1C-C2), acknowledge (1C-C3), and dedicated `platform:operator` role all deferred**. |
| P7 | T595–T596 | Emit `outbox_pending_total`, `outbox_dead_letter_total`, `outbox_drain_duration_seconds`, `queue_retry_total`, `queue_dead_letter_total` from drainer | None | NOT DONE | Metrics are **defined** in `apps/worker/src/observability/metrics/worker.metrics.ts` (explicitly commented "registered as definitions only") but **no emission calls** exist in `drainer.processor.ts` or related paths. Confirmed by grep. |
| P7 | T597–T600 | P7 exit-gate validation (all P7 tests GREEN, cross-tenant sweep, no catalog event types, no BYPASSRLS) | None | NOT DONE | No exit-gate validation PR recorded for P7. |

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

2. **T483** — Live `/metrics` scrape validation: confirm every signal from
   `docs/observability/signals.md` is present when scraping the running API and
   worker processes. PR #229 provides the runtime prerequisite; the operator
   recording is still outstanding.

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

4. **T565 redaction `it.todo` closure** — PR #235 left 5 `it.todo` stubs for
   `actor_label` and `payload.metadata` PII fields (`email`, `phone`,
   `full_name`, `note`). These gaps need a follow-up redaction-matrix amendment
   and corresponding test closure.

### C — Future Gated Runtime Implementation

These require a separate approval PR per `plan.md §5` and touch `apps/**`,
`packages/**`, DB schema, or OpenAPI contracts.

1. **T595/T596** — Outbox metrics emission: wire actual `.add()` / `.record()`
   calls into `drainer.processor.ts` and related paths for `outbox_pending_total`,
   `outbox_dead_letter_total`, `outbox_drain_duration_seconds`, `queue_retry_total`,
   and `queue_dead_letter_total`. Metric definitions already exist; emission is absent.

2. **T591 retry/requeue endpoint (1C-C2)** — Deferred by PR #240. Requires a
   `delivery_state` enum extension and a new `manual.outbox.replay` event-type
   registry entry.

3. **T591 acknowledge endpoint (1C-C3)** — Deferred by PR #240. Requires
   `acknowledged` as a new terminal state in the `delivery_state` enum.

4. **T597–T600** — P7 exit-gate validation suite: all P7 tests GREEN,
   cross-tenant sweep, no catalog event types, no `BYPASSRLS`. No validation PR
   has been recorded.

5. **Remaining P4 emission tasks** — Any P4 signal tests and emission tasks not
   yet confirmed in merged evidence: `cross_tenant_rejection_total` emission from
   `TenantContextGuard` (T475), `db_rls_context_failure_total` emission from a
   DB instrumentation hook (T476), and any outstanding signal-presence test suites
   (T460, T463–T466 completeness).

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

## 6. Next Recommended Slice

Two candidate next slices are ready to open. **Do not combine them.**

### Option A — Operator Validation Slice

**Recommended if a live non-prod environment is available.**

Perform and record:
1. T437 — k6 smoke-run (5s, 1 VU, `grafana/k6:0.50.0`) against a live non-prod stack.
2. T483 — Live `/metrics` scrape: confirm all signals from
   `docs/observability/signals.md` appear in the running API and worker.

Deliverable: a `docs/observability/operator-validation-report.md` (or similar)
recording the run timestamp, environment, pass/fail results, and signal list.
No source changes required. Low risk, high value for closing two outstanding
NEEDS OPERATOR VALIDATION items.

### Option B — P7 Metrics Emission Pre-Flight (T595/T596)

**Recommended if runtime work is the priority.**

Produce a pre-flight plan for wiring actual metric emission calls into the
outbox drainer paths. The metric definitions are already registered in
`apps/worker/src/observability/metrics/worker.metrics.ts`; the gap is the
absence of `.add()` / `.record()` calls in `drainer.processor.ts`,
`retention.processor.ts`, and related paths. This slice requires a separate
[GATED] approval PR before implementation.

---

*End of closeout status.*
