<!--
Sync Impact Report
==================
Version change: 3.0.0 → 3.0.1
Bump rationale: PATCH — clarification only. Adds a Working Agreement
                bullet pointing to the new
                `.specify/memory/architecture-impact.md` document, which
                codifies the Architecture Impact Map pre-flight rule. No
                Core Principle is added, removed, or redefined; no
                Constitution-Check table column is added; no existing
                spec / plan / tasks artifact requires re-versioning. The
                rule is a process gate in the Working Agreement appendix,
                not a system invariant, and is therefore explicitly
                outside the Constitution Check.

Modified principles (kept in-place; numbering unchanged so all existing
`Principle III/IV/V/VI/VII/VIII` references in specs/plans/tasks remain
valid):
  I.    Reference, Not Source of Truth                  (kept verbatim)
  II.   Multi-Tenant SaaS by Default                    (+ fail-closed,
                                                          + DB roles never
                                                            bypass RLS,
                                                          + workers not
                                                            exempt,
                                                          + cross-tenant
                                                            non-disclosure
                                                            (404 semantics),
                                                          + direct POS DB
                                                            access forbidden)
  III.  Backend Authority & Data Integrity              (+ uniform error
        (NON-NEGOTIABLE)                                  envelope codified,
                                                          + concurrency
                                                            control posture
                                                            for new mutable
                                                            resources,
                                                          + cache
                                                            invalidation
                                                            triggers
                                                            documented,
                                                          + money
                                                            representation
                                                            defined before
                                                            sales/catalog,
                                                          + POS totals
                                                            preserved as
                                                            received)
  IV.   Contract-First POS Integration                  (+ packages/
                                                            contracts/
                                                            openapi/ pinned
                                                            as source of
                                                            truth,
                                                          + stable
                                                            operationId,
                                                          + no raw DB
                                                            entities in
                                                            responses,
                                                          + OpenAPI
                                                            conformance
                                                            tests required)
  V.    Async Work Belongs in Workers                   (+ jobs carry
                                                            tenantId,
                                                            storeId,
                                                            correlationId,
                                                          + workers
                                                            establish
                                                            tenant context
                                                            before DB
                                                            access,
                                                          + failed-job
                                                            logs redacted)
  VI.   Test-First Quality                              (+ Testcontainers
                                                            for tenant
                                                            isolation,
                                                          + cross-tenant +
                                                            cross-store
                                                            sweep tests
                                                            required,
                                                          + RLS bypass
                                                            probe required,
                                                          + malicious
                                                            override
                                                            attempts,
                                                          + MIGRATION_TEST_
                                                            ALLOW_SKIP=1
                                                            only where
                                                            supported)
  VII.  Observable Systems                              (+ requestId/
                                                            correlationId
                                                            on every
                                                            request and
                                                            job,
                                                          + new metrics:
                                                            queue lag, RLS/
                                                            context
                                                            failures, POS
                                                            sync lag,
                                                            duplicate event
                                                            rate, unknown
                                                            item rate,
                                                            reconciliation
                                                            mismatch rate,
                                                          + invitation
                                                            secrets, tokens,
                                                            payloads never
                                                            logged)
  VIII. Reproducible & Versioned Releases               (+ no package.json
                                                            / pnpm-lock /
                                                            DB schema /
                                                            SQL migration
                                                            changes
                                                            without
                                                            explicit
                                                            approval)

Added principles:
  IX.   Source-of-Truth Model
  X.    Retail Temporal Semantics
  XI.   Idempotency & External IDs
  XII.  Authorization & Object Safety
  XIII. Auditability & Provenance
  XIV.  PII & Data Lifecycle Discipline

Added sections:
  - Source-of-Truth Hierarchy
  - Retail Temporal Semantics
  - Money, Tax, and Rounding
  - Idempotency & External IDs
  - Worker & Queue Safety
  - Authorization & Object Safety
  - Auditability & Provenance
  - Concurrency & Optimistic Locking
  - Per-Tenant Resource Isolation
  - API Conventions
  - PII & Data Lifecycle
  - Testing Policy (promoted from inline)
  - Scope Boundaries (expanded)
  - Working Agreement (appendix, NOT a principle — agent + human
    operating rules; full content lives in CLAUDE.md and CONTRIBUTING.md)

Removed sections:
  - None.

Templates requiring updates:
  ⚠ pending  specs/001-foundation-auth-tenant-store/spec.md       (§14 Constitution Check table — extend rows for IX–XIV)
  ⚠ pending  specs/001-foundation-auth-tenant-store/plan.md       (§2 + §7 Constitution Check tables — extend for IX–XIV)
  ⚠ pending  specs/001-foundation-auth-tenant-store/tasks.md      (header `Constitution: v2.0.0` → `v3.0.0`; T308 "all 8 principles" → "all 14")
  ⚠ pending  specs/001-foundation-auth-tenant-store/research.md   (header version bump)
  ⚠ pending  .specify/templates/constitution-template.md          (currently a verbatim copy of v2.0.0; resync to v3.0.0)
  ⚠ pending  CLAUDE.md (repo)                                      (constitution-at-a-glance section needs IX–XIV summary)

