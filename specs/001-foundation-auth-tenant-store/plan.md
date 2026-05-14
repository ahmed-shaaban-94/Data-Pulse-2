# Implementation Plan: Foundation — Auth, Tenants, Stores, Roles

**Feature ID**: 001
**Spec**: [spec.md](./spec.md) (commit `4692537`)
**Constitution**: v3.0.0 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: `claude/foundation-auth-tenant-store`
**Status**: Draft (Phase 2 planning complete — no code generated)
**Created**: 2026-05-01
**Last revised**: 2026-05-01 (stack: Python → TypeScript)
**Owner**: Ahmed Shaaban

> **Scope guardrail**: This plan covers ONLY the foundation entities and APIs
> described in spec §6.1–§6.9. It does NOT plan product catalog, inventory,
> orders, payments, billing, reports, analytics pipelines, POS sync endpoints,
> **or any dashboard UI work** (no scaffolding, no login page, no protected
> dashboard flows). The dashboard / web frontend is **deferred to a separate
> feature** that will consume the API contracts produced here. POS-related
> work is limited to **integration seams** (data shape + auth subsystem
> extensibility) — no POS endpoints are designed here.

---

## 1. Technical Context

### 1.1 Stack decisions (TypeScript-first; revisable in `/speckit-clarify`)

| Concern | Decision | Rationale | Alternatives considered |
|---|---|---|---|
| **Language / runtime** | Node.js 20 LTS, TypeScript 5.x (strict) | Mainstream type-safe SaaS stack; matches the dashboard choice; first-class async I/O; rich ecosystem for OpenAPI / queue / observability tooling. | Python, Go, Bun (consider for runtime later — TypeScript code stays portable). |
| **Monorepo manager** | pnpm 9+ workspaces | Disk-efficient, strict resolution, fast; the de-facto choice for TS monorepos in 2026. | npm workspaces (slower), Yarn Berry (PnP friction). |
| **Build graph (optional)** | Turborepo, adopted only when local task graphs justify it | Plain pnpm scripts cover v1; Turborepo is opt-in once the workspace has > 3 buildable packages. | Nx (heavier), Lerna (legacy). |
| **API framework** | NestJS 10+ | Opinionated DI fits the guard / interceptor / pipe model used for authz, tenant context, audit emission; first-class OpenAPI generation; battle-tested testing utilities. | Fastify + plugins (more wiring), Hono (newer/lighter, fewer batteries), Express (under-structured at this scope). |
| **Frontend (dashboard)** | **Out of scope of this feature.** A separate dashboard feature will choose and scaffold the frontend. The contracts produced here (OpenAPI 3.1 in `contracts/`) are designed to be language-agnostic so any frontend can consume them. | n/a — choice deferred. |
| **Worker app** | NestJS standalone Node worker + BullMQ | Reuses the API app's DI graph and shared services; BullMQ provides retries, backoff, repeat jobs, DLQ. | Plain Node + BullMQ (loses DI parity), Temporal (overkill for v1). |
| **Database** | PostgreSQL 16+ | Constitution III mandates Postgres as system of record; RLS, partial indexes, JSONB, exclusion constraints. | None — constitutional. |
| **ORM** | Drizzle ORM (TypeScript) | SQL-first, type-safe, transparent. Explicit query construction is exactly what tenant-scoped helpers need. Lightweight runtime; no codegen required for runtime use. | Prisma (heavier client + migration tooling), Kysely (lower-level, more wiring), raw SQL via `pg` (rejected — repetitive). |
| **Migrations** | Drizzle Kit producing **explicit SQL migration files** committed to the repo, applied via a thin runner | Constitution VIII demands reviewable, versioned migrations; SQL files are auditable and tool-agnostic. | Atlas (consider), hand-rolled SQL, ORM auto-migrate (rejected). |
| **Queue / cache / rate-limit / locks** | Redis 7+ | Required by BullMQ; reused for session-cache, rate limiting, idempotency-key store, distributed locks. | None viable for the queue (BullMQ requires Redis). |
| **Worker queue** | BullMQ (latest) | Mature; observable; pairs naturally with Redis; supports retries, backoff, repeatable jobs, DLQ, parent/child flows. | bee-queue (less active), Bullboard alternatives. |
| **API style** | REST + JSON, OpenAPI 3.1 contracts of record under `contracts/` | Constitution IV mandates documented, versioned APIs. | GraphQL (rejected — POS contract clarity matters more than client flexibility), gRPC (rejected — wrong audience). |
| **Validation** | Zod 3.x at every boundary; **OpenAPI as source of truth**, Zod schemas validated against it (and runtime-validated requests). Generation utilities (`zod-to-openapi`, `nestjs-zod`) used where practical. | Type inference + runtime checks at the same boundary; reduces drift between schema and code. | class-validator (NestJS default — works but more boilerplate), Yup, ArkType. |
| **Auth — dashboard humans** | httpOnly **secure session cookie** (SameSite=Lax), server-side session store (Postgres of record + Redis cache) | Q3 default A: single session, switchable via context-switch endpoint. CSRF mitigated by SameSite + double-submit token where needed. | JWT-only (rejected — revocation hard). |
| **Auth — API & future POS** | **Opaque, server-validated, revocable bearer tokens** | FR-POS-SEAM-2: per-device credentials revocable at any time. Stored hashed; instant revocation by writing `revoked_at`. | JWT for POS (rejected), shared secrets (forbidden). |
| **Password hashing** | argon2id via the `argon2` Node package (native bindings) with OWASP 2025 defaults | Maintained; constant-time native impl; standard PHC string output. | bcrypt (`bcrypt` npm, acceptable fallback), `@node-rs/argon2` (Rust-native — viable alternative to keep in mind). |
| **ID strategy** | UUIDv7 for all public/external IDs (via `uuid` v10+ or `uuidv7` npm). Fallback to UUIDv4 documented if v7 lib instability is detected. | Time-ordered insert locality; safe to expose. | bigserial (enumerable; rejected externally), ULID (comparable; weaker PG tooling). |
| **Email delivery** | Provider-agnostic adapter; concrete provider chosen at deployment time (PQ-1 deferred) | Verification + invite + password-reset are the only required flows for v1. | SES, SendGrid, Postmark, Mailgun — defer. |
| **Test framework** | **Jest** + Supertest (HTTP) + `@testcontainers/postgresql` (DB) + ioredis-mock or real Redis for queue tests | NestJS scaffolding defaults to Jest; the broader Nest + BullMQ + Drizzle testing patterns are heavily Jest-documented. Vitest considered and viable (faster, ESM-native) — Jest chosen for v1 to spend time on isolation tests, not on test-runner debate. | Vitest (alternative, revisit if Jest performance becomes a problem), Mocha (legacy). |
| **Contract testing** | OpenAPI request/response validation: in-test assertions against the committed YAMLs (e.g., `openapi-validator` style middleware in test mode) | Constitution IV — contracts are the source of truth, code must conform. | Pact (consumer-driven; deferred). |
| **Lint / format / types** | ESLint (`typescript-eslint`) + Prettier + `tsc --strict --noUncheckedIndexedAccess` | Standard 2026 TS toolchain. | Biome (consider for speed). |
| **Observability** | `pino` (structured JSON logs) + OpenTelemetry SDK (HTTP, Postgres, Redis, BullMQ instrumentations) + Prometheus exporter | Constitution VII: structured logs with `tenant_id`/`request_id`, plus metrics; OTel keeps export vendor-neutral. | Winston (older), platform-locked agents. |
| **Container / runtime** | Docker; one image per app (api, worker, web) built from a single pnpm workspace; production process supervised by the container orchestrator | Constitution VIII: reproducible from a checked-out commit. | Bare Node on a VM (rejected for prod). |

