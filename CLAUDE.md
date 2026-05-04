# Data-Pulse-2 — Agent Context

This is the multi-tenant SaaS rebuild for Data Pulse. The legacy
`Data-Pulse` repository is reference material only — never copy from it
without re-spec'ing here.

## Active artifacts

- **Constitution**: [.specify/memory/constitution.md](.specify/memory/constitution.md) (v3.0.0)
- **Active feature**: `001-foundation-auth-tenant-store`
  - Spec: [specs/001-foundation-auth-tenant-store/spec.md](specs/001-foundation-auth-tenant-store/spec.md)
  - <!-- SPECKIT START -->
  - Plan: [specs/001-foundation-auth-tenant-store/plan.md](specs/001-foundation-auth-tenant-store/plan.md)
  - Research: [specs/001-foundation-auth-tenant-store/research.md](specs/001-foundation-auth-tenant-store/research.md)
  - Data model: [specs/001-foundation-auth-tenant-store/data-model.md](specs/001-foundation-auth-tenant-store/data-model.md)
  - Contracts: [specs/001-foundation-auth-tenant-store/contracts/](specs/001-foundation-auth-tenant-store/contracts/)
  - Quickstart: [specs/001-foundation-auth-tenant-store/quickstart.md](specs/001-foundation-auth-tenant-store/quickstart.md)
  - <!-- SPECKIT END -->

## Constitution at a glance (v3.0.0)

1. **Reference, Not Source of Truth** — legacy repo is reference only.
2. **Multi-Tenant SaaS by Default** — tenant scoping at DB+API+test layers;
   RLS fail-closed; cross-tenant access returns safe 404; workers establish
   tenant context; runtime DB role MUST NOT bypass RLS.
3. **Backend Authority & Data Integrity** (NON-NEGOTIABLE) — server-side authz,
   DB constraints, cache is never source of truth, uniform error envelope,
   money is exact-decimal + currency-coded, POS totals preserved as received.
4. **Contract-First POS Integration** — `packages/contracts/openapi/` is the
   source of truth; stable `operationId`; responses MUST NOT return raw DB
   entities; versioned, authenticated, idempotent APIs; POS app is a separate
   repo.
5. **Async Work Belongs in Workers** — webhooks, sync, retries, scheduled jobs;
   jobs carry `tenantId` / `storeId` / `correlationId`; workers establish
   tenant context before DB access; failed-job logs redacted.
6. **Test-First Quality** — write tests first; ≥80% coverage; cross-tenant +
   cross-store sweep tests required; RLS bypass probe; malicious-override
   tests; Testcontainers for tenant isolation.
7. **Observable Systems** — structured logs with `request_id` / `tenant_id`,
   metrics including queue lag / RLS context failures / duplicate event rate /
   reconciliation mismatch rate; no secrets / tokens / PII / payloads in logs.
8. **Reproducible & Versioned Releases** — pinned envs, numbered migrations,
   versioned APIs; **no `package.json` / `pnpm-lock.yaml` / DB schema / SQL
   migration changes without explicit approval**.
9. **Source-of-Truth Model** — Global Catalog = reference; Tenant Catalog =
   customer truth; Store Override = branch truth; SaleLine snapshot = invoice
   truth; POS payload provenance preserved.
10. **Retail Temporal Semantics** — distinguish `occurredAt` / `receivedAt` /
    `processedAt` / `businessDate` / `sourceClockAt` / `voidedAt` / `refundedAt`;
    historical sale facts MUST NOT be silently rewritten by catalog changes;
    storage UTC; security clocks are server clocks.
11. **Idempotency & External IDs** — retryable mutating APIs are idempotent or
    justified; POS ingestion uses `sourceSystem` + `externalId`; workers and
    notification jobs are idempotent.
12. **Authorization & Object Safety** — IDs in bodies are not trusted; mass-
    assignment forbidden (`tenant_id`, `store_id`, `role`, `status`,
    `acceptedAt`, `createdBy`, etc.); strict body validation; safe 404 for
    cross-tenant; default deny.
13. **Auditability & Provenance** — auditable events carry actor / tenant /
    store / operation / target / timestamp / `correlationId` / outcome;
    anonymous-actor pattern; insert-only at the application layer; ingestion
    provenance preserved.
14. **PII & Data Lifecycle Discipline** — data classification (PII / payment /
    business / public); explicit retention windows; right-to-erasure as a
    first-class flow respecting audit immutability; logger-boundary redaction
    is mandatory; soft-delete is the default.

> Day-to-day agent + human operating rules (start from `origin/main`, thin
> slices, pre-flight plan, no-commit-until-told) are part of the **Working
> Agreement** appendix in the constitution and live here / in CONTRIBUTING.md.
> They are not Core Principles.

## What this repo does NOT own

The POS application is a separate repository. This repo owns SaaS backend,
admin/dashboard frontend (UI is its own feature), workers, and infrastructure.

## Stack defaults (per current plan)

**TypeScript-first** (backend only in this feature). Node.js 20 LTS · TypeScript 5.x (strict) · NestJS 10+ (api + worker) · Drizzle ORM with explicit SQL migrations · PostgreSQL 16+ · Redis 7+ · BullMQ · pnpm workspaces · Zod (validation) · OpenAPI 3.1 (contracts of record) · Jest + Supertest + Testcontainers · pino + OpenTelemetry · argon2id (`argon2` npm) · opaque revocable bearer tokens for API/POS, httpOnly cookie sessions for dashboard humans · UUIDv7 (UUIDv4 fallback).

**Dashboard / web frontend is deferred to a separate feature** and is not chosen or scaffolded by this foundation feature. The OpenAPI contracts produced here are the only guarantee the dashboard needs. Defaults are revisable via `/speckit-clarify`.