Follow-up TODOs (recorded; not implemented in this amendment):
  - Define exact-decimal money representation (numeric(p,s) precision +
    chosen money library) before any sale/catalog pricing slice.
  - Define the timestamp catalog schema for sale facts (which timestamps
    are required vs optional per entity).
  - Decide payload-hash algorithm for POS provenance (sha256 of canonical
    JSON?).
  - Decide audit-event storage destination growth strategy (single table
    vs partitioned vs append-only log) once retention pressure surfaces.
  - Add a Constitution-Check stub for Principles IX–XIV to spec/plan
    templates so future features automatically check them.
  - Decide per-tenant request quota policy and noisy-neighbor strategy
    before the first POS sync feature lands.
  - Define data classification taxonomy (PII / payment / business /
    public) and per-class retention windows.
-->

# Data-Pulse-2 Constitution

Data-Pulse-2 is a **multi-tenant SaaS retail data control plane and trust
layer**. It is not "just a CRUD SaaS backend." It owns the boundaries that
keep retail data correct: tenant isolation, source-of-truth between Global
Catalog / Tenant Catalog / Store Override / sale-line snapshots, contract
governance for POS and other integrations, and the immutability of historical
retail facts. The POS application lives in a separate repository and
integrates exclusively through documented, versioned, authenticated API
contracts.

This Constitution defines the non-negotiable engineering and product
principles for all future specs, plans, tasks, and implementations. It uses
**MUST / SHOULD / MUST NOT** language. It does not contain application code.

## Core Principles