### 1.2 Inputs from the spec

- 39 functional requirements (FR-AUTH-1..6, FR-TEN-1..6, FR-STORE-1..5, FR-ROLE-1..5, FR-ACCESS-1..4, FR-CTX-1..6, FR-ISO-1..4, FR-AUDIT-1..3, FR-POS-SEAM-1..3).
- 11 conceptual entities (User, Tenant, Store, Membership, StoreAccess, Role, Permission, Session, AuditEvent, Invitation, Device-future-only).
- 9 success criteria (SC-1..9).
- 12 assumptions (A-1..12), 3 open questions resolved to defaults A/C/A (Q1/Q2/Q3).

### 1.3 NEEDS CLARIFICATION (resolved → see research.md)

- ✅ Stack — Node.js / TypeScript / NestJS / Drizzle (T-1).
- ✅ Worker stack — BullMQ on Redis (T-2).
- ✅ Token strategy for future POS — opaque, revocable, hashed-at-rest bearer (T-3).
- ✅ Tenant isolation enforcement — DB constraints + Drizzle tenant-scoped helpers + Postgres RLS + tests (T-4).
- ✅ Identifier strategy — UUIDv7 for external IDs, UUIDv4 fallback (T-5).

All five technical unknowns are resolved with defaults documented in
[`research.md`](./research.md). Each is reversible; the spec's behavioral
requirements are stack-agnostic.

### 1.4 Suggested workspace layout (pnpm)

> Documentation only — actual scaffolding belongs to `/speckit-tasks`.

```
/ (repo root)
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ api/               # NestJS backend API
│  └─ worker/            # NestJS standalone + BullMQ workers
│                        # (no apps/web in this feature — deferred to a
│                        #  separate dashboard feature)
├─ packages/
│  ├─ db/                # Drizzle schema + migration SQL files + query helpers
│  ├─ contracts/         # OpenAPI YAMLs (mirrors specs/.../contracts/) + generated TS types
│  ├─ auth/              # session/token logic shared between api and worker
│  └─ shared/            # Zod schemas, error envelopes, logger, OTel setup
├─ specs/                # speckit specs (this directory)
└─ .specify/             # constitution, templates, feature pointer
```

Apps depend on packages; packages do not depend on apps. Single `tsconfig.base.json` enforces strict compiler flags across the workspace. The eventual dashboard feature can add an `apps/web` (or another frontend) without modifying anything produced here.

---

## 2. Constitution Check (initial gate)

Against constitution v3.0.0:

| Principle | Plan-level alignment | Status |
|---|---|---|
| I. Reference, Not Source of Truth | No legacy `Data-Pulse` code is reused. Stack chosen on current merits. | ✅ |
| II. Multi-Tenant SaaS by Default | `tenant_id NOT NULL` on every tenant-owned table; RLS policies; Drizzle helper functions default to tenant-scoped queries; cross-tenant isolation tests in §6 of plan. | ✅ |
| III. Backend Authority & Data Integrity (NON-NEGOTIABLE) | DB constraints (FK, CHECK, partial unique indexes, RLS); NestJS guards enforce server-side authz at every endpoint; cache strictly reconstructible from Postgres. | ✅ |
| IV. Contract-First POS Integration | OpenAPI 3.1 YAMLs checked into `contracts/` as source of truth; versioning via `/api/v1/...` and `/api/pos/v1/...` namespace; idempotency-key infrastructure exists at the platform level. | ✅ |
| V. Async Work Belongs in Workers | BullMQ jobs with idempotent handlers; webhook delivery (future), email send, audit-log fan-out, session revocation propagation are worker-bound. | ✅ |
| VI. Test-First Quality | Plan defines red→green order; cross-tenant + cross-store isolation tests required per protected endpoint; ≥80% coverage. | ✅ |
| VII. Observable Systems | pino structured logs with `tenant_id`/`request_id`, OTel traces, Prometheus metrics, no secrets/PII in logs by policy. | ✅ |
| VIII. Reproducible & Versioned Releases | Drizzle SQL migrations + CHANGELOG.md + pinned deps (pnpm lockfile) + Docker images + API version `v1` from day one. | ✅ |
| IX. Source-of-Truth Model | Not exercised — plan covers identity/tenancy/auth only. No catalog / sales / POS-event entities in data-model.md. SaaS-as-truth half (tenants/stores/memberships/integration credentials) is implemented; Global / Tenant / Store / SaleLine layers bind future features. | n/a (out of scope) |
| X. Retail Temporal Semantics | Not exercised — no sale, order, or POS-event tables. `audit_events.occurred_at` is the only retail-style temporal field and is single-purpose. Per-entity timestamp catalogs bind future features. | n/a (out of scope) |
| XI. Idempotency & External IDs | Plan acknowledges — `idempotency_keys` table reserved at the platform level (data-model.md §13); helper implementation is tasks T260–T261; POS-seam walkthrough is T264–T265. No real endpoint consumes it in this feature. | Acknowledged; impl pending T260–T265 |
| XII. Authorization & Object Safety | Plan satisfies — Zod `.strict()` ValidationPipe, command DTOs per endpoint, server-resolved tenant/store context, RolesGuard with `denyAs: 404` default for cross-tenant non-disclosure, default-deny test (T206), no body-supplied tenant/store ids. | ✅ |
| XIII. Auditability & Provenance | Plan acknowledges — `audit_events` table designed in data-model.md; `AuditEmitter` interceptor + `audit-fanout` worker are tasks T230–T238; insert-only posture and anonymous-actor pattern are explicit task acceptance criteria (T237/T238). | Acknowledged; impl pending T230–T238 |
| XIV. PII & Data Lifecycle Discipline | Plan satisfies posture — pino redaction list (research.md PQ-4/PQ-5), no-PII-in-jobIds policy in producer specs, soft-delete retention worker (T312), invitation secret hashing (T172), audit-log retention (T311). Full classification taxonomy and right-to-erasure flows bind future specs. | ✅ (posture); taxonomy deferred |

**Result**: No initial gate violations.

---

## 3. Architecture Overview

### 3.1 Components

```
                      ┌──────────────────────────────┐
                      │  API consumers                │
                      │  (future dashboard feature +  │
                      │   future POS app + any other  │
                      │   OpenAPI-conformant client)  │
                      └──────────────┬───────────────┘
                                     │  HTTPS
                                     ▼
                      ┌──────────────────────────────┐
                      │  apps/api  (NestJS)           │
                      │  ─ AuthModule (cookie+token)  │
                      │  ─ ContextModule (tenant/     │
                      │    store switch)              │
                      │  ─ TenantsModule, StoresModule│
                      │    MembershipsModule          │
                      │    InvitationsModule          │
                      │    AuditModule (read API)     │
                      │  ─ Guards: AuthGuard,         │
                      │    TenantContextGuard,        │
                      │    RolesGuard                 │
                      │  ─ Interceptors: RequestId,   │
                      │    Logging, AuditEmitter      │
                      │  ─ DB session per request:    │
                      │    SET LOCAL app.current_*    │
                      └────┬───────────────┬─────────┘
                           │ enqueues       │ reads/writes
                           ▼               ▼
              ┌────────────────────┐  ┌────────────────────┐
              │  apps/worker       │  │  PostgreSQL 16+     │
              │  NestJS standalone │  │  ─ Drizzle schema   │
              │  + BullMQ workers  │  │  ─ FK + CHECK +     │
              │  ─ EmailQueue      │  │    partial uniques  │
              │  ─ AuditFanoutQ.   │  │  ─ RLS policies     │
              │  ─ SessionRevokeQ. │  │  ─ SQL migrations   │
              │  ─ (POS webhook    │  │    via Drizzle Kit  │
              │     workers later) │  └────────────────────┘
              └─────────┬──────────┘
                        │ uses
                        ▼
              ┌────────────────────┐
              │  Redis 7+           │
              │  ─ BullMQ queues    │
              │  ─ Session cache    │
              │  ─ Rate limits      │
              │  ─ Idempotency keys │
              │  ─ Distributed locks│
              └────────────────────┘
```

### 3.2 Request lifecycle (authenticated dashboard request)

