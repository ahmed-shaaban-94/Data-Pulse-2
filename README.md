<div align="center">

# Retail Tower OS

**The command tower for modern retail. Control every branch from one secure core.**

[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-2563eb.svg?style=flat-square)](.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9.15.0-f59e0b.svg?style=flat-square)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg?style=flat-square)](tsconfig.base.json)
[![NestJS](https://img.shields.io/badge/NestJS-11-e0234e.svg?style=flat-square)](apps/api)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-85ea2d.svg?style=flat-square)](packages/contracts)
[![LOC](docs/assets/badges/loc.svg)](docs/assets/badges/loc.svg)

![Retail Tower OS — The command tower for modern retail](docs/assets/brand/exterior/retail-tower-os-exterior-hero.png)

</div>

> **Retail Tower OS** is the external product identity for this platform. The implementation repository is `Data-Pulse-2` — the backend-first codename. No repository names, package names, OpenAPI titles, or deployment configuration have been changed.
>
> The image above represents **product vision**. It does not imply that a dashboard frontend, POS application, or production operations UI is implemented in this repository. The POS application is a separate repository that integrates through the OpenAPI contracts in `packages/contracts/openapi/`.

See [`docs/brand/retail-tower-os.md`](docs/brand/retail-tower-os.md) for the full brand identity record, approved imagery, scope notes, and usage guidelines.

---

## What Retail Tower OS controls

The platform that stands behind every branch — multi-tenant architecture, catalog authority, POS connectivity, access control, and audit provenance unified under one secure operating core.

<table>
<tr>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/branch-ops.svg" width="56" alt=""/><br/>
  <strong>Branch operations</strong><br/>
  <sub>Multi-tenant isolation and store hierarchy managed from a single command core.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/catalog.svg" width="56" alt=""/><br/>
  <strong>Catalog authority</strong><br/>
  <sub>Global product index propagated through tenant and store layers with store-level override.</sub>
</td>
<td width="33%" align="center" valign="top">
  <img src="docs/assets/brand/icons/store-network.svg" width="56" alt=""/><br/>
  <strong>Store network</strong><br/>
  <sub>Connected branch context carried at every API, database, and job boundary.</sub>
</td>
</tr>
<tr>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/access-control.svg" width="56" alt=""/><br/>
  <strong>Access control</strong><br/>
  <sub>Role-based identity for operators and staff, scoped to tenant and store.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/integrations.svg" width="56" alt=""/><br/>
  <strong>POS connectivity</strong><br/>
  <sub>The API gateway POS applications connect to through authenticated, versioned contracts.</sub>
</td>
<td align="center" valign="top">
  <img src="docs/assets/brand/icons/audit-compliance.svg" width="56" alt=""/><br/>
  <strong>Audit provenance</strong><br/>
  <sub>Every mutation is traceable; sale facts are immutable once committed.</sub>
</td>
</tr>
<tr>
<td colspan="3" align="center" valign="top">
  <img src="docs/assets/brand/icons/security.svg" width="56" alt=""/><br/>
  <strong>Secure core</strong><br/>
  <sub>Multi-layer security — tenant RLS, token auth, and audit trail — built in from the start.</sub>
</td>
</tr>
</table>

> This table describes **platform scope and product vision**, not a list of implemented UI features. The POS application is a separate repository. Dashboard UI is a separate future feature.

---

## Architecture at a glance

![Retail Tower OS animated system map](docs/assets/architecture/retail-tower-os-system-map.svg)

Retail Tower OS is implemented here as the `Data-Pulse-2` backend platform: a NestJS API, BullMQ worker runtime, OpenAPI contracts, PostgreSQL source of truth, Redis coordination, and shared platform packages. The diagram above renders animated data tokens travelling each authenticated path — clients to gateway, gateway to system of record, gateway to queue, queue to async runtime.

See [Architecture](docs/ARCHITECTURE.md) for request flow, tenant boundaries, worker flow, and catalog source-of-truth layers.

---

## Request pipeline

Every authenticated call travels the same guard chain. The animated token below traces one request from ingress to response envelope.

<div align="center">
<img src="docs/assets/architecture/retail-tower-os-request-flow.svg" width="560" alt="Retail Tower OS animated API request flow"/>
</div>

| Step | Guard / stage | Purpose |
| :--: | --- | --- |
| **1** | Ingress | Assign request id · helmet · cookies · body parse |
| **2** | Validation | Zod body validation · uniform error envelope |
| **3** | `AuthGuard` | Session token or bearer · constant-time compare |
| **4** | `TenantContextGuard` | Resolve tenant + store · cross-tenant access → safe 404 |
| **5** | `RolesGuard` | Role · permission · default deny |
| **6** | Service layer | Business logic · tenant-scoped DB access · RLS-enforced |
| **7** | Audit log | Actor · tenant · store · op · outcome · correlationId |
| **8** | Response | Uniform envelope · includes request id |

---

## Platform guarantees

Retail data systems become expensive when tenant boundaries, store ownership, audit trails, and POS integration contracts are treated as afterthoughts. This platform makes those rules explicit from the start.

| Guarantee | What it enforces |
| --- | --- |
| <img src="docs/assets/icons/tenant-isolation.svg" width="32" alt=""> **Tenant isolation** | Tenant and store context are first-class at the API, database, and test layers. |
| <img src="docs/assets/icons/contracts.svg" width="32" alt=""> **Contract-first APIs** | OpenAPI 3.1 contracts are the integration source of truth, not generated side effects. |
| <img src="docs/assets/icons/audit.svg" width="32" alt=""> **Auditability** | Security-sensitive workflows preserve actor, tenant, operation, outcome, and correlation context. |
| <img src="docs/assets/icons/worker.svg" width="32" alt=""> **Worker-owned async jobs** | Email, fanout, retries, and future scheduled work live outside request handlers. |
| <img src="docs/assets/icons/observability.svg" width="32" alt=""> **Operational visibility** | Request IDs, structured logging, and OpenTelemetry primitives are built into the platform layer. |
| <img src="docs/assets/icons/database.svg" width="32" alt=""> **Durable source of truth** | PostgreSQL remains authoritative; Redis-backed state is disposable coordination. |

---

## Platform shape

`Data-Pulse-2` is a pnpm workspace with two deployable services and four internal packages. The API owns synchronous HTTP behavior; the worker owns asynchronous processing; PostgreSQL owns durable state; Redis coordinates queues.

```mermaid
flowchart LR
  clients["Dashboard / API clients<br/>future consumers"]
  pos["POS clients<br/>external repo"]
  api["apps/api<br/>NestJS HTTP API"]
  worker["apps/worker<br/>NestJS worker"]
  contracts["packages/contracts<br/>OpenAPI 3.1"]
  auth["packages/auth<br/>passwords and tokens"]
  db["packages/db<br/>schema and migrations"]
  shared["packages/shared<br/>errors, logs, ids, queues"]
  pg[("PostgreSQL 16<br/>system of record")]
  redis[("Redis 7<br/>BullMQ coordination")]

  clients --> api
  pos -. authenticated contracts .-> api
  api --> contracts
  api --> auth
  api --> db
  api --> shared
  api --> pg
  api -- enqueue jobs --> redis
  worker -- consume jobs --> redis
  worker --> shared
```

---

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/api` | NestJS HTTP API · auth · active context · validation · request IDs · logging · exception envelopes · OpenAPI loading |
| `apps/worker` | Standalone NestJS worker runtime for BullMQ-backed background processing |
| `packages/auth` | Password hashing · token hashing · session types · auth primitives |
| `packages/contracts` | OpenAPI 3.1 YAML contracts of record |
| `packages/db` | Drizzle schema · explicit SQL migrations · tenant helpers · migration CLI |
| `packages/shared` | Shared Zod helpers · error envelopes · logging · observability · IDs · queue config |
| `specs/001-foundation-auth-tenant-store` | Foundation feature artifacts (shipped) |
| `specs/002-pos-operator-identity` | POS operator identity specification and contracts (POS app lives in a separate repo) |
| `specs/003-catalog-foundation` | Catalog foundation feature (shipped) |
| `specs/004-platform-production-readiness` | Active feature — observability, idempotency, outbox, k6 load testing, SDK strategy |
| `docs` | Architecture · documentation index · brand · agent-os · presentation assets |

### What this repo owns
Multi-tenant SaaS backend foundation · admin/dashboard backend APIs and shared contracts · worker runtime and queue integration patterns · PostgreSQL schema, migrations, and tenant helpers · shared platform primitives for auth, observability, validation, and errors.

### What this repo does **not** own
POS application code · dashboard frontend implementation · production infrastructure manifests beyond local development support · legacy `Data-Pulse` code as source material (reference only, must be re-specified).

---

## Tech stack

| Layer | Stack |
| --- | --- |
| Runtime | Node.js 20 LTS · pnpm 9.15 · TypeScript 5 strict mode |
| API | NestJS 11 · Express platform · Helmet · cookie-parser · Zod validation |
| Data | PostgreSQL 16 · Drizzle schema · explicit SQL migrations |
| Jobs | Redis 7 · BullMQ |
| Observability | pino · OpenTelemetry SDK · HTTP/Postgres/Redis instrumentation · Prometheus exporter |
| Auth | argon2id · opaque revocable bearer tokens · httpOnly cookie sessions |
| Testing | Jest · ts-jest · Supertest · Testcontainers PostgreSQL |
| IDs | UUIDv7 with UUIDv4 fallback |

---

## Getting started

**Prerequisites.** Node.js 20+ · pnpm 9.15.0+ · Docker Desktop (or another Docker-compatible runtime) for local PostgreSQL and Redis.

```bash
pnpm install            # install dependencies
pnpm db:up              # bring local Postgres + Redis up
pnpm build              # build all packages
pnpm test               # run the test suite
pnpm lint               # eslint + prettier --check
```

The development compose stack exposes:

- PostgreSQL: `postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2`
- Redis: `redis://localhost:6379`

For local API and worker runs, set:

```bash
DATABASE_URL=postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2
REDIS_URL=redis://localhost:6379
```

Then start the services:

```bash
pnpm --filter @data-pulse-2/api start
pnpm --filter @data-pulse-2/worker start
```

During development, package-level `start:dev` scripts compile in watch mode where available.

**Verify startup.** After starting the API, check the terminal output for a pino log line confirming the server is listening (default port `3000`). No unauthenticated health endpoint is exposed — a clean startup log is the expected signal. For a full behavior walkthrough, see the [foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md).

---

## Documentation

The [documentation index](docs/README.md) is the main hub, with audience-based navigation for product, engineering, security, and integration reviewers.

| Audience | First reads |
| --- | --- |
| **Product & brand** | [Brand identity](docs/brand/retail-tower-os.md) · [Icon system](docs/brand/icon-system.md) |
| **Engineering** | [Architecture](docs/ARCHITECTURE.md) · [Foundation quickstart](specs/001-foundation-auth-tenant-store/quickstart.md) · [Contributing](CONTRIBUTING.md) |
| **Security** | [Security policy](SECURITY.md) · [Constitution](.specify/memory/constitution.md) |
| **Integration** | [Contracts package](packages/contracts/README.md) · [POS operator identity spec](specs/002-pos-operator-identity/spec.md) |
| **Operations** | [Observability signals](docs/observability/signals.md) · [Outbox lifecycle](docs/outbox/lifecycle.md) · [Idempotency strategy](docs/idempotency/strategy.md) |

---

## Development agreement

This platform follows the active Constitution and Spec Kit workflow. Start from the current spec, keep changes thin, preserve tenant isolation, and do not change dependency manifests, lockfiles, SQL migrations, or database schema without explicit approval.

---

## License

MIT. See [LICENSE](LICENSE).