### I. Reference, Not Source of Truth
The legacy `Data-Pulse` repository (https://github.com/ahmed-shaaban-94/Data-Pulse) is
reference material **only**. Code, architecture, models, naming, schemas, and
configurations from it MUST NOT be copied verbatim. Every carry-over MUST be
re-justified against this Constitution and re-spec'd via `/speckit-specify`
before implementation. The legacy repo, when cloned for inspection, MUST live
under `/reference/` and MUST be listed in `.gitignore` so it never enters
version control.

**Rationale**: The rebuild exists because the legacy repo accumulated
unreviewed decisions. Treating it as a source of truth would import the very
debt the rebuild is meant to shed.

### II. Multi-Tenant SaaS by Default
This codebase is multi-tenant from day one. Every tenant-owned entity (users,
stores, products, inventory, orders, reports, etc.) MUST be scoped by
`tenant_id` (and where applicable `store_id`) at the database, query, and API
layers. There is no "single-tenant fast path." Specifically:

- Every tenant-owned row MUST carry an explicit, NOT NULL `tenant_id` with a
  foreign key to `tenants(id)`.
- Every store-scoped operation MUST prove tenant access AND store access
  before reading or mutating data. Store-access policy (`'all'` vs
  `'specific'`) MUST be evaluated server-side on every store-scoped request.
- Tenant scoping MUST be enforced at the **database layer** via foreign keys
  and Row-Level Security (RLS) policies — not only by application code.
- **RLS MUST fail closed.** Policies MUST use the safe form
  `current_setting('app.current_tenant', true)::uuid` so that an unset GUC
  yields NULL and matches no rows. Any code path that bypasses this
  contract is a defect.
- **Runtime database roles MUST NOT bypass RLS.** The application's runtime
  Postgres role MUST NOT have `BYPASSRLS`. Migrations and back-fill scripts
  may use a separately documented privileged role under audited procedures.
- **Workers are not exempt.** Any background job that touches tenant-owned
  data MUST establish tenant context (`SET LOCAL app.current_tenant = ...`)
  inside a transaction before issuing queries. Jobs that operate without a
  tenant context MUST justify it explicitly and MUST NOT read tenant rows.
- **Cross-tenant resource access MUST NOT reveal existence.** A request from
  user A for a resource owned by tenant B MUST return the same response shape
  as "resource does not exist" (default: `404` with the canonical error
  envelope). `403` is reserved for cases where the active tenant is already
  resolved and the failure is purely a role gate within that tenant.
- **Direct POS database access is forbidden.** The POS app MUST integrate
  only through the documented APIs. Shared filesystems, shared databases, or
  undocumented endpoints are a violation of this principle.

**Rationale**: Tenant data leakage is the highest-severity bug class for
SaaS. Defense in depth (DB + app + tests + safe error semantics + worker
discipline) is the only safe default. Existence disclosure is the single
most common subtle leak.

### III. Backend Authority & Data Integrity (NON-NEGOTIABLE)
The backend is the sole authority for business state. Specifically:

- **Authorization is server-side.** Frontend or POS-side checks are UX
  hints, never security boundaries. Every protected operation MUST be
  re-authorized on the server.
- **Database constraints protect invariants.** Uniqueness, foreign keys,
  NOT NULL, CHECK constraints, partial uniques, and migrations MUST encode
  business rules — application-only validation is insufficient.
- **Redis / caches are never the source of truth.** Caches MUST be
  reconstructible from Postgres. Any flow that requires the cache to be
  authoritative MUST be redesigned. Every tenant-scoped cache key MUST have
  a documented invalidation trigger; TTL-only invalidation is forbidden for
  authorization-bearing or membership-bearing data.
- **Concurrency posture for mutable resources.** New mutable tenant-owned
  resources SHOULD use optimistic concurrency control (a `version` column
  or equivalent, paired with `If-Match` / version-on-update semantics in
  the API). Existing mutable resources MUST NOT be retrofitted without an
  approved schema/migration slice. Last-write-wins MUST be explicitly
  justified.
- **Money representation MUST be defined explicitly before any sales /
  catalog pricing implementation.** Floating-point money is forbidden.
  Monetary fields MUST use exact-decimal types (`numeric(p,s)`) and MUST
  carry an explicit currency code (multi-currency-readiness from day one,
  even if the MVP is single-currency).
- **POS totals MUST be preserved as received.** When POS ingestion exists,
  the SaaS MAY reconcile and flag mismatches but MUST NOT silently rewrite
  historical POS totals.
- **Uniform error envelope.** API errors MUST use the canonical envelope
  `{ error: { code, message, request_id, details? } }`. Status code MUST
  match the canonical mapping; `request_id` MUST always be present.
- **Migrations are forward-compatible and reviewed.** Destructive migrations
  require an explicit rollout plan in the PR description.

**Rationale**: Frontend-only checks, cache-as-truth, "we'll add the
constraint later," float-money, and silently rewriting POS history are the
patterns most likely to corrupt SaaS retail data permanently.

### IV. Contract-First POS Integration
The POS app is a separate repository and a separate trust boundary. All
integration MUST flow through APIs that are:

- **Documented in `packages/contracts/openapi/`** — OpenAPI 3.1 YAMLs in
  this directory are the **source of truth** for documented APIs. Code
  MUST conform to them; conformance MUST be enforced by automated contract
  tests.
- **Stable**. Every public or integration endpoint MUST have a stable
  `operationId`, an explicit `security` section, request/response schemas,
  and documented error responses. `operationId` renames are breaking
  changes.
- **Versioned**. Breaking changes require a new version (default: explicit
  path segment, e.g., `/api/pos/v1/...`) or an approved migration path
  with a documented deprecation window of at least one POS release cycle.
  Old versions remain supported through that window.
- **Authenticated**. Every POS request carries a verifiable credential
  (per-device token or short-lived bearer) tied to a tenant + store +
  device identity.
- **Idempotent on writes** (see Principle XI for the contract).
- **Conflict-aware**. For any entity editable both by the backend and an
  offline POS client, the conflict-resolution policy (last-write-wins,
  version vector, manual reconciliation) MUST be specified before
  implementation and recorded in the entity's spec.
- **API responses MUST NOT return raw database entities.** Every response
  body MUST be an explicit wire shape (e.g., a `toBody()` projection),
  decoupled from the underlying schema. Internal-only fields, soft-deletion
  internals, and credential hashes MUST never appear in responses.

**Rationale**: The POS is offline-first and unreliable by design. The
backend cannot assume "exactly once" delivery, in-order arrival, or the
absence of stale clients. Coupling response shape to DB shape causes
silent leaks and brittle migrations.

### V. Async Work Belongs in Workers
Anything that doesn't need to complete inside a request MUST run in a
background worker. This includes (non-exhaustive): webhook delivery, POS
sync processing, report generation, billing/subscription side-effects,
email/SMS, large imports/exports, and scheduled jobs. Worker code MUST:

- Be **idempotent and retry-safe** with explicit retry/backoff policies.
- **Carry tenant context.** Every tenant-scoped job MUST carry `tenantId`;
  every store-scoped job MUST carry `storeId`. Every job MUST carry a
  `correlationId` (or `request_id` propagated from the originating request)
  and enough audit context to reconstruct what happened.
- **Establish tenant context before DB access.** Workers that touch
  tenant-owned data MUST set `app.current_tenant` (and where applicable
  `app.is_platform_admin`) inside a transaction. Workers MUST NOT operate
  on tenant data without a resolved tenant context.
- **Surface failures.** Dead-letter queues or equivalent, with alerting.
  Silently swallowing exceptions is forbidden.
- **Never leak secrets.** Failed-job logs MUST be redacted of tokens,
  passwords, invitation secrets, payment data, and PII beyond what is
  needed to identify the actor.

API request handlers MUST stay focused on validation, authorization, and
synchronous state changes; they delegate the rest.

**Rationale**: Coupling slow/unreliable work to user requests is the
fastest path to cascading outages. Workers without tenant context are the
backdoor that bypasses RLS.

### VI. Test-First Quality
Tests are written **before** the implementation merges. Coverage targets
and required test classes:

- Backend API: integration tests per endpoint covering happy path, auth
  failure, cross-tenant isolation, cross-store isolation (where applicable),
  insufficient-role, and at least one negative-path case.
- **Tenant isolation MUST be covered with Testcontainers** (or an
  equivalent real-Postgres harness) where possible. RLS and cross-tenant
  behavior are integration concerns, not unit-test concerns.
- **Cross-tenant and cross-store sweep tests** are required: every
  protected endpoint MUST be exercised against a cross-tenant attempt and
  (where applicable) a cross-store attempt, asserting the canonical
  non-leaking response.
- **RLS bypass probe** is required: a raw SQL probe with
  `app.current_tenant` set to the wrong tenant MUST return zero rows.
- **Malicious-override attempts** are required where relevant: tests that
  inject `tenant_id`, `store_id`, `role`, `status`, `acceptedAt`,
  `createdBy`, and other security-sensitive fields into request bodies
  MUST assert those fields are ignored or rejected, never honored.
- Workers: unit tests for job logic plus at least one retry/idempotency
  test, plus a tenant-context test where applicable.
- POS-facing endpoints (when they ship): contract tests verifying the
  OpenAPI schema and idempotency behavior.
- Overall line coverage: ≥80% for application code; PRs that lower
  coverage without Constitution-level justification MUST be rejected.
- **Local Docker-less test escape hatch.** `MIGRATION_TEST_ALLOW_SKIP=1`
  MAY be used to run tests on hosts without a local Docker daemon, but
  ONLY where it is already supported in the test code. CI MUST run with
  Testcontainers enabled.

**Rationale**: A multi-tenant SaaS without tests becomes unrefactorable
within one quarter. Tests are the only durable specification, and tenant
isolation specifically is the only thing that scales an audit story.

### VII. Observable Systems
Every API, worker, sync job, scheduled job, and analytics pipeline MUST
emit:

- **Structured logs** (JSON or key=value) carrying `request_id` /
  `correlation_id`, `tenant_id`, `store_id` (when safe and applicable),
  `user_id`, route/job name, and operation context. No bare `print()` in
  production paths.
- **Metrics** for request rate, error rate, latency (p50/p95/p99), queue
  depth, and job success/failure counts. Operationally, metrics SHOULD
  also include: **queue lag**, **failed-job rate**, **auth-failure rate**,
  **RLS / tenant-context failures**, **POS sync lag** (when POS exists),
  **duplicate-event rate**, **unknown-item rate**, and **reconciliation
  mismatch rate**.
- **Traceable failures** — exit codes, dead-letter queues, run-summary
  records; silent partial-success is forbidden.
- **No secrets, tokens, invitation secrets, payment data, raw POS payloads,
  or sensitive PII in logs.** Redaction is mandatory at the logger
  boundary, not optional at call sites.

Secrets MUST come from environment variables or a secret manager — never
hardcoded, never committed.

**Rationale**: Multi-tenant systems fail per-tenant in ways that aggregate
metrics hide. Per-tenant observability is the only way to debug, bill, and
prove tenant isolation under audit.

### VIII. Reproducible & Versioned Releases
Every service MUST be reproducible from a checked-out commit plus a
documented environment (lockfile, container image tag, infra config).
Schema-affecting changes ship as numbered migrations with a `CHANGELOG.md`
entry. API breaking changes ship as a new API version. One-off scripts
that mutate data MUST be checked in under `scripts/oneoff/` with a dated
filename and a header comment stating purpose, date, operator, and
rollback plan.

- **Approval-gated dependency / schema changes.** `package.json`,
  `pnpm-lock.yaml`, DB schema (Drizzle TypeScript schemas), and SQL
  migration files MUST NOT be changed without explicit approval recorded
  in the spec/plan/task that justifies the change. Drive-by dependency
  bumps and silent schema drift are violations.
- **Migrations are reversible.** Every migration ships with a paired
  rollback (`*.down.sql` or documented inverse) reviewed for lock
  duration on tables expected to grow.

**Rationale**: Reproducibility is the floor for incident response.
Unreviewed lockfile drift and silent migrations are the leading causes of
long-tail incidents.

### IX. Source-of-Truth Model
This is a retail data system. Source-of-truth boundaries are not optional
and MUST NOT be blurred:

- **SaaS is truth** for tenants, stores, memberships, invitations,
  authentication state, and integration credentials. The POS does not own
  these.
- **Global Catalog is reference / suggestions only.** It seeds, it does
  not bind. A tenant MAY adopt, override, or ignore Global Catalog entries.
- **Tenant Catalog is truth for the customer.** A tenant's product
  definitions, pricing rules, and category structure are tenant-owned and
  authoritative for that tenant.
- **Store Override is truth for the branch.** Where a store legitimately
  diverges from tenant defaults (price, availability, tax treatment), the
  store override is authoritative for that store.
- **SaleLine snapshot is truth for the invoice.** When a sale is recorded,
  the line-level snapshot of price, name, tax, and unit at the moment of
  sale is the historical truth. Subsequent catalog changes MUST NOT mutate
  past sale lines (see Principle X).
- **Raw POS payload + event provenance MUST remain traceable** when POS
  ingestion exists. Each ingested event MUST carry `sourceSystem`,
  `externalId`, ingestion timestamp, and a payload hash (or equivalent
  provenance) so that the SaaS view can be reconciled to the original
  payload at any time.

**Rationale**: Retail data lives or dies on snapshot-vs-reference
discipline. Once a sale is captured, its truth is the snapshot, not the
catalog. Once a payload is ingested, its truth is the payload, not the
SaaS projection.

### X. Retail Temporal Semantics
Time is not one timestamp. Sales-bearing entities and POS events MUST
distinguish, where relevant:

- `occurredAt` — when the business event happened (e.g., sale rung up).
- `receivedAt` — when the SaaS first received the event.
- `processedAt` — when the SaaS finished processing the event.
- `businessDate` — the tenant-local business day the event belongs to,
  derived from store timezone (NOT raw client clock for security
  decisions).
- `sourceClockAt` — the client/POS-reported clock value, preserved as
  received and never used as the security clock.
- `voidedAt`, `refundedAt` — terminal mutating events that MUST be
  modeled separately from the original event, not by mutating it.

Additional rules:

- **Offline POS sync and delayed events are expected.** Receiving an event
  where `occurredAt` is hours, days, or weeks behind `receivedAt` is
  normal and MUST NOT be silently rewritten or rejected.
- **Historical sale facts MUST NOT be silently rewritten by catalog
  changes.** Renaming a product, changing its price, or recategorizing it
  in the Tenant Catalog MUST NOT alter past sale lines.
- **Storage default is UTC.** All timestamps are stored as `TIMESTAMPTZ`
  in UTC. Tenant-local presentation derives from store timezone.
- **Security clocks are server clocks.** Token expiry, session expiry,
  rate-limit windows, and idempotency-key TTLs are evaluated against the
  server clock, never against client-reported time.

**Rationale**: A retail backend that can't separate "when it happened"
from "when we found out" is a backend that loses data on every offline
recovery and lies to every audit.

### XI. Idempotency & External IDs
Retries MUST NOT duplicate side effects.

- **Mutating APIs that can be retried MUST be idempotent**, OR they MUST
  explicitly justify why not in the API spec.
- **POS ingestion MUST use `sourceSystem + externalId`** (or an
  idempotency key, or both) as the dedup contract. The same
  `(sourceSystem, externalId)` pair MUST resolve to the same SaaS record
  across retries; a duplicate event MUST be detected and not double-applied.
- **Workers MUST be idempotent.** A job re-run MUST converge to the same
  state as a single successful run.
- **Email and notification jobs MUST be idempotent.** A retried invitation
  email MUST NOT produce two memberships, two audit events, or two
  observable side effects.
- **Idempotency-key responses are honored.** When a write endpoint accepts
  an `Idempotency-Key`, replays of the same key with the same request body
  MUST return the prior response without re-applying state.

**Rationale**: At-least-once delivery is the network's promise. Exactly-
once is a property the backend has to manufacture, and external IDs +
idempotency keys are how it does so.

### XII. Authorization & Object Safety
Object-level and property-level authorization are mandatory.

- **IDs in request bodies are not trusted.** `tenant_id`, `store_id`, and
  any identifier of a parent object MUST be resolved from server-side
  context (session, token, path parameter), never accepted from the body
  for write authority.
- **Mass-assignment is forbidden.** `tenant_id`, `store_id`, `role`,
  `role_id`, `status`, `acceptedAt`, `accepted_by_user_id`, `createdBy`,
  `is_platform_admin`, `password_hash`, and any other security-sensitive
  field MUST NOT be assignable from request bodies. Request schemas MUST
  use explicit command DTOs that omit these fields.
- **Strict schema validation at the boundary.** Request validation MUST
  reject unknown keys (e.g., `Zod.strict()` or equivalent). Silently
  ignoring unknown keys is a regression.
- **Object-level authorization on every protected read and write.** A
  request that names a target object MUST validate that the active
  principal is allowed to act on that object — not just on the endpoint.
- **Safe 404 for cross-tenant lookups.** Cross-tenant resource access MUST
  return the same response as "resource does not exist" (per Principle II);
  insufficient-role within an already-resolved active tenant MAY return
  `403`.
- **Default deny.** An endpoint with no explicit authorization annotation
  MUST fail closed; "no annotation" MUST NOT mean "public."

**Rationale**: Object safety is the OWASP top-tier of SaaS bug classes.
Codifying mass-assignment and existence-disclosure rules at constitutional
level prevents drift across the dozens of endpoints to come.

### XIII. Auditability & Provenance
Sensitive actions are auditable. Audit is part of the contract, not an
afterthought.

- **Auditable events** include at minimum: authentication success/failure,
  password reset, role/permission change, store-access change, tenant
  context switch, tenant/store/membership create/update/soft-delete,
  invitation create/accept/revoke, platform-admin cross-tenant access,
  and any action that crosses a trust boundary.
- **Audit event shape (canonical)** MUST include: actor (user or service),
  tenant (when applicable), store (when applicable), operation/action,
  target type and id, timestamp, `correlationId` / `request_id`, and
  outcome (success/failure with reason class).
- **Anonymous-actor pattern.** Authentication failures and other
  pre-authentication events MUST record `actor_user_id IS NULL` with an
  `actor_label` containing the (unverified) email or identifier used —
  never the password, token, or any verifiable credential.
- **Insert-only.** The application layer MUST NOT update or delete audit
  records. Retention sweeps run as privileged platform operations under a
  documented procedure.
- **Provenance for ingested data** (when POS or other ingestion exists)
  MUST preserve `sourceSystem`, `externalId`, ingestion timestamps, and
  a payload hash (or equivalent) so SaaS records can be reconciled to
  their origin.
- **Audit MUST NOT leak secrets or sensitive PII.** `metadata` fields are
  bounded and redacted at the emitter, not at the reader.

**Rationale**: Audit is how a multi-tenant SaaS proves its tenant
isolation story under question. An audit table without a canonical event
shape is an audit table that lies.

### XIV. PII & Data Lifecycle Discipline
Customer data is a liability as well as an asset.

- **Data classification.** Every persisted field SHOULD be classified
  along (at least) **PII / payment / business / public**. Classification
  drives logging redaction, retention, export, and erasure behavior.
- **Retention windows are explicit.** Each class MUST have a documented
  retention window; retention sweeps are scheduled jobs, not manual
  operations.
- **Right-to-erasure is a first-class operation.** Tenant- or
  user-initiated data erasure MUST be representable as a documented flow
  that respects audit immutability (audit records MAY remain with the
  PII fields tombstoned).
- **Cross-border data residency posture is stated.** Even if the MVP is
  single-region, the constitution-time answer is "single region X" — not
  silence.
- **Logging redaction is mandatory.** Tokens, passwords, invitation
  secrets, payment data, raw POS payloads, and PII beyond what identifies
  the actor MUST be redacted at the logger boundary. JobIds and
  observability tags MUST NOT carry PII.
- **Soft-delete is the default** for tenant, store, membership, and user.
  Hard-delete is a privileged, audited platform operation after the
  documented retention window.

**Rationale**: Multi-tenant retail SaaS holds customer-grade PII and
payment context. Retrofitting classification and retention is a
multi-quarter project; codifying the posture now keeps it cheap.

## Repository Scope

### This repository (Data-Pulse-2) owns
- SaaS backend API.
- Dashboard / admin frontend (a separate, future feature).
- Tenant, account, and store management.
- Users, roles, permissions, and authentication.
- Central PostgreSQL database (source of truth).
- Product catalog (source of truth for tenants).
- Inventory (source of truth).
- Central orders / sales records (source of truth).
- Background workers.
- Billing / subscriptions (if applicable).
- Reports and analytics.
- POS sync APIs (the API surface; the POS app itself is a separate repo).
- Webhooks and external integrations.
- Deployment and infrastructure configuration.

### The POS repository owns
- POS user interface.
- Offline / local-first behavior.
- Local device storage.
- Local cart and checkout flow.
- Local sync client.
- Device-level error handling.

### The trust boundary
All communication between this SaaS backend and the POS app MUST happen
through documented, versioned, authenticated API contracts. Direct
database access from the POS, shared filesystems, or undocumented
endpoints are forbidden.

## Multi-Tenancy Standards

- Every tenant-owned table MUST include `tenant_id` (and `store_id` where
  applicable) with a NOT NULL constraint and an index suitable for
  tenant-scoped queries.
- All ORM/query helpers MUST default to tenant-scoped queries; "raw"
  cross-tenant queries require an explicit override and are forbidden in
  request handlers.
- Authentication tokens MUST encode (or resolve to) a tenant context. A
  request without a resolvable tenant context is rejected at the auth
  layer.
- RLS policies MUST be present on every tenant-owned table and MUST use
  the safe `current_setting(..., true)` form so an unset GUC fails closed.
- The application's runtime database role MUST NOT have `BYPASSRLS`.
  Migration / privileged roles are separate and audited.
- Admin / superuser flows that legitimately span tenants MUST be
  auditable: every cross-tenant action writes an audit log entry with
  actor, target tenant, action, and timestamp.
- Cross-tenant resource access MUST NOT distinguish "exists in another
  tenant" from "does not exist" in the response shape (see Principle II
  and Principle XII).