1. Request arrives at `apps/api`. A **RequestId interceptor** assigns `request_id` (UUID).
2. **AuthGuard** reads either the session cookie (dashboard) or `Authorization: Bearer <opaque>` (API). Resolves the user (Postgres of record, Redis cache). On miss → 401.
3. **TenantContextGuard**:
   - Reads `active_tenant_id` from the session/token (set previously via the context-switch endpoint).
   - Validates the user has an active membership in that tenant.
   - For store-scoped endpoints, reads `active_store_id` and validates `store ∈ tenant ∧ user has access`.
   - On any failure, returns a non-leaking 401/403/404 (per FR-ISO-4 the same shape as not-found).
4. **RolesGuard** (decorator-driven) evaluates the endpoint's required role/permission against the membership's role.
5. The handler runs. The DB middleware opens a transactional Drizzle session and issues:
   - `SET LOCAL app.current_tenant = '<uuid>'`
   - `SET LOCAL app.is_platform_admin = '<true|false>'`
   so all RLS policies apply for the duration of the request.
6. **AuditEmitter interceptor** (post-response) enqueues a BullMQ job to insert an `AuditEvent` for any auditable action.
7. **Logging interceptor** emits a structured pino line: `request_id`, `tenant_id`, `user_id`, route, status, latency, `trace_id`.

### 3.3 Tenant isolation defense in depth

| Layer | Mechanism | Failure mode if bypassed |
|---|---|---|
| Auth | Session cookie / bearer token resolves user; missing → 401. | Anonymous access — caught upstream. |
| Tenant context | `TenantContextGuard` resolves active tenant server-side from the session/token; never from a request body/header alone. | Missing context → 401/403. |
| RBAC | `@Roles(...)` decorator + `RolesGuard` block before handler runs. | 403. |
| Drizzle helpers | `withTenant(tx, tenantId)` returns a scoped query builder that injects `WHERE tenant_id = :tenantId` automatically. Direct unscoped queries are forbidden in handlers (lint rule + code review). | Cross-tenant query — caught at code-review or lint. |
| Postgres RLS | Row-level security policy on every tenant-scoped table; `app.current_tenant` GUC set per transaction. | Even raw SQL outside Drizzle cannot read other tenants. |
| Tests | Jest + Supertest + Testcontainers tests assert tenant A cannot read tenant B's resources via ID, query, or batch endpoint; raw-SQL probe verifies RLS independently. | CI fails. |

The canonical regression catalog for all tenant-isolation scenarios is [`tenant-isolation-matrix.md`](./tenant-isolation-matrix.md). Future test-implementation slices that add or change isolation behavior MUST update the matrix's coverage state.

---

## 4. Phase 0 — Outline & Research

Generated artifact: [`research.md`](./research.md)

Resolves the five technical unknowns enumerated in §1.3 with Decision /
Rationale / Alternatives sections.

---

## 5. Phase 1 — Design & Contracts

### 5.1 Generated artifacts

- [`data-model.md`](./data-model.md) — physical model (tables, columns, constraints, indexes, RLS policies, invariants) translating spec §7 entities. Drizzle is the ORM; migration files are explicit SQL.
- [`contracts/`](./contracts/) — OpenAPI 3.1 schemas (language-agnostic):
  - [`contracts/auth.openapi.yaml`](./contracts/auth.openapi.yaml)
  - [`contracts/context.openapi.yaml`](./contracts/context.openapi.yaml)
  - [`contracts/tenants.openapi.yaml`](./contracts/tenants.openapi.yaml)
  - [`contracts/stores.openapi.yaml`](./contracts/stores.openapi.yaml)
  - [`contracts/memberships.openapi.yaml`](./contracts/memberships.openapi.yaml)
  - [`contracts/audit.openapi.yaml`](./contracts/audit.openapi.yaml)
  - [`contracts/README.md`](./contracts/README.md)
- [`quickstart.md`](./quickstart.md) — verifier walkthrough at the behavior level (no language-specific commands).

### 5.2 What is intentionally NOT in Phase 1

- TypeScript source code, NestJS modules/services, Drizzle schema files, BullMQ job handler bodies, route handler bodies.
- Concrete SQL migration files. Migration shape and order are described in `data-model.md`; actual `drizzle/0000_*.sql` generation is `/speckit-tasks` work.
- POS-facing endpoint contracts. Reserved namespace `/api/pos/v1/...` is documented in `contracts/README.md`; no schemas inside it yet.
- **All dashboard / web frontend work** — no `apps/web`, no Next.js scaffold, no login page, no protected dashboard flows. The dashboard is a separate feature that will consume the OpenAPI contracts produced here.
- Deployment topology, infra-as-code, CI/CD pipeline definition.

---

## 6. Phase 2 — Task Decomposition Strategy

**Not executed in this plan.** Outlined here so `/speckit-tasks` can lift it.

Recommended task ordering (TDD per Constitution VI; Jest + Supertest +
Testcontainers throughout):

