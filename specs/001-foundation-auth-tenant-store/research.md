# Phase 0 — Research

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Constitution**: v3.0.0
**Status**: Draft (no code, no migrations)
**Last revised**: 2026-05-01 (stack: Python → TypeScript)

This document resolves the technical unknowns enumerated in
[`plan.md` §1.3](./plan.md). Each entry is structured as
**Decision / Rationale / Alternatives**.

---

## T-1 — Backend stack

**Decision**: Node.js 20 LTS + TypeScript 5.x (strict) + NestJS 10+ for the API and worker apps; Drizzle ORM for the database layer; explicit SQL migrations via Drizzle Kit; pnpm workspaces for monorepo management. **The dashboard / web frontend is deferred to a separate feature** and is not chosen or scaffolded here.

**Rationale**:
- **TypeScript everywhere** lets the dashboard, API, and shared packages reuse types derived from OpenAPI/Zod with zero translation.
- **NestJS** maps cleanly onto the foundation's authorization model: `Guards` for auth + tenant context + roles, `Interceptors` for request-id/logging/audit emission, `Pipes` for validation. The DI container makes services like `TenantContextResolver` and `AuditEmitter` trivially testable.
- **Drizzle** is SQL-first and type-safe. Tenant-scoped helpers (e.g., `withTenant(tx, tenantId).select().from(stores)`) read like SQL while still benefiting from inferred types. Crucially, Drizzle does not hide the query — important because Constitution III treats the DB layer as authoritative, and silent ORM behavior is a liability.
- **Drizzle Kit's SQL migrations are committed as plain `.sql` files**, satisfying Constitution VIII's "reviewable, versioned migrations" requirement and remaining tool-agnostic if we ever swap ORMs.
- **pnpm** is fast, strict, and disk-efficient. Strictness aligns with the project's preference for explicit defaults.

**Alternatives considered**:
- **Python (FastAPI / SQLAlchemy / Alembic)** — was the v1 plan default. Rejected on revision in favor of TypeScript-first to match dashboard tooling and reduce stack surface.
- **Go (Fiber / sqlc / Goose)** — best raw performance; rejected because monorepo type-sharing with the dashboard is non-trivial.
- **Bun runtime** — promising; not yet stable enough for a system-of-record SaaS at the time of this plan. Reconsider in 6–12 months.
- **Prisma over Drizzle** — heavier client generation step, less SQL transparency for tenant-scoping audits. Drizzle better matches "the SQL is the contract."
- **Kysely over Drizzle** — comparable; Drizzle's schema definition is more ergonomic and the migration story is built-in.
- **Express + Zod + custom layering instead of NestJS** — workable for a smaller surface; chosen against because the foundation has many cross-cutting concerns (auth, tenant context, audit, observability) that Nest's interceptor/guard model already organizes.
- **Class-validator vs Zod** — Class-validator is NestJS's default but couples validation to TypeScript classes; Zod's plain-object schemas compose better with OpenAPI tooling.

**Reversibility**: HIGH at the spec level. The behavioral contract in `spec.md` is stack-agnostic. Drizzle schema definitions translate to Prisma/Kysely if needed; NestJS handler shapes translate to Fastify/Express; SQL migrations are tool-agnostic.

---

## T-2 — Worker stack

**Decision**: BullMQ on Redis 7+, run inside a NestJS standalone process (`apps/worker`).

**Job semantics**:
- Each job has a unique queue and a typed payload (Zod-validated at enqueue time).
- Handlers MUST be idempotent and side-effect-safe under retry.
- Default retry policy: 5 attempts, exponential backoff (`min(2^n, 60) sec`), DLQ on terminal failure.
- Dead-letter queue per logical queue, monitored via metrics.
- Repeatable jobs (cron-equivalent) are checked into the repo per Constitution V.

**Rationale**:
- Constitution V requires async work to live in workers. v1 needs: email send, audit-event fan-out, session revocation propagation, future webhook delivery, future POS sync.
- BullMQ is the de-facto Node queue: well-maintained, observable (Bull Board / Arena), supports retries/backoff/DLQ/parent-child flows.
- Reusing the API's NestJS DI graph keeps services like `DbModule`, `AuditService`, and `Logger` consistent across web requests and worker jobs — single source of business logic.