- Tenant deletion / suspension MUST be reversible for a documented
  retention window before any hard delete (see Principle XIV).

## POS Integration Contract Standards

- **API style**: REST + JSON (default). Deviations require a spec.
- **Versioning**: explicit version segment (e.g., `/api/pos/v1/...`) or
  header. New versions ship additively; breaking changes never reuse an
  existing version. `operationId` renames are breaking.
- **Auth**: per-device credentials issued by the backend; revocable; tied
  to a tenant + store + device. Long-lived shared secrets are forbidden.
- **Idempotency** (per Principle XI): every write endpoint accepts an
  `Idempotency-Key` header (or uses `sourceSystem + externalId`); replays
  return the prior result without re-applying state.
- **Schema**: request/response schemas live in `packages/contracts/openapi/`
  as the source of truth. Code conforms; contract tests enforce it.
- **No raw DB entities.** Every response body is an explicit wire shape
  decoupled from schema layout.
- **Sync semantics**: each sync entity has a documented conflict-
  resolution policy and a documented "what happens on duplicate event"
  rule.
- **Backwards compatibility**: a deprecation window of at least one POS
  release cycle for any version sunset, communicated in writing.

## Backend Authority & Data Integrity

- Postgres is the system of record. Every other store (Redis, search
  index, object storage, analytics warehouse) is rebuildable from
  Postgres.
