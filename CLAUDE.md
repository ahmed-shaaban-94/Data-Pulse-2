# Data-Pulse-2 — Agent Context

This is the multi-tenant SaaS rebuild for Data Pulse. The legacy
`Data-Pulse` repository is reference material only — never copy from it
without re-spec'ing here.

## Active artifacts

- **Constitution**: [.specify/memory/constitution.md](.specify/memory/constitution.md) (v2.0.0)
- **Active feature**: `001-foundation-auth-tenant-store`
  - Spec: [specs/001-foundation-auth-tenant-store/spec.md](specs/001-foundation-auth-tenant-store/spec.md)
  - <!-- SPECKIT START -->
  - Plan: [specs/001-foundation-auth-tenant-store/plan.md](specs/001-foundation-auth-tenant-store/plan.md)
  - Research: [specs/001-foundation-auth-tenant-store/research.md](specs/001-foundation-auth-tenant-store/research.md)
  - Data model: [specs/001-foundation-auth-tenant-store/data-model.md](specs/001-foundation-auth-tenant-store/data-model.md)
  - Contracts: [specs/001-foundation-auth-tenant-store/contracts/](specs/001-foundation-auth-tenant-store/contracts/)
  - Quickstart: [specs/001-foundation-auth-tenant-store/quickstart.md](specs/001-foundation-auth-tenant-store/quickstart.md)
  - <!-- SPECKIT END -->

## Constitution at a glance (v2.0.0)

1. **Reference, Not Source of Truth** — legacy repo is reference only.
2. **Multi-Tenant SaaS by Default** — tenant scoping at DB+API+test layers.
3. **Backend Authority & Data Integrity** (NON-NEGOTIABLE) — server-side authz,
   DB constraints, cache is never the source of truth.
4. **Contract-First POS Integration** — versioned, authenticated, idempotent
   APIs; POS app lives in a separate repo.
5. **Async Work Belongs in Workers** — webhooks, sync, retries, scheduled jobs.
6. **Test-First Quality** — write tests first; ≥80% coverage; cross-tenant
   isolation tests required.
7. **Observable Systems** — structured logs with `tenant_id`/`request_id`,
   metrics, no secrets in logs.
8. **Reproducible & Versioned Releases** — pinned envs, numbered migrations,
   versioned APIs.

## What this repo does NOT own

The POS application is a separate repository. This repo owns SaaS backend,
admin/dashboard frontend (UI is its own feature), workers, and infrastructure.

## Stack defaults (per current plan)

**TypeScript-first** (backend only in this feature). Node.js 20 LTS · TypeScript 5.x (strict) · NestJS 10+ (api + worker) · Drizzle ORM with explicit SQL migrations · PostgreSQL 16+ · Redis 7+ · BullMQ · pnpm workspaces · Zod (validation) · OpenAPI 3.1 (contracts of record) · Jest + Supertest + Testcontainers · pino + OpenTelemetry · argon2id (`argon2` npm) · opaque revocable bearer tokens for API/POS, httpOnly cookie sessions for dashboard humans · UUIDv7 (UUIDv4 fallback).

**Dashboard / web frontend is deferred to a separate feature** and is not chosen or scaffolded by this foundation feature. The OpenAPI contracts produced here are the only guarantee the dashboard needs. Defaults are revisable via `/speckit-clarify`.
