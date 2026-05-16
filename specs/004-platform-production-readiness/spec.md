# Feature Specification: Platform Production Readiness

**Feature ID**: 004
**Short name**: platform-production-readiness
**Status**: Clarified (planning / specification only — no implementation)
**Created**: 2026-05-16
**Clarified**: 2026-05-16
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.0
**Parallel-safe with**: 003-catalog-foundation (planning), future catalog implementation

---

## 1. Background & Why

Data-Pulse-2 Foundation (001) is complete: tenant/store context, RLS, auth,
memberships, invitations, audit foundations, and POS integration seams are in
place. POS Operator Identity (002) and Catalog Foundation (003) define how
identity and product source-of-truth work, but neither covers the platform's
operational maturity.

Before the platform is asked to carry real retail workloads — catalog,
inventory, sales, refunds, reporting, POS sync — five cross-cutting capabilities
must be **specified, agreed, and gated** so that future implementation slices
can land safely, independently, and without retrofits:

1. **Load testing** — knowing whether the API, workers, database, and queues
   can carry expected tenant/store traffic before promising it to customers.
2. **Production observability** — being able to see, in production, what the
   API, database, Redis, BullMQ, and workers are actually doing, in a
   vendor-neutral way that doesn't leak PII or secrets.
3. **Outbox pattern** — preventing the silent-data-divergence failure mode
   where a DB transaction commits but the event meant to drive async work is
   never published.
4. **Idempotency middleware** — making selected mutating APIs safe to retry,
   so POS, dashboard, and integration clients can recover from transient
   failures without double-charging, double-creating, or double-deleting.
5. **OpenAPI SDK generation** — generating typed API clients from the
   `packages/contracts/openapi/` source of truth instead of letting dashboard,
   POS, and future integration repos hand-roll request shapes that drift.

This feature is **specification-only**. No runtime code, no schema, no
migrations, no OpenAPI changes, no `package.json` changes, no `pnpm-lock.yaml`
changes, no CI changes, no generated files. Each track defines what future
gated implementation work must achieve and the criteria under which it can be
approved.

This feature directly operationalizes Constitution §2 (RLS / cross-tenant
safety must be load-tested and observable), §3 (Backend Authority — idempotent
retries are part of integrity), §5 (Async Work in Workers — outbox is the
durability backbone), §7 (Observable Systems), §8 (Reproducible & Versioned
Releases — gated implementation slices), §11 (Idempotency & External IDs), and
§14 (PII redaction at the logger boundary).

---

## 1.5 Clarifications

### Session 2026-05-16

The three open questions filed in §15.1 are resolved by these decisions.
Their effects are integrated into the affected sections (§8, §9, §10) and
functional requirements (FR-C-*, FR-D-*, FR-E-*). The corresponding
`[NEEDS CLARIFICATION]` markers in §15.1 are replaced with the locked
decisions.