1. **Workspace foundations** — pnpm-workspace, `tsconfig.base.json`, ESLint + Prettier, root scripts. Empty `apps/api`, `apps/worker`, `packages/db`, `packages/contracts`, `packages/auth`, `packages/shared` placeholders. *No business code yet. No `apps/web` — the dashboard is deferred to a separate feature.*
2. **Local infra** — `docker-compose.yml` (developer-facing, not prod) bringing up Postgres 16 + Redis 7. Health-checked.
3. **`packages/db` scaffolding** — Drizzle schema files for all entities in `data-model.md`; first SQL migration creating tables, FKs, partial unique indexes, CHECK constraints, RLS enable + policies, triggers (`updated_at`). Reviewable by humans.
4. **`packages/shared`** — Zod base schemas (Email, Slug, UUID), error envelope type, pino logger config, OTel setup helpers. Tested in isolation.
5. **`packages/auth`** — password hashing helper (argon2), token-hash helper, session/token shape types, validation. Tests first.
6. **API skeleton (`apps/api`)** — NestJS app bootstrap with global ValidationPipe (Zod), RequestIdInterceptor, LoggingInterceptor, ExceptionFilter (uniform error envelope), OpenAPI loader from `packages/contracts`.
7. **Identity domain (red→green)** — user creation, password verification, email verification flow. Cross-tenant isolation N/A (users are tenant-agnostic) but RLS-bypass tests for user table still required.
8. **Authentication endpoints** — `POST /auth/signin`, `signout`, `refresh`, password-reset request/confirm, email-verify request/confirm. Tests first (happy + 401 + rate-limit + revocation).
9. **Tenant + store + membership admin endpoints** — Tests for create/list/update/soft-delete with cross-tenant + cross-store isolation; then handlers.
10. **Active context endpoints** — Tests for switch-tenant, switch-store, including the cross-tenant rejection path; then handlers.
11. **Authorization layer** — `@Roles(...)` decorator + `RolesGuard` + per-endpoint role tests.
12. **RLS verification suite** — Testcontainers spins up Postgres; a test connects with `app.current_tenant` set to tenant B and confirms it cannot see tenant A's rows even via raw SQL on the same connection.
13. **Audit pipeline** — `AuditEmitter` interceptor + BullMQ `audit-fanout` worker that inserts `audit_events`. Tests assert the expected events fire on the auditable actions; PII redaction tested explicitly.
14. **Idempotency-key infrastructure (platform-level)** — Redis-backed store with documented key schema `{tenant}:{store}:{client}:{key}` and a Postgres mirror (`idempotency_keys`). Used by no real endpoint yet (POS will adopt later); the helper is unit-tested.
15. **Worker app (`apps/worker`)** — NestJS standalone bootstrap, BullMQ queue registration (email, audit-fanout, session-revoke), retry/backoff/DLQ policies, OTel propagation. Each handler tested with ioredis-mock or a real Redis (Testcontainers).
16. **Observability bring-up** — pino config, OTel exporter (OTLP), minimum metrics (request rate / error rate / latency p50/p95/p99 / queue depth / job success/fail).
17. **Contract conformance tests** — load each YAML in `contracts/` and assert the API's runtime responses validate against it.
18. **POS-seam validation** — a *test* (not an endpoint) that walks through the SC-8 thought experiment: a hypothetical POS endpoint can attach to the existing data model and idempotency platform without schema changes. Keeps the seam honest.
19. **(Web app deferred)** — The dashboard / web frontend is **deferred to a separate dashboard feature**. This feature only guarantees the API contracts (OpenAPI 3.1 in `contracts/`) needed by future dashboard implementation. No `apps/web`, no Next.js scaffold, no login page, no protected dashboard flows are produced by this feature.

Each task has acceptance: tests added (red), implementation added (green),
constitution check stamp.

---

## 7. Constitution Check (post-design re-evaluation)

Re-checked after Phase 1 artifacts were drafted under the TypeScript stack:

| Principle | Post-design verdict |
|---|---|
| I — Reference only | No legacy import. Schema and contracts are independently derived. ✅ |
| II — Multi-tenant default | Every tenant-owned table in `data-model.md` has `tenant_id` NOT NULL + RLS; Drizzle helpers default to tenant scoping. ✅ |
| III — Backend authority | NestJS guards enforce authz at every endpoint; DB constraints + RLS layered; cache use is read-through only. ✅ |
| IV — Contract-first POS | OpenAPI YAMLs are source of truth and committed; `/api/pos/v1/` namespace reserved; idempotency platform exists. ✅ |
| V — Async work in workers | Email, audit fan-out, session revocation, future webhook delivery, future POS sync — all BullMQ jobs in `apps/worker`. ✅ |
| VI — Test-first | Phase 2 task order is RED→GREEN; cross-tenant + cross-store + RLS tests are mandatory. ✅ |
| VII — Observable | pino + OTel + Prometheus + audit table; no secrets/PII in logs by policy. ✅ |
| VIII — Reproducible | Drizzle SQL migrations + pnpm lockfile + Docker images + CHANGELOG; API v1 from day one. ✅ |
| IX — Source-of-truth model | Not exercised by this feature — no catalog / sales / POS-event entities in the post-design data model. SaaS-as-truth half (tenants/stores/memberships/integration credentials) is in scope and implemented. ⏭ out of scope |
| X — Retail temporal semantics | Not exercised — no sale or POS-event entities post-design. `audit_events.occurred_at` is single-purpose. ⏭ out of scope |
| XI — Idempotency & external IDs | `idempotency_keys` table present in data-model.md §13; helper + POS-seam walkthrough are tasks T260–T265. ⏳ acknowledged; impl pending |
| XII — Authorization & object safety | Zod `.strict()` body validation across endpoints, command DTOs, RolesGuard `denyAs: 404` default, default-deny test (T206), server-resolved tenant/store context, no body-supplied tenant/store ids. ✅ |
| XIII — Auditability & provenance | `audit_events` table designed insert-only with anonymous-actor support; emitter + worker pending T230–T238. ⏳ acknowledged; impl pending |
| XIV — PII & data-lifecycle | pino redaction at the logger boundary; no-PII-in-jobIds policy; soft-delete + retention workers (T311, T312); invitation secret hashing (T172); classification taxonomy deferred to future spec. ✅ (posture) |

