<!--
Sync Impact Report
==================
Version change: 1.0.0 → 2.0.0
Bump rationale: MAJOR — repository identity redefined from "dbt/data-pipeline" to
                "multi-tenant SaaS rebuild with separate POS repo". Principles
                redefined, dbt content demoted to a dedicated sub-section.

Modified principles:
  I.   Reference, Not Source of Truth                     (kept, scope unchanged)
  II.  DataGraph-Driven dbt Architecture                  → REMOVED as core principle;
                                                            content folded into
                                                            "Analytics and Data Pipeline
                                                            Standards" section.
  III. Test-First Data Quality                            → BROADENED to "Test-First Quality"
                                                            (now covers API, workers,
                                                            sync, frontend, analytics).
  IV.  Observable Pipelines                               → BROADENED to "Observable Systems"
                                                            (APIs, workers, sync jobs,
                                                            scheduled jobs, analytics).
  V.   Reproducible & Versioned Transformations           → BROADENED to "Reproducible &
                                                            Versioned Releases" (services,
                                                            migrations, API versions).

Added principles:
  II.  Multi-Tenant SaaS by Default
  III. Backend Authority & Data Integrity
  IV.  Contract-First POS Integration
  V.   Async Work Belongs in Workers

Added sections:
  - Repository Scope (this repo vs POS repo)
  - Multi-Tenancy Standards
  - POS Integration Contract Standards
  - Backend Authority & Data Integrity
  - Async Work & Background Jobs
  - Analytics and Data Pipeline Standards (demoted from top-level focus)

Removed sections:
  - "dbt Architecture Standards" as top-level section (content preserved under
    "Analytics and Data Pipeline Standards").

Templates requiring updates:
  ⚠ pending  .specify/templates/plan-template.md  (not yet created — generate via /speckit-plan)
  ⚠ pending  .specify/templates/spec-template.md  (not yet created — generate via /speckit-specify)
  ⚠ pending  .specify/templates/tasks-template.md (not yet created — generate via /speckit-tasks)
  ⚠ pending  .specify/templates/constitution-template.md (mirror should be re-synced to v2.0.0)

Follow-up TODOs:
  - Define the canonical tenant/account/store data model in an early spec.
  - Decide and document POS API versioning scheme (path-based vs header-based) in spec.
  - Document chosen worker stack (e.g., Celery / RQ / Sidekiq / BullMQ) in plan.
  - Define sync conflict resolution policy (last-write-wins, vector clock, manual) per entity.
-->

# Data-Pulse-2 Constitution

Data-Pulse-2 is the **main multi-tenant SaaS rebuild** for Data Pulse. It owns the
backend API, admin/dashboard frontend, central database, and all server-side business
logic. The POS application lives in a separate repository and integrates exclusively
through documented, versioned, authenticated API contracts.

## Core Principles

