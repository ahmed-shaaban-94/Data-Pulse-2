# Data-Pulse-2 — Agent Context

Multi-tenant SaaS rebuild for Data Pulse. The legacy `Data-Pulse` repo is reference only — never copy without re-spec'ing here.

## Constitution

[.specify/memory/constitution.md](.specify/memory/constitution.md) (v3.0.0) is the source of truth for all 14 Core Principles. Read it when principle text matters — do not paraphrase from memory.

Always-on highlights:
- **§II Multi-tenant by default** — RLS fail-closed; cross-tenant returns safe 404; runtime DB role MUST NOT bypass RLS; workers establish tenant context before any DB access.
- **§III Backend Authority** (NON-NEGOTIABLE) — server-side authz, DB constraints, uniform error envelope, exact-decimal money, POS payload preserved as received.
- **§IV Contract-First** — `packages/contracts/openapi/` is canonical; stable `operationId`; no raw entities in responses.
- **§VIII Reproducible Releases** — **no `package.json` / `pnpm-lock.yaml` / DB schema / SQL migration / OpenAPI / CI changes without explicit approval (`[GATED]`).**
- **§XII Authorization & Object Safety** — IDs in bodies are not trusted; `tenant_id`/`store_id`/`role`/`status` are forbidden in request bodies (mass-assignment).
- **§XIV PII Discipline** — logger-boundary redaction is mandatory; soft-delete is the default; no PII in metric labels (FR-B-006).

## Active feature

**`004-platform-production-readiness`** — k6 load testing, observability instrumentation, idempotency, outbox first slice, SDK strategy. See [docs/production-readiness/004-closeout-status.md](docs/production-readiness/004-closeout-status.md) for the authoritative phase-by-phase status (this supersedes the planning-phase P9 report).

Open work in 004:
- **T483** — live `/metrics` operator scrape validation. Worker registration unblocked by PR #246; full validation blocked on emission call sites (T595/T596 + worker T460/T463–T466). See [docs/observability/operator-validation-report.md](docs/observability/operator-validation-report.md).
- **T565** — close 5 `it.todo` worker redaction stubs (`actor_label`, `payload.metadata.{email,phone,full_name}`).
- **T595/T596** — outbox + queue metric emission call sites (definitions exist; emission absent).
- **T597–T600** — P7 exit-gate validation.

## Shipped / paused specs

- **`001-foundation-auth-tenant-store`** — shipped. Auth, tenant/store/memberships, audit pipeline, idempotency interceptor (memberships/invite), outbox first slice all merged. Reference: [specs/001-foundation-auth-tenant-store/](specs/001-foundation-auth-tenant-store/).
- **`002-pos-operator-identity`** — specification + OpenAPI contracts only. POS app is a separate repo and integrates exclusively via `packages/contracts/openapi/`; never via the SaaS database. [specs/002-pos-operator-identity/](specs/002-pos-operator-identity/).
- **`003-catalog-foundation`** — specification + plan + Drizzle schema modules and schema-shape tests merged (7 catalog tables: `global-products`, `tenant-products`, `store-product-overrides`, `product-aliases`, `tenant-product-categories`, `price-history`, `unknown-items`). **No SQL migrations yet** — tables are defined in code but do not exist in any DB. Runtime, contracts, and APIs intentionally paused while 004 closes. [specs/003-catalog-foundation/](specs/003-catalog-foundation/).

## What this repo does NOT own

POS application (separate repo). This repo owns SaaS backend, admin/dashboard frontend (separate feature, deferred), workers, infrastructure.

## Stack

- **Runtime**: Node.js 20 LTS · TypeScript 5.x strict · pnpm workspaces
- **Backend**: NestJS 11 (api + worker)
- **Data**: PostgreSQL 16+ with RLS · Drizzle ORM · explicit SQL migrations · Redis 7+ · BullMQ
- **Contracts**: OpenAPI 3.1 of record · Zod for runtime validation
- **Test**: Jest + Supertest + Testcontainers · `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs
- **Observability**: pino · OpenTelemetry · Prometheus exporter (API `:9464`, worker `127.0.0.1:9091`)
- **Auth**: argon2id (`argon2` npm) · opaque revocable bearer tokens (API/POS) · httpOnly cookie sessions (dashboard humans)
- **IDs**: UUIDv7 with UUIDv4 fallback

Dashboard / web frontend is a separate future feature. OpenAPI contracts produced here are the only thing the dashboard depends on.

## Recent infrastructure notes (read if touching workspace wiring)

- **PR #245** (`fix(runtime): resolve workspace package exports to dist`) — `packages/{shared,auth,db}/package.json` now point `main` / `types` / `exports` at `dist/*.{js,d.ts}` via conditional `{ types, default }` shape. Required so `node apps/{api,worker}/dist/main.js` works at all. **Implication**: workspace packages MUST be built before they can be required at runtime (`pnpm -r build`). ts-jest still resolves correctly via the `types` condition.
- **PR #246** (`fix(worker): register worker metrics on startup`) — `apps/worker/src/main.ts` performs a side-effect import of `./observability/metrics/worker.metrics` immediately after `./instrumentation`. Without this, the worker's 10 platform signal families (signals.md §3) never register with the live OTel MeterProvider. Order is load-bearing — `./instrumentation` must remain first. Regression test: `apps/worker/test/observability/production-import-order.spec.ts`.

## Working agreement (day-to-day)

These are operating rules from the constitution's Working Agreement appendix — not Core Principles:

- Start every slice from latest `origin/main`. Pre-flight plan first; do not implement until approved.
- Thin slices. No combining unrelated work.
- Never commit / stage / push / merge / open PR without explicit instruction.
- Forbidden paths require `[GATED]` approval: `package.json`, `pnpm-lock.yaml`, DB schema, SQL migrations, `packages/contracts/openapi/**`, `.github/workflows/**`, `apps/**` source for observability-only slices, etc. (per task-specific brief).
- Use Testcontainers for RLS / cross-tenant integration tests. Use `MIGRATION_TEST_ALLOW_SKIP=1` when Docker is unavailable locally.
- Untracked `bin/` and `externals/` directories are not part of any slice — leave them alone.
- Stop conditions in a brief mean stop and report. Do not silently expand scope.