**Result**: No post-design violations.

---

## 8. Risks & Mitigations (plan-level)

| ID | Risk | Mitigation |
|---|---|---|
| PR-1 | RLS policies become a debugging trap (silent empty result sets). | Plan §6 Task 12 mandates an RLS-specific test. Quickstart documents the `app.current_tenant` GUC contract. Drizzle session helper logs (in dev) when GUC is unset. |
| PR-2 | Session/Redis becomes load-bearing (cache-as-truth temptation). | Sessions persist in Postgres; Redis is read-through. Quickstart's failure-mode test deletes the Redis key and confirms session still resolves. |
| PR-3 | Token strategy for POS (opaque) requires custom revocation infrastructure. | research.md T-3 covers; implementation is platform-level (idempotency + revocation share table). |
| PR-4 | argon2id parameters are CPU-bound and may slow login under load. | Document parameters in research.md; benchmark in Phase 2 task 8 acceptance. Consider `@node-rs/argon2` if the native `argon2` package's perf is insufficient. |
| PR-5 | Q1/Q2/Q3 spec defaults may be flipped after planning. | All three are isolated: Q1 affects only the tenant-creation endpoint; Q2 affects only role evaluation logic; Q3 affects token shape. Plan structure absorbs flips without redesign. |
| PR-6 | Drizzle is younger than Prisma; ecosystem maturity gaps may surface. | The choice is reversible — Drizzle's schema-as-TS is portable to Kysely or Prisma if needed. SQL migrations are tool-agnostic. |
| PR-7 | UUIDv7 library instability. | T-5 explicitly allows UUIDv4 fallback; the column type (`uuid`) and external-ID exposure don't change. |
| PR-8 | NestJS DI overhead in cold starts (worker bootstrap). | NestJS standalone bootstrap is < 200ms; if cold-start matters in serverless workers, switch the worker to a plain Node + BullMQ shape (handler interfaces are portable). |

---

## 9. Open Questions (plan-level — beyond spec Q1/Q2/Q3)

> Items the planner identified that are NOT covered by the spec or by the
> applied technical defaults. Resolve before `/speckit-tasks`.

### PQ-1 — Email provider for verification/invite/password-reset

**Context**: FR-AUTH-5 requires email flows; none of them work without an SMTP/API provider.

**Options**: SES, Postmark, SendGrid, Mailgun, Resend, self-hosted SMTP.

**Default applied**: a provider-agnostic adapter interface in v1; concrete provider chosen at deployment time. The plan does not block on this.

### PQ-2 — Hosting / deployment target

**Context**: Constitution VIII demands a reproducible release; the *target* is not implied by the spec.

**Options**: cloud VM, managed container (Fly, Render, Railway), Kubernetes, serverless containers (Cloud Run).

**Default applied**: NONE. The plan produces Docker images for `apps/api` and `apps/worker` plus a SQL migration runner step; choice of host is deferred to a deployment spec. (Frontend hosting is not in scope — the dashboard is a separate feature.)

### PQ-3 — Multi-region / data residency

**Context**: SaaS customers may demand data residency. The data model is agnostic, but RLS and session caching change shape under multi-region.

**Default applied**: single-region for v1. Multi-region is an explicit non-goal of this plan.

### PQ-4 — Rate-limit policy specifics

**Context**: FR-AUTH-4 requires rate limiting; the *limits* are not specified.

**Default applied**: per-account 5 failures / 15 min lockout (then exponential backoff); per-IP 30 failed signins / hour; per-IP 100 password-reset requests / day. Implemented via a Redis-backed counter (e.g., `rate-limiter-flexible` or BullMQ-adjacent helper). Documented in research.md.

### PQ-5 — Session/refresh durations

**Context**: FR-AUTH-3 requires explicit expiry but doesn't pin numbers.

**Default applied**: dashboard session 12h sliding (max 24h absolute); API access token 1h; API refresh token 30d; future POS device token 90d (revocable instantly). Documented in research.md.

### PQ-6 — Soft-delete retention window

**Context**: FR-TEN-5 / FR-STORE-5 / A-5 require a retention window before hard delete; spec didn't pin a number.

**Default applied**: 30 days for tenant/store; immediate-with-audit for membership revocations. Documented in research.md.

### PQ-7 — OpenAPI generation method

**Context**: With Zod everywhere, we could generate OpenAPI from code instead of hand-writing YAMLs.

**Options**:
- **A**: OpenAPI YAMLs in `contracts/` are the **source of truth**; Zod schemas in code are validated against them in tests (current default).
- **B**: Zod schemas in code are the source of truth; OpenAPI YAMLs are generated via `zod-to-openapi` and committed.
- **C**: Hybrid — high-level shapes (paths, response codes) in YAML; field-level schemas auto-derived from Zod.