### I. Reference, Not Source of Truth
The legacy `Data-Pulse` repository (https://github.com/ahmed-shaaban-94/Data-Pulse) is
reference material **only**. Code, architecture, models, naming, schemas, and
configurations from it MUST NOT be copied verbatim. Every carry-over MUST be
re-justified against this Constitution and re-spec'd via `/speckit-specify` before
implementation. The legacy repo, when cloned for inspection, MUST live under
`/reference/` and MUST be listed in `.gitignore` so it never enters version control.

**Rationale**: The rebuild exists because the legacy repo accumulated unreviewed
decisions. Treating it as a source of truth would import the very debt the rebuild is
meant to shed.

### II. Multi-Tenant SaaS by Default
This codebase is multi-tenant from day one. Every tenant-owned entity (users, stores,
products, inventory, orders, reports, etc.) MUST be scoped by `tenant_id` (and where
applicable `store_id`) at the database, query, and API layers. There is no
"single-tenant fast path." Tenant scoping MUST be:
- Enforced at the **database layer** via foreign keys and (where supported) row-level
  security or equivalent constraints — not only by application code.
- Enforced at the **API layer** via authenticated session/token claims that resolve to
  a tenant context; cross-tenant access requires an explicit, audited admin path.
- Verified in tests. Every endpoint touching tenant-owned data MUST have at least one
  cross-tenant isolation test asserting that tenant A cannot read or mutate tenant B.

**Rationale**: Tenant data leakage is the highest-severity bug class for SaaS.
Defense in depth (DB + app + tests) is the only safe default.

### III. Backend Authority & Data Integrity (NON-NEGOTIABLE)
The backend is the sole authority for business state. Specifically:
- **Authorization is server-side.** Frontend or POS-side checks are UX hints, never
  security boundaries. Every protected operation MUST be re-authorized on the server.
- **Database constraints protect invariants.** Uniqueness, foreign keys, NOT NULL,
  check constraints, and migrations MUST encode business rules — application-only
  validation is insufficient.
- **Redis / caches are never the source of truth.** Caches MUST be reconstructible
  from Postgres. Any flow that requires the cache to be authoritative MUST be
  redesigned.
- **Migrations are forward-compatible and reviewed.** Destructive migrations require
  an explicit rollout plan in the PR description.

**Rationale**: Frontend-only checks, cache-as-truth, and "we'll add the constraint
later" are the three patterns most likely to corrupt SaaS data permanently.

### IV. Contract-First POS Integration
The POS app is a separate repository and a separate trust boundary. All integration
MUST flow through APIs that are:
- **Documented** — OpenAPI (or equivalent) checked into this repo and kept in sync.
- **Versioned** — breaking changes require a new version; old versions remain
  supported for a documented deprecation window.
- **Authenticated** — every POS request carries a verifiable credential (per-device
  token or short-lived JWT) tied to a tenant + store + device identity.
- **Idempotent on writes** — POS sync submissions (orders, inventory adjustments,
  payments) MUST accept an idempotency key and MUST be safe to retry. Duplicate POS
  events MUST be tolerated without double-applying state.
- **Conflict-aware** — for any entity that can be edited both by the backend and by
  an offline POS client, the conflict resolution policy (last-write-wins, version
  vector, manual reconciliation, etc.) MUST be specified **before** implementation
  and recorded in the entity's spec.

**Rationale**: The POS is offline-first and unreliable by design. The backend cannot
assume "exactly once" delivery, in-order arrival, or the absence of stale clients.

### V. Async Work Belongs in Workers
Anything that doesn't need to complete inside a request MUST run in a background
worker. This includes (non-exhaustive): webhook delivery, POS sync processing,
report generation, billing/subscription side-effects, email/SMS, large imports/exports,
and scheduled jobs. Worker code MUST:
- Be **idempotent and retry-safe** with explicit retry/backoff policies.
- **Surface failures** — dead-letter queues or equivalent, with alerting.
- **Never silently swallow exceptions.** A failed job is a visible event.

API request handlers MUST stay focused on validation, authorization, and synchronous
state changes; they delegate the rest.

**Rationale**: Coupling slow/unreliable work to user requests is the fastest path to
cascading outages and timeouts.

### VI. Test-First Quality
Tests are written **before** the implementation merges. Coverage targets:
- Backend API: integration tests per endpoint covering happy path, auth failure,
  cross-tenant isolation, and at least one negative-path case.
- Workers: unit tests for job logic + at least one retry/idempotency test.
- POS-facing endpoints: contract tests that verify the OpenAPI schema and idempotency
  behavior.
- Frontend: component tests for stateful UI; E2E tests for critical admin flows
  (login, tenant onboarding, billing if applicable).
- Analytics models: see "Analytics and Data Pipeline Standards" below.
- Overall line coverage: ≥80% for application code; PRs that lower coverage without
  Constitution-level justification MUST be rejected.

**Rationale**: A multi-tenant SaaS without tests becomes unrefactorable within one
quarter. Tests are the only durable specification.

### VII. Observable Systems
Every API, worker, sync job, scheduled job, and analytics pipeline MUST emit:
- **Structured logs** (JSON or key=value) with `tenant_id`, `request_id`/`job_id`,
  and operation context. No bare `print()` in production paths.
- **Metrics** for request rate, error rate, latency (p50/p95/p99), queue depth (for
  workers), and job success/failure counts.
- **Traceable failures** — exit codes, dead-letter queues, or run-summary records;
  silent partial-success is forbidden.
- **No secrets in logs.** Tokens, passwords, payment data, and PII MUST be redacted.

Secrets MUST come from environment variables or a secret manager — never hardcoded,
never committed.

**Rationale**: Multi-tenant systems fail per-tenant in ways that aggregate metrics
hide. Per-tenant observability is the only way to debug and bill correctly.

### VIII. Reproducible & Versioned Releases
Every service MUST be reproducible from a checked-out commit plus a documented
environment (`requirements.txt` / `pyproject.toml` / `package.json` lockfile,
container image tag, infra config). Schema-affecting changes ship as numbered
migrations with a `CHANGELOG.md` entry. API breaking changes ship as a new API
version. One-off scripts that mutate data MUST be checked in under
`scripts/oneoff/` with a dated filename and a header comment stating purpose,
date, operator, and rollback plan.

**Rationale**: Reproducibility is the floor for incident response. "It worked on
my machine" and undocumented hotfixes are the leading causes of long-tail incidents.

## Repository Scope

### This repository (Data-Pulse-2) owns
- SaaS backend API
- Dashboard / admin frontend
- Tenant, account, and store management
- Users, roles, permissions, and authentication
- Central PostgreSQL database (source of truth)
- Product catalog (source of truth)
- Inventory (source of truth)
- Central orders / sales records (source of truth)
- Background workers
- Billing / subscriptions (if applicable)
- Reports and analytics
- POS sync APIs
- Webhooks and external integrations
- Deployment and infrastructure configuration

### The POS repository owns
- POS user interface
- Offline / local-first behavior
- Local device storage
- Local cart and checkout flow
- Local sync client
- Device-level error handling

### The trust boundary
All communication between this SaaS backend and the POS app MUST happen through
documented, versioned, authenticated API contracts. Direct database access from
the POS, shared filesystems, or undocumented endpoints are forbidden.

## Multi-Tenancy Standards

- Every tenant-owned table MUST include `tenant_id` (and `store_id` where applicable)
  with a NOT NULL constraint and an index suitable for tenant-scoped queries.
- All ORM/query helpers MUST default to tenant-scoped queries; "raw" cross-tenant
  queries require an explicit override and are forbidden in request handlers.
- Authentication tokens MUST encode (or resolve to) a tenant context. A request
  without a resolvable tenant context is rejected at the auth layer.
- Admin / superuser flows that legitimately span tenants MUST be auditable: every
  cross-tenant action writes an audit log entry with actor, target tenant, action,
  and timestamp.
- Tenant deletion / suspension MUST be reversible for a documented retention window
  before any hard delete.

## POS Integration Contract Standards

- **API style**: REST + JSON (default). Deviations require a spec.
- **Versioning**: explicit version segment (e.g., `/api/pos/v1/...`) or header. New
  versions ship additively; breaking changes never reuse an existing version.
- **Auth**: per-device credentials issued by the backend; revocable; tied to a
  tenant + store + device. Long-lived shared secrets are forbidden.
- **Idempotency**: every write endpoint accepts an `Idempotency-Key` header; replays
  return the prior result without re-applying state.
- **Schema**: request/response schemas live in OpenAPI (or equivalent) checked into
  this repo and published to the POS team.
- **Sync semantics**: each sync entity has a documented conflict-resolution policy
  and a documented "what happens on duplicate event" rule.
- **Backwards compatibility**: a deprecation window of at least one POS release
  cycle for any version sunset, communicated in writing.

## Backend Authority & Data Integrity

- Postgres is the system of record. Every other store (Redis, search index, object
  storage, analytics warehouse) is rebuildable from Postgres.
- Foreign keys are mandatory for relationships; orphaned rows are a defect.
- Money, tax, and inventory math MUST use exact-decimal types — never floats.
- Migrations MUST be reviewed for: lock duration on large tables, backward
  compatibility with running services, and a rollback plan.
- Background data-correction scripts MUST be idempotent and committed under
  `scripts/oneoff/` per Principle VIII.

## Async Work & Background Jobs

- A worker stack (queue + worker process) is part of the baseline platform, not an
  add-on. Document the chosen stack in the project plan.
- Job handlers MUST be small, idempotent functions with explicit input contracts.
- Long-running jobs MUST emit progress (heartbeats or progress records) so they can
  be monitored and recovered.
- Webhook delivery is a worker concern — never inline in a request handler.
- Scheduled jobs (cron-equivalent) MUST be checked into the repo, not configured by
  hand on a server.

## Analytics and Data Pipeline Standards

Analytics is a supporting concern of this repository, not its primary identity. When
analytics work happens here:

- **Layering**: `staging → intermediate → marts`. Cross-layer skips require
  justification in the model's spec.
- **Naming**: `stg_<source>__<entity>`, `int_<purpose>`, `<domain>__<entity>` for marts.
- **Materialization defaults**: `view` for staging, `table` for intermediate,
  `incremental` or `table` for marts (justify `incremental` strategy in the model
  config).
- **DataGraph for big lineage**: any model whose lineage exceeds **5 upstream sources**
  OR **3 transformation layers** MUST have a lineage artifact (dbt docs DAG export,
  Mermaid diagram, or equivalent) committed under `docs/lineage/` and referenced
  from the model's spec. Long lineage chains and fan-out joins MUST be decomposed
  via the graph so each node remains independently testable.
- **Tests**: dbt models ship with at minimum `unique` + `not_null` on the grain key,
  plus relationship and accepted-values tests where applicable.
- **Tenant scoping**: analytics that surface tenant data MUST preserve tenant
  isolation end-to-end; do not strip `tenant_id` in transformation layers unless
  the mart is explicitly cross-tenant aggregate-only.

These standards apply equally to non-dbt analytics tooling (Python notebooks,
SQL scripts) where relevant.

## Governance

This Constitution supersedes ad-hoc conventions and prior-repo habits. All PRs MUST
include a "Constitution Check" line in the description identifying which principles
the change touches. PRs that violate a principle MUST either (a) bring the change
into compliance, or (b) propose an amendment in the same PR with version bump and
rationale.

**Amendment procedure**:
1. Open a PR that edits `.specify/memory/constitution.md` and increments the version.
2. Update the Sync Impact Report comment at the top.
3. Propagate changes to `.specify/templates/*.md` and any agent guidance files.
4. Merge requires explicit acknowledgement that dependent artifacts were reviewed.

**Versioning policy** (semantic):
- **MAJOR**: Backward-incompatible removal or redefinition of a principle/section,
  or a redefinition of repository identity.
- **MINOR**: New principle or materially expanded section.
- **PATCH**: Clarifications, wording fixes, non-semantic edits.

**Compliance review**: A lightweight review of constitution adherence SHOULD occur at
the close of each milestone or quarterly, whichever comes first. Findings feed back
into amendments.

**Version**: 2.0.0 | **Ratified**: 2026-05-01 | **Last Amended**: 2026-05-01