**Alternatives considered**:
- **Plain Node + BullMQ (no NestJS)** — simpler bootstrap; loses DI parity. Acceptable as a future serverless-worker shape if cold-start latency matters.
- **bee-queue** — older, less active.
- **Cloud-managed queues (SQS, Pub/Sub)** — lock-in; reconsider for fan-out at scale.
- **Temporal** — best for long-running, durable workflows; overkill for v1.
- **Postgres-only queues** — eliminates Redis, but Redis is already required for cache + rate limit + locks; consolidating brokers in Redis simplifies ops.

**Reversibility**: MEDIUM. Job handler interfaces are defined as plain functions over typed payloads; the broker swap is a localized refactor.

---

## T-3 — Token strategy for API and future POS clients

**Decision**: Opaque, server-validated, revocable bearer tokens. **No JWTs.**

**Token shape**:
- Server generates a cryptographically random secret (256 bits via Node `crypto.randomBytes`).
- The wire token is `<prefix>.<base64url-secret>` (the prefix encodes the scope, e.g., `dp2_dash`, `dp2_pos`, for log-grep clarity — never trusted for authorization).
- The server stores **only** a SHA-256 hash of the secret in `auth_tokens.token_hash`.
- Each token row carries: `user_id` OR `device_id`, `tenant_id`, optional `store_id`, `scope` (e.g., `dashboard_api`, `pos`), `expires_at`, `revoked_at NULL`.
- Validation: hash incoming token → lookup row → check `revoked_at IS NULL AND expires_at > now()`. Redis-cached for read latency; Postgres remains source of truth.

**Rationale**:
- Constitution IV requires per-device credentials revocable at any time (FR-POS-SEAM-2). Opaque tokens revoke instantly by writing `revoked_at`.
- JWTs would force either short lifetimes + rotation (UX hit) or a centralized revocation list (which is just opaque tokens with extra cryptographic ceremony).
- Single token model serves both dashboard API consumers and (future) POS devices — no diverging auth surface to maintain.

**Alternatives considered**:
- **JWT (HS256/RS256)** — popular, stateless. Rejected because POS device tokens MUST be killable in seconds; revocation lists or short TTLs both hurt the offline-first POS use case.
- **Per-tenant signing keys** — adds operational burden without the revocation property.
- **OAuth 2.1 / OIDC** — fine for human SSO; the device-credential flow doesn't model POS device identity well. Can be layered on later for human SSO without changing the device path.