**Default applied**: **A**. Per Constitution IV the contract is the contract; code conforms. Revisit only if hand-maintenance becomes painful (>20 endpoints), at which point a generation pass is a localized refactor.

### PQ-8 — NestJS validation pipeline

**Context**: NestJS's default validation uses `class-validator`. We chose Zod.

**Default applied**: integrate Zod via `nestjs-zod` (or a lightweight Zod ValidationPipe). Class-validator is not used.

### PQ-9 — Audit log retention policy

**Context**: SC-7 requires a "documented retention period" for audit log rows; no period was specified in the spec. T311 was blocked pending this decision.

**Default applied**: 365 days from `audit_events.occurred_at`; mark-only action via a future `retention_marked_at timestamptz null` column; implementation ships in a separate approved PR. Full rationale and future implementation contract in [`audit-retention-decision.md`](audit-retention-decision.md).

---

## 10. Definition of Done (this plan)

This plan is "complete" when:

- [x] All five technical unknowns resolved in `research.md`.
- [x] `data-model.md` covers all 11 entities from spec §7 with constraints,
      indexes, and RLS.
- [x] `contracts/` contains OpenAPI for every endpoint family the spec
      requires (auth, context, tenants, stores, memberships, audit).
- [x] Constitution Check passes initial AND post-design (§7).
- [x] Risks and open questions explicitly listed (§8, §9).
- [x] Stack identity is TypeScript-first (NestJS / Drizzle / BullMQ / pnpm). Frontend stack is deferred to a separate dashboard feature.
- [x] No code generated, no tests written, no migrations created.
      (Those are `/speckit-tasks`.)
- [x] No POS endpoints designed; `/api/pos/v1/` namespace reserved only.

---

## 11. Approvals & Next Step

- [ ] Owner approves stack defaults (T-1..T-5) or revises via `/speckit-clarify`.
- [ ] Owner approves PQ-1..PQ-8 defaults or pins concrete answers.
- [ ] Run `/speckit-tasks` to decompose §6 into a numbered task list.

---

## 12. Post-implementation Constitution Check

Re-checked against **Constitution v3.0.1** (the v3.0.0 principle set,
clarification-only patch; 14 core principles unchanged).

Scope of evidence: the foundation backend as implemented through PR #150
(latest main SHA `081f373`). Deferred areas are explicitly noted; they do
not represent violations of the principle but rather boundaries of this
feature's scope.