- Foreign keys are mandatory for relationships; orphaned rows are a
  defect.
- Money, tax, and inventory math MUST use exact-decimal types — never
  floats (see "Money, Tax, and Rounding" section).
- Migrations MUST be reviewed for lock duration on large tables, backward
  compatibility with running services, and a rollback plan.
- Background data-correction scripts MUST be idempotent and committed
  under `scripts/oneoff/` per Principle VIII.

## Source-of-Truth Hierarchy

The retail truth gradient (highest to lowest authority for a given fact):

| Fact | Authoritative source |
|---|---|
| Identity, tenancy, memberships, integration credentials | SaaS |
| Tenant's product definitions, pricing rules, categories | Tenant Catalog |
| Branch-level price / availability / tax overrides | Store Override |
| The historical price/name/tax of a sold line | SaleLine snapshot at sale time |
| Raw event detail, before SaaS interpretation | POS payload (preserved verbatim) |
| Suggested defaults / starter data | Global Catalog (reference only) |

A SaaS feature touching any of the above MUST identify which layer it
reads from and which layer it writes to. Cross-layer writes (e.g.,
"editing the catalog updates a past sale") are forbidden unless the spec
explicitly justifies them.

## Retail Temporal Semantics

Sales-bearing entities and POS events MUST model the timestamps relevant
to the entity:

| Timestamp | Meaning |
|---|---|
| `occurredAt` | When the business event happened. |
| `receivedAt` | When the SaaS first received the event. |
| `processedAt` | When the SaaS finished processing. |
| `businessDate` | Tenant-local business day, derived from store timezone. |
| `sourceClockAt` | Client/POS-reported clock; preserved, never used for security decisions. |
| `voidedAt` | Terminal mutating event, modeled separately. |
| `refundedAt` | Terminal mutating event, modeled separately. |

The exact required vs optional set per entity is decided in the entity's
spec. Storage is UTC `TIMESTAMPTZ`. Security and authorization clocks are
the server clock.

## Money, Tax, and Rounding

- Floating-point money is forbidden.
- Monetary fields use exact-decimal types (`numeric(p,s)` in Postgres),
  with precision and scale documented per field.
- Every monetary field carries an explicit currency code (ISO 4217). Even
  in single-currency MVPs, the column is present from day one.
- The exact money library / representation MUST be chosen and recorded
  before any sale or catalog-pricing slice ships.
- POS totals are preserved as received; SaaS reconciles and flags
  mismatches but MUST NOT silently rewrite historical POS totals.
- Rounding rules (per-line vs invoice-level, banker's vs half-up) are
  documented per tenant or per integration; defaults are decided in the
  pricing spec, not improvised in code.

## Idempotency & External IDs

- Mutating retryable APIs are idempotent or document why not.
- POS ingestion uses `sourceSystem + externalId` (and/or
  `Idempotency-Key`) as the dedup contract.
- The platform MUST provide a reusable `idempotency_keys` mechanism keyed
  by `(tenant_id, store_id, client_id, key)` with a TTL.
- Workers and email/notification jobs MUST be idempotent.
- Replays of the same idempotency key with the same body MUST return the
  prior response and produce no additional side effects.

## Worker & Queue Safety

- Every tenant-scoped job carries `tenantId`; every store-scoped job
  carries `storeId`; every job carries `correlationId` / `request_id`.
- Workers MUST establish tenant context (`SET LOCAL app.current_tenant`)
  before reading or writing tenant-owned data.
- Retries MUST be safe (Principle XI).
- Failed-job logs MUST be redacted of secrets, tokens, invitation
  secrets, payment data, and sensitive PII.
- Dead-letter queues (or equivalent terminal-failure surfaces) are
  required and alertable.
- Long-running jobs emit progress (heartbeats or progress records).
- Webhook delivery is a worker concern, never inline in a request handler.
- Scheduled jobs are checked into the repo, not configured by hand on a
  server.

## Authorization & Object Safety

- IDs in request bodies are not trusted; tenancy and parent-object
  identity resolve from server-side context.
- Mass-assignment is forbidden: `tenant_id`, `store_id`, `role` /
  `role_id`, `status`, `acceptedAt`, `accepted_by_user_id`, `createdBy`,
  `is_platform_admin`, `password_hash`, and similar fields are not
  body-assignable.
- Request schemas use explicit command DTOs.
- Strict body validation (`.strict()` / equivalent) rejects unknown keys.
- Object-level authorization is checked on every protected read/write.
- Cross-tenant lookups return safe 404 (Principle II / XII).
- Endpoints with no explicit authorization annotation fail closed.

## Auditability & Provenance

- Audit events carry: actor, tenant, store (if applicable), operation,
  target type+id, timestamp, correlationId / request_id, outcome.
- Anonymous-actor pattern: pre-auth failures record `actor_user_id IS
  NULL` with `actor_label` (no credentials).
- Insert-only at the application layer; retention sweeps are privileged.
- POS / ingestion records carry `sourceSystem`, `externalId`, ingestion
  timestamps, and payload hash (or equivalent provenance).
- Audit `metadata` is bounded and redacted at the emitter.

## Concurrency & Optimistic Locking

- New mutable tenant-owned resources SHOULD use optimistic concurrency
  control (a `version` column or equivalent, paired with `If-Match` /
  version-on-update semantics in the API).
- Existing mutable resources MUST NOT be retrofitted without an approved
  schema/migration slice.
- Last-write-wins MUST be explicitly justified (in the spec or plan)
  whenever it is chosen.
- The chosen concurrency posture per entity is documented in the entity's
  spec.

## Per-Tenant Resource Isolation

- Per-tenant request quotas / rate limits SHOULD be applied to ingestion-
  heavy and bulk-write endpoints (POS sync, bulk import). Specific limits
  are decided per-feature, not improvised in code.
- Per-tenant queue/job quotas SHOULD prevent one tenant's bulk import
  from starving others. Default queue concurrency is shared; tenant-aware
  fair-sharing MUST be considered before any bulk-ingestion feature ships.
- Connection-pool noisy-neighbor protection (per-tenant connection caps,
  statement timeouts) is reviewed before ingestion features ship.
- The first POS sync feature MUST land with a documented per-tenant
  resource isolation posture, even if values are initial defaults.

## API Conventions

- **OpenAPI source of truth**: `packages/contracts/openapi/*.yaml`.
- **Stable `operationId`** per endpoint. Renames are breaking.
- **No raw DB entities** in responses; every response is an explicit
  wire shape (e.g., a `toBody()` projection).
- **Uniform error envelope**:
  ```json
  { "error": { "code": "...", "message": "...", "request_id": "...", "details": { } } }
  ```
- **Status code mapping** is canonical: `400` validation, `401` unauth,
  `403` insufficient-role-within-resolved-tenant, `404` not-found-or-
  cross-tenant, `409` conflict, `429` rate-limited, `5xx` internal.
- **Cross-tenant access uses 404**, not 403 (per Principle II / XII).
- **Conformance tests required**: every contract YAML is exercised
  against runtime responses in CI.

## PII & Data Lifecycle

- Persisted fields SHOULD be classified (PII / payment / business /
  public). Each class has a documented retention window.
- Right-to-erasure is a first-class flow; audit immutability is preserved
  by tombstoning PII fields rather than deleting audit rows.
- Logging redaction is mandatory at the logger boundary.
- JobIds and observability tags MUST NOT carry PII.
- Soft-delete is the default for tenant, store, membership, user; hard-
  delete is privileged and audited.
- Cross-border / data-residency posture is stated even when single-region.

## Testing Policy

- Tests are written before implementation merges (RED → GREEN → IMPROVE).
- Tenant isolation is covered with Testcontainers (or an equivalent
  real-Postgres harness) where possible.
- RLS bypass probes, cross-tenant sweeps, cross-store sweeps, and
  malicious-override tests are required (per Principle VI).
- Frontend-bypass probes (curl-style request bypassing the dashboard)
  confirm server-side authorization (per Principle III).
- Coverage threshold ≥80% for application code.
- `MIGRATION_TEST_ALLOW_SKIP=1` is allowed for local Docker-less runs
  ONLY where the test code already supports it. CI MUST run with
  Testcontainers enabled.

## Scope Boundaries

- The POS app remains a separate repository.
- POS integrates only through documented APIs (`packages/contracts/openapi/`).
- Dashboard UI, billing, reports, dbt/analytics implementation, and full
  catalog implementation are **out of scope** unless explicitly approved
  in a spec.
- `package.json`, `pnpm-lock.yaml`, DB schema (Drizzle TypeScript schemas),
  and SQL migration files MUST NOT be changed without explicit approval
  recorded in the spec/plan/task.
- Drive-by dependency bumps and silent schema drift are violations.

## Analytics and Data Pipeline Standards

Analytics is a supporting concern of this repository, not its primary
identity. When analytics work happens here:

- **Layering**: `staging → intermediate → marts`. Cross-layer skips
  require justification in the model's spec.
- **Naming**: `stg_<source>__<entity>`, `int_<purpose>`,
  `<domain>__<entity>` for marts.
- **Materialization defaults**: `view` for staging, `table` for
  intermediate, `incremental` or `table` for marts (justify
  `incremental` strategy in the model config).
- **DataGraph for big lineage**: any model whose lineage exceeds **5
  upstream sources** OR **3 transformation layers** MUST have a lineage
  artifact (dbt docs DAG export, Mermaid diagram, or equivalent)
  committed under `docs/lineage/` and referenced from the model's spec.
- **Tests**: dbt models ship with at minimum `unique` + `not_null` on
  the grain key, plus relationship and accepted-values tests where
  applicable.
- **Tenant scoping**: analytics that surface tenant data MUST preserve
  tenant isolation end-to-end; do not strip `tenant_id` in transformation
  layers unless the mart is explicitly cross-tenant aggregate-only.

These standards apply equally to non-dbt analytics tooling (Python
notebooks, SQL scripts) where relevant.

## Governance

This Constitution supersedes ad-hoc conventions and prior-repo habits.
All PRs MUST include a "Constitution Check" line in the description
identifying which principles the change touches. PRs that violate a
principle MUST either (a) bring the change into compliance, or (b)
propose an amendment in the same PR with version bump and rationale.

**Amendment procedure**:
1. Open a PR that edits `.specify/memory/constitution.md` and increments
   the version.
2. Update the Sync Impact Report comment at the top.
3. Propagate changes to `.specify/templates/*.md`, agent guidance files
   (CLAUDE.md, CONTRIBUTING.md), and the active feature's Constitution
   Check tables (spec.md §14, plan.md §2/§7).
4. Merge requires explicit acknowledgement that dependent artifacts were
   reviewed.

**Versioning policy** (semantic):
- **MAJOR**: Backward-incompatible removal or redefinition of a
  principle/section, redefinition of repository identity, or addition of
  new non-negotiable principles.
- **MINOR**: New supporting section or materially expanded clause within
  an existing principle that does not change prior compliance posture.
- **PATCH**: Clarifications, wording fixes, non-semantic edits.

Amendments to Principles IX–XIV follow the same MAJOR-bump treatment as
I–VIII.

**Compliance review**: A lightweight review of constitution adherence
SHOULD occur at the close of each milestone or quarterly, whichever
comes first. Findings feed back into amendments.

## Working Agreement (appendix — operating rules, NOT a Core Principle)

Day-to-day agent + human operating rules that shape *how* work happens
(rather than *what* the system must guarantee) are recorded in
[`CLAUDE.md`](../../CLAUDE.md) and [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
They are not Core Principles because they describe agent–human
collaboration and PR hygiene, not system invariants. The Constitution
Check on a PR does not gate against the Working Agreement; it gates
against Principles I–XIV.

The Working Agreement covers, at minimum:
- Always start from latest `origin/main`.
- Work in thin, reviewable slices.
- Before implementation, produce a pre-flight plan showing the exact task
  text from `tasks.md` and the relevant OpenAPI contract surface.
- Before implementation, produce or update the **Architecture Impact
  Map** for the affected spec or plan per
  [`.specify/memory/architecture-impact.md`](architecture-impact.md).
  Small bugfixes, test-only changes, and documentation-only changes MAY
  state "No architecture impact" with a brief explanation.
- Do not implement until approved.
- Do not commit until explicitly instructed.

Updates to the Working Agreement live in CLAUDE.md / CONTRIBUTING.md and
do not require a Constitution version bump.

---

**Version**: 3.0.1 | **Ratified**: 2026-05-01 | **Last Amended**: 2026-05-06