- **Q (Track D — in-progress idempotency behavior)**: When a retry arrives
  while the original request is still in flight (same `(tenant, route,
  Idempotency-Key)` tuple, original not yet completed), what does the
  platform return?
  **A**: `425 Too Early`.
  - Communicates clearly that the first request has not yet completed.
  - Avoids falsely treating the second request as a business-level conflict
    (which `409 Conflict` would imply).
  - Is safer for retrying clients and future POS integrations than
    block-and-replay, because it does not tie up a server connection
    waiting on the original.
  - The response body MUST NOT leak cross-tenant or cross-store information
    (the existing safe-404 / uniform-error-envelope rules apply).
  - The behavior MUST be documented as retryable by clients — the client
    SHOULD wait briefly and retry the same key.
  - Integrated into §9.2.3 (replaces the "behavior MUST be explicitly
    defined" placeholder), §9.4 FR-D-004, and the relevant SC in §14.4.

- **Q (Track C — outbox retention window)**: What is the retention window
  for outbox events?
  **A**: Split policy.
  - **Processed (successfully delivered) outbox events**: retain for **90
    days**. Sufficient for operational debugging and short-window replay;
    keeps storage bounded.
  - **Failed, dead-lettered, poison, or audit-relevant outbox events**:
    retain for **365 days**, unless a later overarching data-retention
    policy (Constitution §14) supersedes. Failed/dead-lettered events need
    longer forensic visibility for incident review and compliance trail.
  - Retention MUST respect PII / data-lifecycle discipline: PII contained
    in event payloads is subject to right-to-erasure regardless of the
    90/365 windows; erasure redacts payload contents in place without
    deleting the immutable event-occurred fact.
  - Any implementation that adds schema, migrations, cleanup jobs, TTL
    indexes, or retention processors remains **gated** (FR-C-006).
  - Integrated into §8.2.6 (replaces the "explicit, documented window"
    placeholder with the 90/365 values), §8.4 FR-C-004, and §14.3.

- **Q (Track E — SDK generator + initial output location)**: Which
  generator is the default direction, and where does the generated client
  live in the first implementation slice?
  **A**: TypeScript-first lightweight default; no in-repo SDK package yet.
  - **Generator**: `openapi-typescript` for the generated TypeScript types
    plus `openapi-fetch` for the typed client calls. Lightweight,
    tree-shakeable, no heavy build dependency, no Java toolchain
    requirement.
  - **Initial output location**: **NOT** `packages/sdk` in the first
    implementation slice. The SDK strategy is documented first (this spec
    + future `research.md`); no SDK files are generated during the
    spec/plan phase. `packages/sdk` is revisited only after the dashboard
    and POS contract-consumption needs are stable, and only after explicit
    approval to introduce `package.json` / `pnpm-lock.yaml` /
    generated-file changes.
  - This decision keeps the repo lightweight, avoids package / lock /
    generated-file churn while contracts are still evolving, preserves
    OpenAPI contracts as the single source of truth, and lets future
    dashboard and POS repositories adopt the generated client on their
    own schedule without coupling to this monorepo's release cadence.
  - Integrated into §10.3 (locks the directional preference to
    `openapi-typescript` + `openapi-fetch`), §10.4 (the in-repo
    `packages/sdk` row gains a "not for first slice" annotation), §10.5
    (no SDK generation in the spec/plan phase), §10.6 FR-E-003, and §14.5.

These three decisions resolve all `[NEEDS CLARIFICATION]` markers from
§15.1. The §15.2 non-blocking research items remain open and will be
addressed in `research.md` during `/speckit-plan`.

---

## 2. Goals

- Define the four classes of **load testing** the platform must support
  (smoke, baseline, stress, regression), the candidate flows to measure, and
  the success measures each load test must report.
- Define vendor-neutral **observability requirements** for the API, database,
  Redis, BullMQ, and workers, including required redaction constraints.
- Define the future **transactional outbox** behavior, lifecycle, and gating
  rules without authoring any schema or worker implementation.
- Define future **HTTP idempotency** behavior for selected mutating endpoints,
  including replay, conflict, cross-tenant, in-progress (`425 Too Early`),
  and expiry semantics.
- Define decision criteria for future **OpenAPI SDK generation** —
  `openapi-typescript` + `openapi-fetch` as the directional default, with
  no in-repo `packages/sdk` in the first slice.
- Define the actors, scenarios, edge cases, non-goals, and parallelism
  contract with 003-catalog-foundation.
- Enumerate the open questions whose answers must be locked before any
  individual track moves to implementation. (All three §15.1 markers are
  resolved as of 2026-05-16 — see §1.5.)

## 3. Non-Goals

The following are **explicitly excluded** from this feature. Any work in these
areas requires a separate feature spec and explicit approval.

### 3.1 Implementation-scope exclusions
- No application code (NestJS modules, services, controllers, guards,
  interceptors, middleware, workers, queue processors).
- No `data-model.md`, `contracts/*.yaml`, `tasks.md`, or `quickstart.md` in
  this PR. (Those land in subsequent gated PRs per track.)
- No DB schema, Drizzle schema, SQL migrations, or RLS policy changes.
- No new OpenAPI files or modifications to existing OpenAPI files.
- No `package.json` changes, no `pnpm-lock.yaml` changes, no new dependencies.
- No CI workflow changes.
- No generated files (typed clients, OpenAPI bundles, k6 scripts checked into
  the repo, dashboards-as-code) authored in this PR.
- No changes under `apps/**` or `packages/**` source trees.

### 3.2 Domain-scope exclusions
- No catalog implementation. Catalog observability/load/idempotency hooks are
  enumerated as *future expectations* only; their adoption is owned by future
  catalog implementation features.
- No POS application work. POS integrates only through documented APIs and
  remains a separate repository.
- No dashboard UI, no dashboard implementation.
- No billing, pricing tiers, plans, invoicing, or revenue features.
- No reports, analytics dashboards, or business intelligence work.
- No dbt, no ClickHouse, no Dagster, no warehouse modeling.
- No external deployment infrastructure (Kubernetes manifests, Terraform,
  Helm charts, cloud provider configuration).

### 3.3 Track-scope exclusions
- No specific vendor selection for observability (OTel Collector vs.
  Prometheus/Grafana vs. managed vendor) — the spec stays vendor-neutral.
- No specific load-testing tool lock-in beyond a directional preference for
  external k6 scripts. Selection is a research item in `plan.md`.
- The chosen SDK generator (`openapi-typescript` + `openapi-fetch`) is a
  *directional default*; alternative generators (orval, openapi-generator,
  hey-api/openapi-ts) remain comparison inputs in `research.md`. Final
  generator + output-location *implementation* is still gated (§10.5).
- No global idempotency rollout. First slice must be narrow.
- No outbox-driven catalog event topology. That belongs to future catalog
  features that adopt the outbox contract.
- No `packages/sdk` introduction in the first SDK slice.

---

## 4. Actors

| Actor | Description |
|---|---|
| **Platform Operator** | Operates the SaaS platform. Reads observability signals, runs load tests, decides when stress thresholds gate releases, owns the load-test environment and observability backend. |
| **Backend Developer** | Authors API endpoints, workers, and migrations within this repo. Consumes observability to debug; emits required signals from new code; respects the idempotency and outbox contracts. |
| **Future Dashboard Developer** | Builds the SaaS dashboard in a separate repository. Consumes the OpenAPI contracts (and, once produced, the generated typed client). Has no DB access. |
| **Future POS Integration Developer** | Builds the POS application (separate repo) or third-party POS integrations. Consumes OpenAPI contracts and the idempotency contract for retry-safe mutations. Has no DB access. |
| **Tenant Admin** | A real tenant-side user. Indirect actor only — affected by p95/p99 latency, retry safety, and observability quality, but does not interact with any of the five tracks directly. |
| **System Worker** | The BullMQ worker process. Reads outbox events, establishes tenant context, processes domain events idempotently, retries on failure, dead-letters on poison. Emits queue/worker observability signals. |
| **Reviewer / Maintainer** | Reviews PRs that touch this feature's track implementations. Owns the approval gate: blocks any PR that violates the non-goals, attempts global idempotency on the first slice, ungates schema/migrations/package files without approval, or risks PII/secret leakage. |
| **Anonymous / unauthenticated** | No access. Authentication failures, suspicious-login signals, and rate-limit signals MUST still be observable for this actor class (Track B). |

The POS Application itself is not an actor in this spec — it is a downstream
consumer of the contracts that result from this work.

---

## 5. Parallelism Contract with 003-catalog-foundation

This feature is designed to run **in parallel** with 003-catalog-foundation
planning and its eventual implementation, subject to the following hard
constraints:

### 5.1 What this feature MUST NOT do
- MUST NOT change any catalog schema (Global Product Index, Tenant Catalog,
  Store Override, Product Alias, Price History, Unknown Item Workflow, future
  SaleLine Snapshot).
- MUST NOT modify any catalog OpenAPI contract.
- MUST NOT introduce any catalog implementation code (controllers, services,
  workers, queue processors).
- MUST NOT define catalog-specific outbox event types, catalog-specific load
  scenarios that depend on unbuilt catalog tables, or catalog-specific
  idempotency keys.
- MUST NOT introduce a dependency that forces 003 to ship before any track of
  004 can ship.

### 5.2 What this feature MAY do
- MAY define **future expectations** that catalog implementation can adopt
  (e.g., "future write endpoints SHOULD honor the idempotency contract",
  "future async catalog events SHOULD use the outbox", "future catalog
  endpoints SHOULD emit standard API observability signals").
- MAY enumerate catalog flows as **candidate** load-test targets without
  authoring those load tests now.
- MAY use existing foundation endpoints (auth, tenant context, memberships,
  audit) as the *first* concrete subjects for any pilot implementation slice
  in a later gated PR.

### 5.3 Conflict-resolution rule
If, during the lifetime of this feature, an implementation slice would force a
change to catalog schema or catalog contracts, that slice MUST be paused and
re-scoped, or deferred until after the relevant catalog feature lands. The
parallelism contract is non-negotiable: production-readiness work must not
become a back door for catalog changes.

### 5.4 Reviewer obligation
Reviewers of any PR claiming to land a slice of feature 004 MUST verify the
PR diff against §5.1 before approving. A PR that violates §5.1 fails review
regardless of code quality.

---

## 6. Track A — Load Testing

### 6.1 Purpose
Give the platform a defensible, repeatable way to answer questions like
"can we promise this customer 50 stores and 200 concurrent operators?" and
"did the latest change regress p95 on tenant reads?" — before learning the
answer in production.

### 6.2 Load test classes (MUST support all four)

| Class | Purpose | Frequency | Pass/fail gating |
|---|---|---|---|
| **Smoke** | Cheapest possible run; proves the load-test harness, environment, auth, and tenant context all work end-to-end. Minimal RPS, short duration. | Every PR that touches the load-test harness. | Must complete without errors; latencies not gated. |
| **Baseline** | Known-good steady-state run at expected production load. Establishes the reference numbers (p50/p95/p99, error rate, RPS, DB pressure, queue lag) the platform aims to hold. | At least once per release candidate; ideally nightly once stable. | p95/p99/error-rate thresholds (defined per release) MUST be met. |
| **Stress** | Push beyond expected load until the platform degrades; identify the breakpoint. Used for capacity planning, not as a release gate. | On demand, before major capacity decisions or new tenant onboarding waves. | Not a pass/fail gate; produces a breakpoint report. |
| **Regression** | Compare a candidate build's baseline numbers to a stored historical baseline; fail if any tracked metric regresses beyond an agreed delta. | Per release candidate. | Tracked-metric deltas MUST be within the agreed regression budget. |

### 6.3 Candidate flows to measure
The first implementation slice SHOULD cover at least these candidate flows.
The candidate list is **not** the full final list — additional flows (catalog,
inventory, sales, POS sync) get added by their owning features.

- Authentication (login, token refresh, logout).
- Active tenant/store context establishment for an authenticated principal.
- Tenant-scoped reads (e.g., "list my memberships", "get current tenant").
- Store-scoped reads (e.g., "list stores I have access to").
- Membership mutations (invite, accept, revoke).
- Audit-heavy governance actions (role grants, role revocations, store
  attach/detach) — these stress the audit-write path.

### 6.4 Required success measures (per scenario, per run)
Each load test run MUST report at minimum:

- HTTP request latency: p50, p95, p99.
- HTTP error rate (separated 4xx vs. 5xx).
- Requests per second sustained and peak.
- Database pressure indicators: connection pool utilization, slow-query
  count, transaction-rollback rate.
- Redis latency (p50, p95).
- BullMQ queue lag (oldest waiting job age) per queue exercised.
- Worker job duration (p50, p95) per job type exercised.

A run that does not produce these measures is not a valid load test and
MUST NOT be used to claim a baseline or sign off a release.

### 6.5 Implementation gating
- The first implementation slice MUST be safe and lightweight. The
  directional preference is **external k6 scripts** run outside the application
  process, against a non-production environment, without adding any runtime
  dependency to `apps/api`, `apps/worker`, or any `packages/**`.
- The first slice MUST NOT add new dependencies to `package.json`, MUST NOT
  introduce `pnpm-lock.yaml` changes, MUST NOT add CI workflows, and MUST NOT
  create files under `apps/**` or `packages/**`. (Scripts may live outside
  those paths; exact location is a `plan.md` decision.)
- Any decision to embed load-test dependencies in the monorepo, integrate
  results into CI, or expose load-test results in product surfaces requires
  explicit approval and a follow-up gated PR.

### 6.6 Track A functional requirements

- **FR-A-001**: The platform MUST support smoke, baseline, stress, and
  regression load test classes as defined in §6.2.
- **FR-A-002**: Each load test class MUST have a clearly documented purpose,
  pass/fail gating rule, and execution frequency before the first
  implementation slice merges.
- **FR-A-003**: Load tests MUST be executable against a non-production
  environment that mirrors production's RLS, tenant context, and auth
  behavior.
- **FR-A-004**: Each load test run MUST report all measures listed in §6.4.
- **FR-A-005**: Baseline load tests MUST establish numeric thresholds for
  p95, p99, and error rate **before** they are used as a release gate.
- **FR-A-006**: Regression load tests MUST compare against a stored prior
  baseline using an explicit, documented delta budget per tracked metric.
- **FR-A-007**: Load tests MUST NOT be run against the production database,
  production Redis, or production queues.
- **FR-A-008**: Load tests MUST use synthetic tenants and synthetic stores;
  they MUST NOT use real customer tenant identifiers.
- **FR-A-009**: Load tests MUST exercise multiple tenants concurrently so
  cross-tenant RLS isolation is part of the measured behavior, not bypassed
  by single-tenant runs.
- **FR-A-010**: Load test scripts MUST authenticate via the same auth path
  real clients use; they MUST NOT bypass `AuthGuard`, `TenantContextGuard`,
  or `RolesGuard`.
- **FR-A-011**: The first implementation slice MUST be lightweight per §6.5
  and MUST NOT introduce package dependency changes.
- **FR-A-012**: Any expansion of load-test scope into `apps/**`, `packages/**`,
  `package.json`, `pnpm-lock.yaml`, or CI MUST be a separate gated PR.

---

## 7. Track B — Production Observability

### 7.1 Purpose
Make the API, database, Redis, BullMQ, and workers observable in production
with vendor-neutral signals, and lock in PII/secret redaction as a
non-negotiable constraint at the logger boundary.

### 7.2 Vendor neutrality
The observability surface MUST remain compatible with at least:

- An **OpenTelemetry Collector** deployment (traces + metrics + logs).
- A **Prometheus + Grafana** deployment (scraped metrics + log shipping
  separately).
- A **managed observability vendor** (Datadog, New Relic, Honeycomb, etc.)
  that consumes OTel or Prometheus output.

No track design or signal definition may assume one specific vendor's
features (proprietary tag dimensions, vendor-specific APM agents, vendor-only
sampling controls). Vendor *selection* is deliberately out of scope here.

### 7.3 Required API signals
The API surface MUST expose at minimum:

- Request count (labeled by route, method, status class).
- Request duration p95 and p99 (per route, per method).
- 4xx and 5xx rate (per route).
- Authentication failures (separated by cause: bad password, bad token,
  expired token, missing credentials, rate-limited).
- Tenant context failures (missing context, invalid context, cross-tenant
  attempt rejected at the boundary).
- Validation failures (request body / query / header rejected by Zod or
  equivalent validation).
- Suspicious login attempts (rapid retries, brute-force pattern, geographic
  anomaly if available — the *signal*, not the detection algorithm).
- Cross-tenant rejection count (requests that were rejected because they
  attempted to act outside the authenticated principal's tenant).
- **Idempotency signals** (per Track D §9.4 FR-D-010): replay count,
  conflict count (`409`), in-progress collision count (`425`).

### 7.4 Required database signals
The database layer MUST expose at minimum:

- Connection pool pressure (in-use vs. max, waiters).
- Slow-query indicator (count of queries exceeding a documented threshold).
- RLS context failures (queries that ran without a tenant context having
  been established — a signal that something bypassed the guard).
- Migration status (pending migrations, last successful migration, last
  failed migration if any).

### 7.5 Required Redis / BullMQ / worker signals
The async layer MUST expose at minimum:

- Queue lag (oldest waiting job age) per queue.
- Failed jobs (per queue, per error class if cheaply classifiable).
- Dead-letter count (jobs that exceeded retry budget and were moved to
  dead-letter / failed permanent state).
- Retry count (per job, per queue).
- Job duration (p50 and p95 per job type).
- Worker processing failures (worker crashes, unhandled exceptions, worker
  shutdown count).

### 7.6 Redaction constraints (non-negotiable)
The logger boundary MUST enforce all of the following:

- MUST NOT log passwords (raw or hashed) in any form.
- MUST NOT log bearer tokens, API keys, session cookie values, or refresh
  tokens.
- MUST NOT log database credentials, Redis credentials, queue credentials,
  webhook signing keys, or any other secret material.
- MUST NOT log PII payload dumps (full request bodies containing names,
  emails, phone numbers, addresses).
- MUST NOT log full request bodies by default; structured field-by-field
  logging is allowed only after explicit field-level redaction review.
- MUST NOT log full response bodies by default.
- MUST redact at the logger boundary, not at call sites — a single
  documented redaction policy applied uniformly is required; "remember to
  redact" instructions in code review are not sufficient.
- MUST treat the redaction policy as **add-only** by default — adding a
  new sensitive field never breaks existing log analysis, but removing one
  requires an audit.

### 7.7 Cardinality discipline
- Metrics MUST NOT use `tenantId` or `storeId` as a high-cardinality label
  by default. Tenant/store granular breakdowns are a tracing/log concern, not
  a metrics-cardinality concern.
- Per-tenant metric exposure (e.g., "show me p95 for tenant X") is an
  intentional, explicitly-approved exception, not a default.

### 7.8 Track B functional requirements

- **FR-B-001**: The platform MUST emit all API signals listed in §7.3.
- **FR-B-002**: The platform MUST emit all database signals listed in §7.4.
- **FR-B-003**: The platform MUST emit all Redis / BullMQ / worker signals
  listed in §7.5.
- **FR-B-004**: Structured logs MUST include `request_id`, `tenant_id` (when
  established), `store_id` (when established), `actor_id` (when
  authenticated), and `correlation_id` for async work.
- **FR-B-005**: Logs MUST honor every redaction constraint in §7.6.
- **FR-B-006**: Metrics MUST honor the cardinality discipline in §7.7.
- **FR-B-007**: The observability stack MUST remain vendor-neutral per §7.2;
  no signal definition may depend on a specific commercial vendor.
- **FR-B-008**: A cross-tenant rejection MUST produce a discrete observable
  signal (counter increment + log entry) so attempted RLS bypass cannot fail
  silently.
- **FR-B-009**: An RLS context failure (DB access attempted without tenant
  context) MUST produce a discrete observable signal and MUST be alertable.
- **FR-B-010**: Workers MUST emit observability signals **after** establishing
  tenant context, so signals are correctly attributed.
- **FR-B-011**: The redaction policy MUST be documented in a single
  reviewable artifact and MUST be the single source of truth.
- **FR-B-012**: Any new signal that increases label cardinality beyond
  current limits MUST be reviewed for cardinality impact before merge.

---

## 8. Track C — Outbox Pattern

### 8.1 Purpose
Eliminate the silent-failure class where a database transaction commits but
the event meant to drive downstream async work (worker job, webhook,
notification, projection update) is never published, or vice versa — a
transaction is rolled back but an event was already emitted.

The outbox makes event emission part of the same transaction as the state
change, then drains the outbox asynchronously to the queue. This is a
**future** capability; no schema, no code, no migration is authored here.

### 8.2 Required future behavior

#### 8.2.1 Durable event recording
- Domain events MUST be persisted in the same database transaction as the
  state change that produced them.
- Event records MUST carry, at minimum: a stable event identifier, an event
  type, a payload, the originating tenant, the originating store (when
  applicable), an `occurredAt` timestamp, and a `correlationId`.
- Event records MUST be append-only at the application layer; updates to
  delivery status (claimed, delivered, failed, dead-lettered) are tracked
  separately from the immutable event content.

#### 8.2.2 Tenant / store / correlation context
- Events MUST carry the tenant identifier (and store identifier when the
  originating operation was store-scoped).
- Events MUST carry the `correlationId` from the originating request or job
  so end-to-end tracing across API → outbox → worker remains intact.
- Workers consuming outbox events MUST establish tenant context from the
  event before touching the database (per Constitution §2 and §5).

#### 8.2.3 Retry semantics
- The outbox drainer MUST retry transient publication failures with bounded
  exponential backoff.
- A retry budget MUST be defined per event type (or globally with explicit
  exceptions); events that exceed the budget MUST be dead-lettered, not
  retried forever.
- Retry counts MUST be observable per Track B.

#### 8.2.4 Poison event handling
- An event that consistently fails processing (poison event) MUST be moved
  to a dead-letter state after the retry budget is exhausted.
- Dead-lettered events MUST be visible to operators with enough context
  (tenant, store, type, last error, correlation) to triage — *without*
  exposing PII / secret payload contents per §7.6.
- The platform MUST NOT silently drop poison events.

#### 8.2.5 Idempotent processing
- Consumers of outbox events MUST be idempotent: re-processing the same
  event MUST NOT cause duplicate side effects (double notifications, double
  charges, double inserts).
- Consumers MUST treat the event identifier as the deduplication key and
  MUST record the fact of processing in a way that survives worker restarts.

#### 8.2.6 Retention *(clarified 2026-05-16 — see §1.5)*
- Outbox event retention follows a **split policy**:
  - **Processed (successfully delivered) events**: retained for **90 days**
    from the `processedAt` timestamp, then eligible for purge.
  - **Failed, dead-lettered, poison, or audit-relevant events**: retained
    for **365 days** from the latest failure / dead-letter / classification
    timestamp, unless an overarching data-retention policy (Constitution
    §14) imposes a shorter or longer window.
- These windows are operational defaults; they MUST be revisable if a
  future data-retention policy spec supersedes them, but the spec change
  is the only way to alter them — not ad-hoc per-event overrides.
- Retention MUST respect Constitution §14 (PII & Data Lifecycle
  Discipline): PII contained in event payloads MUST be subject to the
  right-to-erasure flow regardless of the 90/365 windows. Erasure
  redacts payload contents in place; the immutable "event occurred"
  fact remains for audit purposes.
- Soft-delete is the default; hard purge is a separate, audited action
  governed by the data-retention policy.
- Cleanup processes (TTL indexes, scheduled purge jobs, retention
  processors) are **gated** implementation work per §8.3 / FR-C-006.

#### 8.2.7 Safe logging / redaction
- Outbox emission, drain, retry, and dead-letter log lines MUST honor the
  Track B redaction policy in §7.6. Event payloads MUST NOT be logged in
  full by default.

### 8.3 Implementation gating
- All DB schema additions, SQL migrations, production source changes, and
  worker implementation tasks for the outbox are **gated** and require
  explicit approval in a separate feature spec / PR.
- The first implementation slice (once approved) SHOULD target a single,
  narrow event type — ideally an existing audit-emitting flow from feature
  001 — so the outbox contract is proven on familiar ground before catalog,
  inventory, or sales adopt it.
- The outbox table, the drainer worker, and the consumer interface are each
  separate gated artifacts; they MUST NOT be authored in this PR.

### 8.4 Track C functional requirements

- **FR-C-001**: The platform MUST define a future outbox-pattern contract
  covering durable event recording, retry, poison handling, idempotent
  processing, retention, and redaction (§8.2.1–§8.2.7).
- **FR-C-002**: Outbox events MUST carry tenant context, store context
  (when applicable), and `correlationId`.
- **FR-C-003**: Outbox-consuming workers MUST establish tenant context
  before any DB access.
- **FR-C-004**: Outbox event retention MUST follow the split policy
  defined in §8.2.6 — **90 days** for processed events, **365 days** for
  failed/dead-lettered/poison/audit-relevant events — and MUST respect PII
  lifecycle rules. The 90/365 windows are revisable only via a spec
  change.
- **FR-C-005**: Poison events MUST be dead-lettered and observable, never
  silently dropped.
- **FR-C-006**: Outbox-related schema, migrations, production code, worker
  code, TTL indexes, cleanup jobs, and retention processors are gated and
  require separate explicit approval before any implementation PR.
- **FR-C-007**: The first outbox implementation slice MUST target a single
  narrow event type, not all events platform-wide.
- **FR-C-008**: Outbox event payloads MUST NOT be logged in full by default;
  the Track B redaction policy applies.

---

## 9. Track D — Idempotency Middleware

### 9.1 Purpose
Allow POS clients, dashboard clients, and integration clients to retry
mutating HTTP requests safely after transient failures, without producing
duplicate side effects. Operationalizes Constitution §11 (Idempotency &
External IDs).

### 9.2 Scope of HTTP idempotency

#### 9.2.1 Header
- The idempotency header is `Idempotency-Key`.
- Keys are opaque strings supplied by the client; the platform MUST NOT
  generate or interpret structure within the key.
- Keys are scoped per `(tenant, route)` for collision purposes — see §9.2.4.

#### 9.2.2 Methods in scope
- `POST` is the primary target.
- `PATCH` is in scope.
- `DELETE` is in scope **only** for specific endpoints where idempotency
  adds value beyond HTTP's existing "delete is naturally idempotent"
  semantics (e.g., resource creation-side-effects on delete). Endpoint
  inclusion is per-endpoint, not global.
- `GET`, `HEAD`, `OPTIONS`, `PUT` are **out of scope** for this contract.
  (`PUT`'s idempotency is its HTTP semantic; `GET` etc. are safe.)

#### 9.2.3 Required behavior

| Situation | Required response |
|---|---|
| Same tenant + same route + same `Idempotency-Key` + same request payload | Replay the original response (same status code, same body, same response headers semantically equivalent). |
| Same tenant + same route + same `Idempotency-Key` + **different** request payload | Reject with `409 Conflict`. The client has reused a key for a different request — that is a client bug, not a retry. |
| Same `Idempotency-Key` across **different** tenants | MUST NOT collide. Keys are tenant-scoped; one tenant's reuse of another tenant's key is processed as a new request. |
| Request currently in progress (same `(tenant, route, key)`, original request not yet completed) | Respond `425 Too Early` *(clarified 2026-05-16 — see §1.5)*. The response MUST NOT block on the original; MUST NOT leak cross-tenant or cross-store information; MUST be documented as **retryable** — clients SHOULD wait briefly and retry the same key. |
| Expired `Idempotency-Key` (outside retention window) | Treated as a brand-new request. No replay. |
| Missing `Idempotency-Key` on an in-scope endpoint | Behavior is per-endpoint: some endpoints MAY require the header (reject with `400 Bad Request` if missing); others MAY treat missing-header as opting out of idempotency replay. Per-endpoint policy is documented in the OpenAPI contract for that endpoint. |

#### 9.2.4 Key scoping
- Replay matching MUST consider `(tenant, route, key)` as the dedup tuple
  (not just `key` alone).
- A different `(method, route)` with the same key is a different
  `(tenant, route, key)` tuple and does not collide.
- The payload hash is part of the **comparison** for the conflict rule, not
  part of the scoping tuple.

#### 9.2.5 Retention
- Replay retention MUST have an explicit, documented window (e.g., 24h or
  72h). Exact value is a research item in `plan.md`.
- Retention storage MUST honor the Track B redaction policy: stored replay
  bodies that contain PII MUST be subject to PII lifecycle rules.

### 9.3 Rollout gating
- Idempotency MUST NOT be applied globally in the first implementation
  slice. A global default would risk regressing endpoints that have not been
  reviewed for idempotency semantics (e.g., audit-emitting flows).
- The first slice MUST target **one narrow endpoint**, chosen for being
  retry-safe by design and having low blast radius. Candidate first
  endpoint: a foundation membership or invitation mutation.
- Expansion to additional endpoints is per-endpoint and requires explicit
  approval.

### 9.4 Track D functional requirements

- **FR-D-001**: The platform MUST honor the `Idempotency-Key` header on
  in-scope mutating endpoints per §9.2.
- **FR-D-002**: Replay matching MUST be `(tenant, route, key)`-scoped;
  cross-tenant key reuse MUST NOT collide.
- **FR-D-003**: A reused key with a **different** payload on the same route
  in the same tenant MUST be rejected with `409 Conflict`.
- **FR-D-004**: In-progress request behavior is **locked to `425 Too
  Early`** *(clarified 2026-05-16 — see §1.5)*. The response MUST NOT
  block on the original; MUST NOT leak cross-tenant or cross-store
  information; MUST be documented as **retryable** by clients.
- **FR-D-005**: Expired keys MUST behave as a new request, not a replay.
- **FR-D-006**: Replay retention windows MUST be documented; retained
  payloads MUST honor PII lifecycle rules.
- **FR-D-007**: Idempotency MUST NOT be enabled globally in the first
  implementation slice; the first slice MUST target one narrow endpoint.
- **FR-D-008**: Each in-scope endpoint MUST declare its idempotency policy
  (required, optional, or N/A) in its OpenAPI contract.
- **FR-D-009**: Idempotency MUST NOT change authorization, RLS, or tenant
  context behavior. A replayed response is replayed only because the
  *original* request was authorized; a new authorization decision is not
  reused across requests.
- **FR-D-010**: Idempotency state MUST emit observability signals (replay
  count, `409` conflict count, `425` in-progress collision count) per
  Track B §7.3.

---

## 10. Track E — OpenAPI SDK Generation

### 10.1 Purpose
Generate typed API clients from the `packages/contracts/openapi/` source of
truth so dashboard, POS, and future integrations stop hand-rolling request
shapes that drift from the contract — and so the contract itself becomes the
forcing function for cross-repo type safety.

### 10.2 Candidate generators to compare (research, not selection)
The research artifact for this track MUST compare at least:

- `openapi-typescript` *(directional default — see §10.3)*
- `openapi-fetch` *(directional default — see §10.3)*
- `orval`
- `openapi-generator` (the polyglot Java-based generator)
- `hey-api/openapi-ts`

Comparison MUST cover at minimum:

- TypeScript-first ergonomics and output quality.
- Build-time vs. install-time generation, and offline reproducibility.
- License and maintenance health.
- Output size and tree-shakeability.
- Support for `Idempotency-Key` and other custom headers required by
  Track D.
- Support for tenant/store context headers required by foundation.
- Handling of OpenAPI 3.1 features used by `packages/contracts/openapi/`.
- Output destination flexibility (multiple consumers, in-repo vs.
  out-of-repo).

### 10.3 Directional preference *(clarified 2026-05-16 — see §1.5)*
- **Locked direction**: `openapi-typescript` (for generated types) +
  `openapi-fetch` (for the typed client calls). Lightweight,
  tree-shakeable, no heavy build dependency, no Java toolchain
  requirement, and TypeScript-native — matching the platform's stack.
- A heavier generator (e.g., `openapi-generator`, `orval`,
  `hey-api/openapi-ts`) is on the table **only** if research surfaces a
  concrete blocker against `openapi-typescript` + `openapi-fetch`. The
  justification MUST be written down in `research.md` and re-approved
  before adoption.
- This directional preference is a planning decision. Generator
  adoption — meaning actual generation, package introduction, or
  generated artifacts in any repo — remains gated per §10.5 / FR-E-002.

### 10.4 Candidate output locations
The generated client MAY live in any of the following locations. Selection
is a research decision and a gated implementation decision.

| Location | When this fits | First-slice eligibility |
|---|---|---|
| Internal `packages/sdk` in this monorepo | When the same client is consumed by future internal apps within this repo (admin tools, internal scripts), and gating cost (new package, new build target, new lockfile entries) is justified. | **NOT eligible for the first slice** *(clarified 2026-05-16 — see §1.5)*. `packages/sdk` is revisited only after dashboard/POS contract-consumption needs stabilize and after explicit approval to introduce `package.json` / `pnpm-lock.yaml` / generated-file changes. |
| Generated client published outside this repository | When the same client is consumed by multiple external repos (dashboard, POS, integrations) and a single versioned artifact is preferable. | Eligible once a publishing target exists; still gated. |
| Dashboard-specific client in the dashboard repository | When the dashboard's needs diverge from POS's needs and a shared SDK would introduce coupling without benefit. | Eligible at dashboard-repo's own pace; not driven by this repo's slices. |
| POS-specific client in the POS repository | When POS's client needs (e.g., embedded device constraints, custom retry logic) diverge from dashboard's needs. | Eligible at POS-repo's own pace; not driven by this repo's slices. |

### 10.5 Gating contract *(reinforced 2026-05-16 — see §1.5)*
- No future PR may add `package.json` entries, modify `pnpm-lock.yaml`,
  introduce generated files into this repo, or create an SDK package
  without explicit approval.
- **No SDK files are generated during the spec/plan phase**. The first
  deliverable under Track E is a documented SDK-generation strategy
  (this spec, plus `research.md` once `/speckit-plan` runs) — not any
  generated artifact.
- The chosen generator (`openapi-typescript` + `openapi-fetch` per §10.3)
  and the chosen output location MUST each be re-confirmed and approved
  in a separate gated PR before generation occurs.
- Generated artifacts MUST NOT be hand-edited; the OpenAPI contract is the
  source of truth, and the generator must be re-runnable to reproduce the
  artifact bit-for-bit (or within an explicitly tolerated formatter delta).
- A drift-detection mechanism (a check that re-generates and diffs) is a
  future deliverable; the exact mechanism (CI, pre-commit, manual) is a
  research item.

### 10.6 Track E functional requirements

- **FR-E-001**: The platform MUST compare the candidate generators in
  §10.2 against the criteria in §10.2 before the first implementation
  slice confirms a final selection; the directional default per §10.3 is
  `openapi-typescript` + `openapi-fetch`.
- **FR-E-002**: Generator confirmation, output location, and generated-file
  introduction are each separate gated approval decisions; no PR in this
  feature 004 spec authors generator config or generated files.
- **FR-E-003**: The chosen approach is TypeScript-first by default —
  specifically `openapi-typescript` + `openapi-fetch` per §10.3
  *(clarified 2026-05-16 — see §1.5)*. Exceptions require a written
  blocker justification in `research.md`.
- **FR-E-004**: Generated clients MUST respect the `Idempotency-Key`
  contract (Track D, including the `425 Too Early` in-progress response)
  and the tenant/store context contract (foundation 001).
- **FR-E-005**: Generated artifacts MUST NOT be hand-edited.
- **FR-E-006**: Drift between generated client and OpenAPI source MUST be
  detectable; the detection mechanism is a research item, but the
  *capability* is required.
- **FR-E-007**: Any change to `package.json`, `pnpm-lock.yaml`, or the
  introduction of generated files into this repository is **gated** and
  requires explicit approval. **The first SDK implementation slice MUST
  NOT introduce `packages/sdk`** *(clarified 2026-05-16 — see §1.5)*.
- **FR-E-008**: Output location is a per-consumer decision; this feature
  MUST NOT lock all consumers into a single location prematurely.

---

## 11. User Scenarios

These scenarios describe how each actor exercises the resulting capabilities
once the relevant tracks are implemented in future gated PRs. The scenarios
are **acceptance-flavored**; full per-PR test plans live in `tasks.md`.

### 11.1 Operator: baseline traffic capacity check
**Given** the baseline load test has documented p95/p99/error-rate thresholds
for an upcoming release,
**When** the platform operator runs the baseline load test against the
release candidate environment,
**Then** the run produces all measures listed in §6.4, the pass/fail gating
rule in §6.2 is applied, and the release proceeds or is blocked accordingly.

### 11.2 Developer: tenant-context failure investigation
**Given** a backend developer suspects a tenant-context failure on a recent
deploy,
**When** they query observability for tenant-context failure signals
(§7.3 + §7.4),
**Then** they can locate the failing requests by `request_id`,
`correlation_id`, and route, see the structured log entry without
encountering any PII / secret material (§7.6), and reproduce the failure
from a non-production environment.

### 11.3 Worker: safe retry of an async event
**Given** the outbox is in place and a worker processed an event but failed
to acknowledge it,
**When** the worker is re-invoked with the same event identifier,
**Then** the consumer's idempotent processing rule (§8.2.5) ensures no
duplicate side effects, the retry count metric increments (§7.5), and the
event is eventually marked delivered or dead-lettered after the retry
budget is exhausted (§8.2.4). The 90/365-day retention policy (§8.2.6)
keeps successful events for 90 days and failure/dead-letter records for
365 days for forensic visibility.

### 11.4 Client: retry-safe mutating request
**Given** a client (POS, dashboard, or integration) calls a mutating
endpoint that is in the idempotency scope (§9.2.2), with an
`Idempotency-Key`,
**When** the client times out and retries with the same key and same
payload,
**Then** the original response is replayed (§9.2.3, row 1) and no duplicate
side effect occurs. If the client retries with the same key but a different
payload, the platform responds `409 Conflict` (§9.2.3, row 2). If the
client retries while the original is still in flight, the platform responds
`425 Too Early` (§9.2.3, row 4) and the client waits briefly before
retrying.

### 11.5 Dashboard / POS developer: typed contract consumption
**Given** the OpenAPI SDK generation track has produced a typed client via
`openapi-typescript` + `openapi-fetch` (§10.3),
**When** a future dashboard or POS developer writes a feature that calls a
backend endpoint,
**Then** they import the generated client (from its eventual output
location — *not* `packages/sdk` in the first slice; see §10.4), get
compile-time type safety on request shapes and response shapes, and need
not hand-roll any request type. Drift from the OpenAPI source is
detectable per §10.5.

### 11.6 Reviewer: non-interference verification
**Given** a PR claims to land a slice of feature 004,
**When** a reviewer opens it,
**Then** the diff is verifiable against §5.1 (no catalog schema, no catalog
contracts, no catalog implementation), against §3.1 (no implementation
scope creep), and against the per-track gating rules (§6.5, §8.3, §9.3,
§10.5). A PR that violates any of these — including a first-slice attempt
to introduce `packages/sdk` — fails review regardless of code quality.

---

## 12. Edge Cases

Edge cases the spec must address — and that any future implementation slice
must explicitly cover in its test plan:

### 12.1 Cross-tenant idempotency key collision
Tenant A and tenant B independently choose the same `Idempotency-Key`
string for the same route. Behavior: MUST NOT collide. Replay matching is
`(tenant, route, key)`-scoped (§9.2.4). Two independent mutations occur.

### 12.2 Replay with changed payload
A client retries with the same `Idempotency-Key` but a modified body
(e.g., the user changed a form value before retry). Behavior:
`409 Conflict` (§9.2.3, row 2). The original mutation MUST NOT be silently
overridden, and the second payload MUST NOT be silently dropped without
the client knowing.

### 12.3 Queue publish failure after successful DB transaction
The DB transaction commits but the queue publish call fails (Redis
hiccup, network partition). Without the outbox, the work is lost.
Behavior: with the outbox in place, the event is durably recorded as part
of the same transaction; the drainer retries publication; the work is not
lost (§8.2.1, §8.2.3).

### 12.4 Worker retry causing duplicate side effects
A worker successfully performs a side effect (notification sent, downstream
call made) but crashes before acknowledging the job. Behavior: consumer
must be idempotent (§8.2.5); processing-fact recording must survive worker
restarts so the second invocation detects the prior processing and skips
the side effect.

### 12.5 Observability accidentally logging PII
A new endpoint is added that takes a request body containing PII (email,
phone, address). Behavior: the logger boundary MUST redact at boundary,
not at the call site (§7.6). Adding an endpoint MUST NOT require the
endpoint author to remember to redact — the policy is centralized.

### 12.6 Metrics cardinality explosion
A developer adds `tenantId` as a metric label "just to see per-tenant
numbers." Behavior: this MUST be rejected at review per §7.7 / FR-B-012.
Per-tenant breakdowns are a tracing/log concern by default. Per-tenant
metric exposure requires explicit approval.

### 12.7 SDK drift from OpenAPI source
A reviewer hand-edits a generated client to "fix" something. Behavior:
FR-E-005 forbids it. The fix belongs in the OpenAPI contract; the
generator is re-run; drift detection (FR-E-006) flags the discrepancy
before merge.

### 12.8 Load tests producing misleading results
A load test runs against an empty or trivially-small dataset and reports
flattering p95 numbers that won't hold at real-tenant scale. Behavior:
FR-A-003 requires the load environment to mirror production's RLS, tenant
context, and auth behavior; FR-A-009 requires multiple concurrent tenants
so cross-tenant isolation is exercised. A run that doesn't satisfy these
MUST NOT be used to claim a baseline.

### 12.9 Catalog work depending on production-readiness assumptions too early
A catalog implementation PR assumes "the outbox exists" or "this endpoint
is idempotent" before the relevant track has shipped. Behavior: per §5.1
and §5.2, catalog adoption of these capabilities is **future expectation**
language only. Catalog MUST NOT block on this feature's implementation,
and this feature MUST NOT block catalog. If a catalog PR has a hard
dependency on a 004 capability that hasn't shipped, the catalog PR is
re-scoped to not depend on it (e.g., by emitting the event directly to the
queue without the outbox, then migrating to the outbox in a later slice
once the outbox lands).

### 12.10 Authentication failure storm vs. legitimate user
A burst of auth failures could be a brute-force attack or a legitimate
client with a misconfigured token. Behavior: the auth-failure and
suspicious-login signals (§7.3) MUST be discrete and labeled by cause
(bad password, bad token, expired token, rate-limited) so operators can
distinguish them. The signal itself is in scope; the detection algorithm
is not (that belongs to a future security feature).

### 12.11 Worker without tenant context
A worker job somehow starts processing without first establishing tenant
context (e.g., a developer skipped the helper). Behavior: the DB layer's
RLS-context-failure signal (§7.4, FR-B-009) MUST fire on the first DB
call, and the failure MUST be alertable. This is one of the highest-value
observability invariants — silent loss of RLS context would compromise
multi-tenant isolation.

### 12.12 Outbox retention vs. right-to-erasure
A tenant exercises right-to-erasure (§14 of the Constitution) on a record
whose original mutation produced outbox events that still contain PII.
Behavior: §8.2.6 / FR-C-004 — outbox retention (90 days for processed,
365 days for failed/dead-lettered) MUST respect PII lifecycle. The
erasure flow MUST be capable of redacting / removing PII from
outbox-retained payloads without violating audit immutability (i.e., the
*fact* the event happened remains; the PII payload is redacted in place,
even before the 90/365-day window naturally elapses).

### 12.13 Idempotency retry during in-flight original
A client times out and retries an `Idempotency-Key`-bearing request
*while* the original request is still being processed by the server.
Behavior: `425 Too Early` (§9.2.3 row 4, FR-D-004). The response MUST
NOT block on the original (no held connection), MUST NOT leak any
cross-tenant / cross-store information, and MUST be documented as
retryable so a well-behaved client waits briefly and re-issues the same
key — at which point the request either replays the now-completed
response (row 1) or — if the original failed and was not stored as a
replayable record — proceeds as a new request.

---

## 13. Key Entities (conceptual only — no schema)

These entities describe **future** state. No schema, no migration, no code
is authored here. They exist to give downstream `data-model.md` work a
shared vocabulary.

| Entity | Purpose | Notes |
|---|---|---|
| **Load Test Run** | A single execution of a smoke/baseline/stress/regression load test. Captures measures from §6.4, environment metadata, and pass/fail outcome. | Conceptual — first implementation may store runs only as external k6 reports without a DB-backed entity. |
| **Baseline Reference** | The numeric thresholds (p95, p99, error rate) that a baseline run must meet to be considered "passing." | Used by regression tests as the comparison anchor. |
| **API Signal** | A named, vendor-neutral metric or log signal exposed by the API per §7.3. | Includes labels permitted by §7.7. |
| **Database Signal** | A named, vendor-neutral metric or log signal exposed by the DB layer per §7.4. | |
| **Worker Signal** | A named, vendor-neutral metric or log signal exposed by the worker / queue layer per §7.5. | |
| **Redaction Policy** | The single source-of-truth document describing what fields are redacted at the logger boundary per §7.6. | Add-only by default. |
| **Outbox Event** | A durable record of a domain event, persisted in the same transaction as its originating state change. | Conceptual only — no schema authored here. Retention follows §8.2.6 split policy (90d processed / 365d failed). |
| **Outbox Delivery State** | Per-event delivery status (pending, claimed, delivered, failed, dead-lettered) tracked separately from the immutable event content. | The state transition drives which retention window (90d vs. 365d) applies. |
| **Idempotency Replay Record** | A retained `(tenant, route, key, payload_hash, response)` tuple used to replay or conflict-detect future requests within the retention window. | Per §9.2.5. |
| **In-Progress Marker** | A short-lived marker for an idempotency key whose original request has not yet completed; triggers the `425 Too Early` response. | Behavior locked by FR-D-004. |
| **Generated Client Artifact** | The typed TypeScript client produced from `packages/contracts/openapi/` via `openapi-typescript` + `openapi-fetch` (§10.3). | Output location is a per-consumer decision (§10.4); `packages/sdk` is NOT the first-slice location. |
| **Drift-Detection Result** | Output of the mechanism that compares the OpenAPI source against the regenerated client. | Mechanism TBD per §10.5. |

---

## 14. Success Criteria

Per-track measurable outcomes the spec authors commit to. Each criterion is
verifiable independently of the others and independently of catalog work.

### 14.1 Track A — Load Testing
- **SC-A-001**: Smoke, baseline, stress, and regression load test classes
  are each defined in this spec with purpose, frequency, pass/fail rule,
  and required measures (§6.2, §6.4) — verifiable by checklist review.
- **SC-A-002**: Baseline tests have explicit p95, p99, and error-rate
  thresholds documented **before** they are first used as a release gate.
- **SC-A-003**: A baseline load test run reports all measures in §6.4 — a
  run missing any measure is not accepted.
- **SC-A-004**: The first implementation slice introduces zero changes to
  `package.json`, `pnpm-lock.yaml`, CI workflows, `apps/**`, or `packages/**`.
- **SC-A-005**: At least one load-test scenario exercises multiple concurrent
  tenants so cross-tenant RLS isolation is part of the measurement.

### 14.2 Track B — Production Observability
- **SC-B-001**: Every API, DB, and worker signal listed in §7.3–§7.5 is
  enumerated in the spec with a clear semantic definition.
- **SC-B-002**: A documented redaction policy exists as a single artifact
  and is referenced by every track that emits logs (§7.6).
- **SC-B-003**: The observability surface is verifiably vendor-neutral —
  no signal definition references a specific commercial vendor's feature.
- **SC-B-004**: A cross-tenant rejection produces a discrete observable
  signal; an RLS context failure produces a discrete observable signal
  (FR-B-008, FR-B-009).
- **SC-B-005**: No new metric introduces high-cardinality labels (tenantId,
  storeId, userId) without documented approval (§7.7).
- **SC-B-006**: Idempotency signals (replay, `409` conflict, `425`
  in-progress) are emitted per FR-D-010 and §7.3.

### 14.3 Track C — Outbox Pattern
- **SC-C-001**: The outbox contract — durable recording, retry, poison
  handling, idempotent processing, retention, redaction — is fully defined
  in this spec (§8.2).
- **SC-C-002**: All outbox implementation work (schema, migrations, code,
  workers, TTL indexes, cleanup jobs, retention processors) is gated and
  requires explicit approval (§8.3, FR-C-006).
- **SC-C-003**: The first outbox implementation slice (when approved)
  targets a single narrow event type (FR-C-007).
- **SC-C-004**: Poison-event handling never silently drops events
  (FR-C-005); dead-letter visibility honors PII redaction.
- **SC-C-005**: Retention policy is **90 days for processed events** and
  **365 days for failed/dead-lettered/poison/audit-relevant events**
  (FR-C-004, §8.2.6) — verifiable by spec review; revisable only via spec
  change, not ad-hoc per-event override.

### 14.4 Track D — Idempotency Middleware
- **SC-D-001**: The full HTTP idempotency contract (§9.2) — header, methods
  in scope, replay rule, conflict rule, cross-tenant non-collision,
  in-progress behavior (`425 Too Early`), and expiry behavior — is
  defined.
- **SC-D-002**: In-progress behavior is **locked to `425 Too Early`**
  (FR-D-004); the response is non-blocking, leak-proof across tenants,
  and documented as retryable. Verifiable by contract test once the first
  slice ships.
- **SC-D-003**: The first idempotency implementation slice targets one
  narrow endpoint, not all mutating endpoints (FR-D-007).
- **SC-D-004**: Cross-tenant key collision is verifiably impossible by
  the scoping tuple (FR-D-002).
- **SC-D-005**: A reused key with a different payload produces 409 Conflict;
  this behavior is provable by a contract test before the first slice ships.

### 14.5 Track E — OpenAPI SDK Generation
- **SC-E-001**: The candidate generators in §10.2 are compared against the
  documented criteria in `research.md`; the directional default is
  **`openapi-typescript` + `openapi-fetch`** (§10.3, FR-E-003).
- **SC-E-002**: Tool confirmation, output location, and generated-file
  introduction are each separate gated approval decisions (FR-E-002,
  FR-E-007).
- **SC-E-003**: Drift detection between OpenAPI source and generated
  client is **capable** of being implemented; the exact mechanism is a
  research outcome.
- **SC-E-004**: No `package.json` / `pnpm-lock.yaml` / generated-file
  changes land as part of this feature 004 specification PR.
- **SC-E-005**: **`packages/sdk` is NOT introduced in the first SDK
  implementation slice** (FR-E-007); SDK strategy is documented before
  any generated artifact lands in this repo.

### 14.6 Cross-track
- **SC-X-001**: This feature 004 specification PR introduces zero changes
  to schema, migrations, OpenAPI contracts, package files, lockfiles, CI
  workflows, or `apps/**` / `packages/**` source.
- **SC-X-002**: This feature is independently mergeable with respect to
  003-catalog-foundation — neither blocks the other (§5).
- **SC-X-003**: All five tracks can be implemented in any order, in
  separate gated PRs, without forcing a re-spec of the other four.

---

## 15. Open Questions

All three §15.1 blocking questions are **resolved** as of 2026-05-16 (see
§1.5 Clarifications). Their effects are integrated into the affected
sections (§8.2.6, §9.2.3, §9.4 FR-D-004, §10.3, §10.4, §10.5, §10.6
FR-E-003 / FR-E-007, and §14). The §15.2 non-blocking items remain open
and will be addressed in `research.md` during `/speckit-plan`.

### 15.1 Resolved clarifications (2026-05-16)
- **Q1 (Track D — in-progress idempotency)**: **Resolved → `425 Too
  Early`**. Non-blocking response, leak-proof across tenants, documented
  as retryable. See §1.5, §9.2.3 row 4, FR-D-004.
- **Q2 (Track C — outbox retention)**: **Resolved → split policy: 90
  days processed / 365 days failed-dead-lettered-poison-audit-relevant**.
  Subject to a later overarching data-retention policy. See §1.5,
  §8.2.6, FR-C-004.
- **Q3 (Track E — SDK generator + output location)**: **Resolved →
  `openapi-typescript` + `openapi-fetch`; no `packages/sdk` in the first
  implementation slice**. See §1.5, §10.3, §10.4, §10.5, FR-E-003,
  FR-E-007.

### 15.2 Non-blocking research items (move to `research.md` during `/speckit-plan`)
- Track A: which non-production environment hosts load tests, and what is
  its data-shape relationship to production?
- Track A: what is the regression delta budget per tracked metric?
- Track B: which OTel Collector exporter(s) does the platform target
  first?
- Track B: what is the slow-query threshold for the §7.4 slow-query
  indicator?
- Track C: what is the dead-letter triage UX — operator CLI? admin
  endpoint? out-of-band tool?
- Track D: what is the replay retention window (24h, 72h, 7d)?
- Track D: which exact endpoint is the first idempotency target?
- Track D: how long does the in-progress marker live before being
  treated as stale and the next retry being processed as a new request?
- Track E: where does the first generated artifact actually live, given
  `packages/sdk` is out of bounds for the first slice — co-located with
  the consumer? a separate published package? a tagged release artifact?
- Track E: how is drift detection wired (CI? pre-commit? manual?)
- Cross-track: how does the redaction policy artifact live alongside the
  Constitution and the existing `redaction-matrix-template.md` template?

---

## 16. Dependencies

### 16.1 Required (already in place)
- Foundation 001 (auth, tenant context, RLS, memberships, audit).
- Existing OpenAPI contracts in `packages/contracts/openapi/` as the
  Track E source.
- Existing structured logger with redaction capability (or the foundation
  for one) — referenced by Track B but not modified here.

### 16.2 Independent (parallel)
- Catalog Foundation 003 — parallel-safe per §5; no hard dependency.
- POS Operator Identity 002 — informs Track D candidate endpoints
  (since POS retries are a primary use case) but is not blocked by this
  feature.

### 16.3 Future / downstream
- Future catalog implementation features (inventory, sales, refunds,
  POS sync) MAY adopt the contracts produced here; their adoption is
  their own scope.
- Future dashboard / POS / integration repositories will consume Track E
  output (via the `openapi-typescript` + `openapi-fetch` direction or a
  documented exception).
- Future security feature(s) will consume Track B signals
  (suspicious-login, auth-failure-by-cause) for detection logic.

---

## 17. Assumptions

- The platform operator role and the backend developer role are distinct;
  observability and load-test outputs are consumed by both but owned by
  the operator.
- A non-production environment exists (or can be stood up with low effort)
  that mirrors production's RLS, tenant context, and auth behavior closely
  enough to be a valid load-test target. Exact environment topology is a
  research item.
- The existing logger is structured and supports field-level redaction at
  a single boundary; if it does not, a redaction wrapper is the smallest
  first slice for Track B and is added under explicit approval.
- "Tenant" and "store" semantics are stable across this feature's lifetime
  — i.e., they do not change in ways that would invalidate the
  observability label set or the idempotency scoping tuple. (If they do,
  this spec is updated.)
- OpenAPI 3.1 remains the contracts-of-record format; if it moves, Track E
  research re-evaluates.
- The POS application and dashboard remain in separate repositories;
  consequently, in-repo SDK packaging is not strictly required —
  reinforced by §1.5 Q3 (no `packages/sdk` in the first slice).
- Load testing against synthetic tenants is acceptable for the platform's
  customers; no contractual obligation requires testing against real
  tenant identifiers.
- Clients can be expected to respect `Retry-After`-style guidance and
  honor `425 Too Early` as retryable; older or non-compliant clients are
  not in the first-slice target audience for idempotency.

---

## 18. Risks (preview — full register in `risk-register.md`)

Recorded here at a high level; the dedicated `risk-register.md` artifact
expands each into likelihood, impact, mitigation, and owner.

- **R-001**: Track B redaction policy drift — a new contributor adds a
  call-site log line containing PII. Mitigation: redact at the logger
  boundary (FR-B-005), make boundary the only place PII can land,
  reject call-site redaction patterns at review.
- **R-002**: Clients misinterpret `425 Too Early` as terminal — some
  HTTP clients treat 4xx as non-retryable by default. Mitigation: FR-D-004
  documents 425 as retryable; OpenAPI contracts describe the retry
  guidance; generated clients (Track E) handle it explicitly.
- **R-003**: Track C outbox adopted too broadly too fast — every event
  through one undertested drainer becomes a single point of failure.
  Mitigation: FR-C-007 narrow-first slice + observability + dead-letter
  triage.
- **R-004**: Track E generator choice (`openapi-typescript` +
  `openapi-fetch`) is comparatively new tooling — risk that one of them
  becomes unmaintained. Mitigation: §10.2 comparison covers maintenance
  health; drift detection (FR-E-006) makes regenerating with an
  alternative tool cheap; the directional default is revisable.
- **R-005**: Load tests run against trivial data and produce flattering
  numbers. Mitigation: FR-A-003, FR-A-009 enforce realistic environment
  and multi-tenant concurrency.
- **R-006**: Cardinality explosion from per-tenant metric labels.
  Mitigation: FR-B-012 review gate.
- **R-007**: Production-readiness work accidentally couples to catalog
  schema. Mitigation: §5 parallelism contract + §5.4 reviewer
  obligation.
- **R-008**: Outbox retention windows (90d / 365d) collide with a future
  data-retention policy. Mitigation: §8.2.6 explicitly defers to such a
  policy; the windows are operational defaults, not contractual.
- **R-009**: First-slice pressure to introduce `packages/sdk` despite
  §10.4 / FR-E-007. Mitigation: explicit gating language in §10.5;
  reviewer obligation in §5.4 and §11.6.

---

## 19. Glossary

- **Smoke load test**: minimal-load run that proves the harness works.
- **Baseline load test**: steady-state run at expected production load;
  produces the reference numbers.
- **Stress load test**: deliberate over-load run to find the breakpoint.
- **Regression load test**: comparison run against a stored baseline.
- **Outbox**: a database table holding events durably emitted in the
  same transaction as the originating state change.
- **Outbox drainer**: a worker that reads pending outbox events and
  publishes them to the queue/event bus.
- **Poison event**: an event that consistently fails consumer
  processing past the retry budget.
- **Idempotency-Key**: an opaque client-supplied header used to
  deduplicate retries of mutating requests.
- **Replay**: returning the original response of a previously-completed
  request when the same idempotency tuple recurs.
- **In-progress collision**: a retry that arrives while the original
  request bearing the same `(tenant, route, key)` is still in flight;
  the platform responds `425 Too Early`.
- **Drift (SDK)**: divergence between the OpenAPI source and the
  generated typed client.
- **Vendor-neutral observability**: signals defined independently of any
  specific commercial APM vendor.
- **Gated**: requires explicit approval in a separate PR; this PR MUST
  NOT author it.

---

## 20. Out of Scope (recap)

Restated for explicit reviewer reference; the authoritative non-goals list
is §3.

- No runtime code, schema, migrations, OpenAPI changes, `package.json`
  changes, `pnpm-lock.yaml` changes, CI changes, generated files in this
  PR.
- No catalog implementation. No POS implementation. No dashboard UI.
- No billing, reports, analytics, dbt, ClickHouse, Dagster.
- No external deployment infrastructure.
- No vendor lock-in for observability or load testing in this PR.
- No global idempotency rollout in the first implementation slice.
- No `packages/sdk` introduction in the first SDK implementation slice.

---

*End of specification.*