| # | Principle | Post-implementation evidence | Status |
|---|---|---|---|
| I | Reference, Not Source of Truth | No code, schema, or contract was copied from the legacy `Data-Pulse` repo. Stack, schema, and contracts were independently designed via speckit. | ✅ |
| II | Multi-Tenant SaaS by Default | Every tenant-owned table carries `tenant_id NOT NULL` + FK + RLS policy (fail-closed `current_setting(..., true)` form). `TenantContextGuard` resolves active tenant server-side. `withTenant` helper enforces scoped queries. Cross-tenant non-disclosure (safe 404) enforced by `ExceptionFilter` + `RolesGuard`. Runtime DB role has no `BYPASSRLS`. Workers carry `tenantId` in job payload and set `app.current_tenant` before DB access. | ✅ |
| III | Backend Authority & Data Integrity (NON-NEGOTIABLE) | `AuthGuard` + `RolesGuard` + `TenantContextGuard` enforce server-side authz on every request. DB constraints (FK, CHECK, partial unique indexes, `NOT NULL`) encode invariants. Redis session cache is read-through only; PostgreSQL is system of record. Uniform error envelope `{ error: { code, message, request_id } }` enforced by global `ExceptionFilter`. Money representation deferred — no monetary fields in this feature. | ✅ (money deferred to future pricing/catalog spec) |
| IV | Contract-First POS Integration | OpenAPI 3.1 YAMLs in `packages/contracts/openapi/` are the source of truth for all implemented endpoints (auth, context, tenants, stores, memberships, audit). Contract-conformance tests cover `GET /tenants`, `GET /stores`, `PATCH /memberships` (additional slices in progress). API responses use explicit wire shapes via `toBody()`-style projections. `/api/pos/v1/*` namespace reserved (returns standard not-found envelope); no POS sync endpoints exist. | ✅ (conformance coverage expanding; POS sync out of scope) |
| V | Async Work Belongs in Workers | Email delivery (verify + password-reset), audit fan-out, and session revocation all run as BullMQ jobs in `apps/worker`. Each job carries `tenantId`/`correlationId`. Retry/backoff/DLQ defaults are configured per queue. OTel trace context propagates from API → worker via job payload. Failed-job log redaction enforced. Session-revoke processor and registry layers are implemented; runtime scheduling of that processor is wired via the queue defaults. Soft-delete sweep processor (T312) layer is scaffolded; **runtime sweep scheduling is not yet wired** (Layer A only). | ✅ for implemented workers; T312 runtime scheduling deferred |
| VI | Test-First Quality | All slices followed RED → GREEN → IMPROVE order. Unit coverage ≥ 80% enforced via Jest coverage thresholds per app/package. Testcontainers-backed migration integration test verifies all tables, FKs, constraints, RLS policies, and triggers. Cross-tenant and cross-store isolation tests exist for auth, tenants, stores, context, memberships, and audit layers. RLS bypass probe (`T207`) implemented. Frontend-bypass and default-deny probes implemented. SC-1..SC-9 formal verification pass not yet recorded — see T309 follow-up note. | ✅ (T309 SC verification not yet formally recorded) |
| VII | Observable Systems | `RequestIdInterceptor` assigns UUID per request; exposed in response header and pino log line. `LoggingInterceptor` emits structured pino JSON with `request_id`, `tenant_id`, `user_id`, route, status, latency, `trace_id`. OTel SDK wired for HTTP, Postgres, Redis, BullMQ. BullMQ job payloads carry `traceId`/`spanId` for cross-service trace propagation. No secrets, tokens, or PII appear in logs (redaction list enforced at logger boundary). Production metrics (queue lag, RLS failure rate) are instrumentable via OTel but not yet plumbed to an exporter — deferred to deployment spec. | ✅ (exporter target deferred to deployment spec) |
| VIII | Reproducible & Versioned Releases | Explicit SQL migration `0000_initial.sql` with paired rollback `0000_initial.down.sql` committed. `CHANGELOG.md` updated with v0.1.0 entry. pnpm lockfile pinned. Docker images produced per app. API versioned at `v1` from day one. No `package.json`, `pnpm-lock.yaml`, DB schema, or migration changes made without explicit task approval. | ✅ |
| IX | Source-of-Truth Model | SaaS-as-truth half fully implemented: tenants, stores, memberships, invitations, auth state, integration credentials are all SaaS-owned and PostgreSQL-authoritative. Global Catalog / Tenant Catalog / Store Override / SaleLine snapshot layers are not exercised by this feature — they bind future catalog and sales features. | ✅ for implemented scope; catalog/sales layers out of scope |
| X | Retail Temporal Semantics | No sale, order, or POS-event entities exist in this feature. `audit_events.occurred_at` is single-purpose and stored as `TIMESTAMPTZ` UTC. Security clocks (token expiry, session expiry, rate-limit windows) use server clock, not client-reported time. Per-entity timestamp catalogs bind future features. | ✅ for implemented scope; sales/POS temporal semantics out of scope |
| XI | Idempotency & External IDs | `idempotency_keys` table present in schema with Redis-primary + Postgres-mirror helper. Email and audit jobs are idempotent: retry produces same state, no duplicate side effects. Session-revoke processor is idempotent. No real consumer API endpoint uses `Idempotency-Key` yet — POS ingestion is out of scope. | ✅ (platform layer built; POS consumer out of scope) |
| XII | Authorization & Object Safety | Zod `.strict()` `ValidationPipe` rejects unknown request keys. Command DTOs omit `tenant_id`, `store_id`, `role`, `status`, `acceptedAt`, `createdBy`, `is_platform_admin`, and other mass-assignable fields. Object-level authorization enforced on every protected read and write via `TenantContextGuard` + `RolesGuard`. Cross-tenant lookups return safe 404. Default-deny test (T206) confirms unannotated endpoints fail closed. | ✅ |
| XIII | Auditability & Provenance | `AuditEmitter` interceptor enqueues a BullMQ job for each auditable action (auth sign-in/failure, role/access changes, context switch, soft-delete, platform-admin cross-tenant). `audit-fanout` processor inserts rows into `audit_events` (insert-only enforced at application layer). Anonymous-actor pattern implemented: pre-auth failures record `actor_user_id IS NULL` with `actor_label`. PII/credential redaction enforced at the emitter. `AuditController` provides tenant-scoped, cursor-paginated query API. **Audit log retention policy (T311) is not yet implemented** — blocked pending retention schema design decisions. | ✅ for audit capture and query; T311 retention policy deferred |
| XIV | PII & Data Lifecycle Discipline | pino redaction list enforced at the logger boundary (tokens, passwords, invitation secrets, payment data, PII beyond actor identifier are never logged). Job IDs and observability tags carry no PII. Soft-delete is the default for tenants, stores, memberships. Invitation secrets are hashed at rest (token visible once). Soft-delete sweep processor scaffolded (T312). **Audit log retention sweep (T311) pending**. Data classification taxonomy (PII / payment / business / public) and right-to-erasure flow are deferred to a future data-lifecycle spec. | ✅ (posture); T311 + classification taxonomy + right-to-erasure deferred |

### Known follow-up items

| Item | Status |
|---|---|
| T309 — SC-1..SC-9 formal verification against running system | Not yet recorded; follow-up task |
| T311 — Audit log retention policy (BullMQ scheduled sweep) | Blocked pending retention schema and design decisions |
| T312 — Soft-delete sweep runtime scheduling | Processor layer complete (Layer A); runtime cron wiring deferred |
| Contract-conformance coverage | Conformance tests exist for key endpoints; full sweep across all contract operations is in progress |
| OTel metrics exporter target | Instrumentation wired; exporter/sink target deferred to deployment spec |
| Data classification taxonomy + right-to-erasure flow | Deferred to future data-lifecycle spec |
| Money representation | No monetary fields in this feature; explicit representation must be defined before any catalog/pricing feature |

**Result**: All 14 Constitution v3.0.1 / v3.0.0 principles hold for the
implemented foundation scope. No violations. Deferred items are bounded to
out-of-scope concerns or explicitly tracked follow-up tasks.

---

**End of plan.**