**Reversibility**: HIGH for human users (we can swap the dashboard's cookie session for a different token shape and JWTs are unaffected). MEDIUM for POS — once devices ship with bearer tokens, a token-format swap requires a coordinated POS rollout.

---

## T-4 — Tenant isolation enforcement

**Decision**: Defense in depth across 6 layers — auth, request-scoped tenant context, role-based authz, tenant-scoped Drizzle helpers, Postgres RLS, and isolation tests.

**Mechanism**:
1. **Auth** — NestJS `AuthGuard` resolves user from session cookie or bearer token.
2. **TenantContextGuard** — Resolves the active tenant server-side from the session/token (set previously by an authenticated context-switch endpoint per Q3 default A). Stored in `AsyncLocalStorage` for the request scope.
3. **RolesGuard** — `@Roles('tenant_admin' | ...)` decorator checks the membership's role for the active tenant.
4. **Drizzle helpers** — `withTenant(tx, tenantId)` returns a query proxy that injects `WHERE tenant_id = :tenantId` for every query. Direct unscoped queries are prohibited in handler code (lint rule + code review).
5. **Postgres RLS** — every tenant-owned table has a row-level security policy keyed on `current_setting('app.current_tenant', true)::uuid`. The Drizzle session middleware issues `SET LOCAL app.current_tenant = :tenantId` at transaction start.
6. **Tests** — FR-ISO-3 mandates isolation tests on every tenant-scoped endpoint, plus the bypass case (raw SQL through the same connection).

**Rationale**:
- Constitution III is non-negotiable about backend authority and DB-layer enforcement. RLS makes "I forgot the WHERE clause" non-fatal.
- Drizzle helpers catch most bugs at code-review/lint time; RLS is the safety net.
- Tests prevent regression.

**Alternatives considered**:
- **App-only enforcement** — rejected; one missing filter = data leak.
- **Schema-per-tenant** — strong isolation but expensive in migrations, pooling, and analytics. Reconsiderable later for an enterprise tier; not v1.
- **DB-per-tenant** — strongest but operationally painful at our scale.

**Reversibility**: LOW. Once RLS policies exist, removing them is risky; adding them later requires backfill and dual-running. Doing it from day one is the cheap path.

---

## T-5 — Identifier strategy

**Decision**: UUIDv7 for all user-facing/external IDs, with UUIDv4 fallback documented. No internal BIGINT surrogate in v1.

**Implementation**:
- Use `uuid` v10+ (`uuidv7()`) or the dedicated `uuidv7` package; behind a thin adapter so swapping libraries is trivial.
- Postgres column type: `uuid`. Generation happens in the application layer (not via `gen_random_uuid()` Postgres function), which is portable across DBs and supports v7 directly.
- If, during Phase 2, the chosen UUIDv7 library shows instability, fall back to `crypto.randomUUID()` (UUIDv4) without changing column types or contracts.

**Rationale**:
- UUIDv7 is time-ordered (better B-tree insert locality than v4) without leaking monotonic/sequential identity (mitigates enumeration attacks).
- External IDs are safe to log and place in URLs.
- Avoids `bigserial` collisions when merging environments (dev/staging/prod data exports).

**Alternatives considered**:
- **UUIDv4** — random, no insert locality benefit; acceptable but slower index growth.
- **bigserial** — small, fast, but enumerable and risky to expose externally.
- **ULID / KSUID** — comparable to UUIDv7; Postgres has weaker tooling.
- **Snowflake-style** — needs a coordinator service; overkill.

**Reversibility**: MEDIUM. Internal surrogate keys can be added later if performance dictates without breaking external contracts. Switching from UUIDv7 to UUIDv4 has zero schema impact.

---

## Plan-level open questions (PQ-1..PQ-8) defaults

The plan flagged eight secondary questions. Defaults are documented inline in
[`plan.md` §9](./plan.md). Concrete numbers for PQ-4/PQ-5/PQ-6:

- **PQ-4 — Rate limits (default)**:
  - Per-account: 5 failed sign-ins / 15 minutes → lockout; exponential backoff.
  - Per-IP: 30 failed sign-ins / hour.
  - Per-IP: 100 password-reset requests / day.
  - Implementation: Redis-backed counter (e.g., `rate-limiter-flexible` or a hand-rolled BullMQ-adjacent helper).
- **PQ-5 — Session durations (default)**:
  - Dashboard session: 12h sliding, 24h absolute max.
  - API access token: 1h.
  - API refresh token: 30d.
  - Future POS device token: 90d, refreshable; revocable instantly.
- **PQ-6 — Soft-delete retention (default)**:
  - Tenant: 30 days, then platform-admin hard-delete possible (audited).
  - Store: 30 days.
  - Membership revocation: immediate; audit records the revocation but the membership row is soft-deleted with `revoked_at`.
  - User: 30 days, then anonymize-or-delete per a future privacy spec.

PQ-7 (OpenAPI source of truth) and PQ-8 (NestJS validation pipeline integration) are documented in [`plan.md` §9](./plan.md).

---

## Summary

| Unknown | Resolved? | Reversibility |
|---|---|---|
| T-1 stack | ✅ Node 20 / TS 5 / NestJS / Drizzle / pnpm (frontend deferred) | HIGH — spec untouched on swap |
| T-2 worker | ✅ BullMQ on Redis (in NestJS standalone) | MED — handler interface portable |
| T-3 token | ✅ Opaque revocable bearer (SHA-256 hashed at rest) | HIGH for users, MED for POS once shipped |
| T-4 isolation | ✅ Auth → context → roles → Drizzle helpers → RLS → tests | LOW — adding more layers later is expensive |
| T-5 IDs | ✅ UUIDv7 with v4 fallback | MED — internal surrogate possible later |
| PQ-1..PQ-8 | ✅ Defaults applied | LOW — all are config |

All Phase 0 unknowns are resolved with reversible defaults. Phase 1 (`data-model.md`, `contracts/*.yaml`, `quickstart.md`) builds on these choices.
